import { resolveKiroModel } from "./models.js"
import type {
  KiroHistoryEntry,
  KiroImage,
  KiroRequest,
  KiroToolResult,
  KiroToolSpec,
  OpenAIChatMessage,
  OpenAIChatRequest,
} from "./types.js"

type ContentPart = {
  type?: string
  text?: string
  image_url?: { url?: string }
  image?: string
  source?: { data?: string; bytes?: string }
  data?: string
}

const TOOL_RESULT_LIMIT = 250_000

function sanitizeSurrogates(text: string): string {
  return text.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "")
}

function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text
  const half = Math.floor(limit / 2)
  return `${text.slice(0, half)}\n... [TRUNCATED] ...\n${text.slice(text.length - half)}`
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content
    .map((item) => {
      if (!item || typeof item !== "object") return ""
      const part = item as ContentPart
      if (part.type === "text" || part.type === "input_text") return part.text ?? ""
      return ""
    })
    .join("")
}

function imagesFromContent(content: unknown): KiroImage[] | undefined {
  if (!Array.isArray(content)) return undefined
  const images = content.flatMap((item) => {
    if (!item || typeof item !== "object") return []
    const part = item as ContentPart
    const url = part.image_url?.url ?? part.image ?? ""
    const match = url.match(/^data:(.+?);base64,(.+)$/)
    const rawBase64 = part.source?.bytes ?? part.source?.data ?? part.data
    const mimeType = match?.[1] ?? "image/png"
    const base64 = match?.[2] ?? rawBase64 ?? ""
    if (!base64) return []
    return [{ format: mimeType.split("/")[1] ?? "png", source: { bytes: base64 } }]
  })
  return images.length > 0 ? images : undefined
}

function convertTools(tools: OpenAIChatRequest["tools"]): KiroToolSpec[] | undefined {
  if (!tools || tools.length === 0) return undefined
  return tools.map((tool) => ({
    toolSpecification: {
      name: tool.function.name,
      description: tool.function.description ?? "",
      inputSchema: { json: tool.function.parameters ?? { type: "object", properties: {} } },
    },
  }))
}

function assistantEntry(message: OpenAIChatMessage): KiroHistoryEntry | undefined {
  const toolUses = (message.tool_calls ?? []).map((call) => ({
    name: call.function.name,
    toolUseId: call.id,
    input: JSON.parse(call.function.arguments || "{}") as Record<string, unknown>,
  }))
  const content = sanitizeSurrogates(textFromContent(message.content))
  if (!content && toolUses.length === 0) return undefined
  return {
    assistantResponseMessage: {
      content,
      ...(toolUses.length > 0 ? { toolUses } : {}),
    },
  }
}

function userEntry(message: OpenAIChatMessage, modelId: string, tools?: KiroToolSpec[]): KiroHistoryEntry {
  const images = imagesFromContent(message.content)
  return {
    userInputMessage: {
      content: sanitizeSurrogates(textFromContent(message.content)),
      modelId,
      origin: "KIRO_CLI",
      ...(images ? { images } : {}),
      ...(tools && tools.length > 0 ? { userInputMessageContext: { tools } } : {}),
    },
  }
}

function toolResultEntry(message: OpenAIChatMessage, modelId: string): KiroHistoryEntry {
  const result: KiroToolResult = {
    content: [{ text: truncate(sanitizeSurrogates(textFromContent(message.content)), TOOL_RESULT_LIMIT) }],
    status: message.role === "tool" ? "success" : "error",
    toolUseId: message.tool_call_id ?? "tool-call",
  }
  return {
    userInputMessage: {
      content: "Tool results provided.",
      modelId,
      origin: "KIRO_CLI",
      userInputMessageContext: { toolResults: [result] },
    },
  }
}

function isToolResultMessage(message: OpenAIChatMessage): boolean {
  return message.role === "tool" && typeof message.tool_call_id === "string"
}

function mergeHistoryEntries(entries: KiroHistoryEntry[]): KiroHistoryEntry[] {
  const merged: KiroHistoryEntry[] = []
  for (const entry of entries) {
    const previous = merged[merged.length - 1]

    if (entry.userInputMessage && previous?.userInputMessage) {
      previous.userInputMessage.content += `\n\n${entry.userInputMessage.content}`
      if (entry.userInputMessage.images) {
        previous.userInputMessage.images = [...(previous.userInputMessage.images ?? []), ...entry.userInputMessage.images]
      }
      if (entry.userInputMessage.userInputMessageContext?.toolResults) {
        previous.userInputMessage.userInputMessageContext = previous.userInputMessage.userInputMessageContext ?? {}
        previous.userInputMessage.userInputMessageContext.toolResults = [
          ...(previous.userInputMessage.userInputMessageContext.toolResults ?? []),
          ...entry.userInputMessage.userInputMessageContext.toolResults,
        ]
      }
      continue
    }

    if (entry.assistantResponseMessage && previous?.assistantResponseMessage) {
      if (entry.assistantResponseMessage.content) {
        previous.assistantResponseMessage.content += `${previous.assistantResponseMessage.content ? "\n\n" : ""}${entry.assistantResponseMessage.content}`
      }
      if (entry.assistantResponseMessage.toolUses) {
        previous.assistantResponseMessage.toolUses = [
          ...(previous.assistantResponseMessage.toolUses ?? []),
          ...entry.assistantResponseMessage.toolUses,
        ]
      }
      continue
    }

    merged.push(entry)
  }
  return merged
}

export function buildKiroRequest(body: OpenAIChatRequest, conversationId: string, profileArn?: string): KiroRequest {
  const modelId = resolveKiroModel(body.model)
  const tools = convertTools(body.tools)
  const historyMessages = body.messages.slice(0, -1)
  const current = body.messages[body.messages.length - 1]
  const systemPrompt = body.messages
    .filter((message) => message.role === "system")
    .map((message) => sanitizeSurrogates(textFromContent(message.content)))
    .filter(Boolean)
    .join("\n\n")

  const history = mergeHistoryEntries(
    historyMessages.flatMap((message) => {
      if (message.role === "system") return []
      if (message.role === "assistant") {
        const entry = assistantEntry(message)
        return entry ? [entry] : []
      }
      if (message.role === "tool") return [toolResultEntry(message, modelId)]
      if (message.role === "user") return [userEntry(message, modelId)]
      return []
    }),
  )

  if (systemPrompt && history[0]?.userInputMessage) {
    history[0].userInputMessage.content = `${systemPrompt}\n\n${history[0].userInputMessage.content}`
  }

  if (current && isToolResultMessage(current)) {
    const currentEntry = toolResultEntry(current, modelId)
    const currentMessage = currentEntry.userInputMessage
    if (!currentMessage) {
      throw new Error("Tool result message could not be converted into a Kiro userInputMessage")
    }
    if (history.length === 0 && systemPrompt) {
      currentMessage.content = `${systemPrompt}\n\n${currentMessage.content}`
    }
    return {
      conversationState: {
        chatTriggerType: "MANUAL",
        agentTaskType: "vibe",
        conversationId,
        currentMessage: { userInputMessage: currentMessage },
        ...(history.length > 0 ? { history } : {}),
      },
      ...(profileArn ? { profileArn } : {}),
    }
  }

  const currentText = sanitizeSurrogates(current ? textFromContent(current.content) : "")
  const currentImages = current ? imagesFromContent(current.content) : undefined
  const reasoningBudget =
    body.reasoning_effort === "max"
      ? 50_000
      : body.reasoning_effort === "xhigh"
      ? 50_000
      : body.reasoning_effort === "high"
        ? 30_000
        : body.reasoning_effort === "medium"
          ? 20_000
          : body.reasoning_effort === "low"
            ? 10_000
            : 0
  const thinkingPrefix = reasoningBudget > 0 ? `<thinking_mode>enabled</thinking_mode><max_thinking_length>${reasoningBudget}</max_thinking_length>` : ""
  const currentContent = [thinkingPrefix, history.length === 0 ? systemPrompt : "", currentText].filter(Boolean).join("\n\n")

  return {
    conversationState: {
      chatTriggerType: "MANUAL",
      agentTaskType: "vibe",
      conversationId,
      currentMessage: {
        userInputMessage: {
          content: currentContent,
          modelId,
          origin: "KIRO_CLI",
          ...(currentImages ? { images: currentImages } : {}),
          ...(tools && tools.length > 0 ? { userInputMessageContext: { tools } } : {}),
        },
      },
      ...(history.length > 0 ? { history } : {}),
    },
    ...(profileArn ? { profileArn } : {}),
  }
}
