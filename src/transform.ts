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
  const converted = tools.flatMap((tool) => {
    const name = tool.function?.name ?? tool.name
    if (!name) return []
    return [
      {
        toolSpecification: {
          name,
          description: tool.function?.description ?? tool.description ?? "",
          inputSchema: { json: tool.function?.parameters ?? tool.parameters ?? { type: "object", properties: {} } },
        },
      },
    ]
  })
  return converted.length > 0 ? converted : undefined
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

function hasAssistantToolCalls(message: OpenAIChatMessage): boolean {
  return message.role === "assistant" && Array.isArray(message.tool_calls) && message.tool_calls.length > 0
}

function findCurrentMessageStartIndex(messages: OpenAIChatMessage[]): number {
  let start = messages.length - 1
  while (start > 0 && isToolResultMessage(messages[start])) start--
  if (start >= 0 && messages[start].role === "assistant" && !hasAssistantToolCalls(messages[start])) start++
  return Math.max(0, start)
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

function stripHistoryImages(history: KiroHistoryEntry[]): KiroHistoryEntry[] {
  return history.map((entry) => {
    if (!entry.userInputMessage?.images) return entry
    const { images: _images, ...userInputMessage } = entry.userInputMessage
    return { ...entry, userInputMessage }
  })
}

function sanitizeHistory(history: KiroHistoryEntry[]): KiroHistoryEntry[] {
  while (
    history.length > 0 &&
    (!history[0]?.userInputMessage || history[0].userInputMessage.userInputMessageContext?.toolResults)
  ) {
    history = history.slice(1)
  }

  const result: KiroHistoryEntry[] = []
  for (let i = 0; i < history.length; i++) {
    const entry = history[i]
    if (!entry) continue

    if (entry.assistantResponseMessage && !entry.assistantResponseMessage.toolUses && !entry.assistantResponseMessage.content) {
      continue
    }

    if (entry.assistantResponseMessage?.toolUses) {
      const next = history[i + 1]
      if (next?.userInputMessage?.userInputMessageContext?.toolResults) result.push(entry)
      continue
    }

    if (entry.userInputMessage?.userInputMessageContext?.toolResults) {
      const previous = result[result.length - 1]
      if (previous?.assistantResponseMessage?.toolUses) result.push(entry)
      continue
    }

    result.push(entry)
  }

  return result
}

function extractToolNamesFromHistory(history: KiroHistoryEntry[]): Set<string> {
  const names = new Set<string>()
  for (const entry of history) {
    for (const toolUse of entry.assistantResponseMessage?.toolUses ?? []) {
      if (toolUse.name) names.add(toolUse.name)
    }
  }
  return names
}

function addPlaceholderTools(tools: KiroToolSpec[] | undefined, history: KiroHistoryEntry[]): KiroToolSpec[] | undefined {
  const historyToolNames = extractToolNamesFromHistory(history)
  if (historyToolNames.size === 0) return tools

  const existingTools = new Set((tools ?? []).map((tool) => tool.toolSpecification.name).filter(Boolean))
  const missing = Array.from(historyToolNames).filter((name) => !existingTools.has(name))
  if (missing.length === 0) return tools

  return [
    ...(tools ?? []),
    ...missing.map((name) => ({
      toolSpecification: {
        name,
        description: "Tool",
        inputSchema: { json: { type: "object", properties: {} } },
      },
    })),
  ]
}

function collectToolResults(messages: OpenAIChatMessage[]): KiroToolResult[] {
  return messages.filter(isToolResultMessage).map((message) => ({
    content: [{ text: truncate(sanitizeSurrogates(textFromContent(message.content)), TOOL_RESULT_LIMIT) }],
    status: "success",
    toolUseId: message.tool_call_id ?? "tool-call",
  }))
}

function appendAssistantHistory(history: KiroHistoryEntry[], message: OpenAIChatMessage): void {
  const entry = assistantEntry(message)
  if (!entry?.assistantResponseMessage) return

  const previous = history[history.length - 1]
  if (previous?.assistantResponseMessage) {
    previous.assistantResponseMessage.content += `${previous.assistantResponseMessage.content && entry.assistantResponseMessage.content ? "\n\n" : ""}${entry.assistantResponseMessage.content}`
    if (entry.assistantResponseMessage.toolUses) {
      previous.assistantResponseMessage.toolUses = [
        ...(previous.assistantResponseMessage.toolUses ?? []),
        ...entry.assistantResponseMessage.toolUses,
      ]
    }
    return
  }

  history.push(entry)
}

export function buildKiroRequest(body: OpenAIChatRequest, conversationId: string, profileArn?: string): KiroRequest {
  const modelId = resolveKiroModel(body.model)
  const currentStartIndex = findCurrentMessageStartIndex(body.messages)
  const historyMessages = body.messages.slice(0, currentStartIndex)
  const currentMessages = body.messages.slice(currentStartIndex)
  const firstCurrentMessage = currentMessages[0]
  const systemPrompt = body.messages
    .filter((message) => message.role === "system")
    .map((message) => sanitizeSurrogates(textFromContent(message.content)))
    .filter(Boolean)
    .join("\n\n")
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
  const effectiveSystemPrompt = [thinkingPrefix, systemPrompt].filter(Boolean).join("\n")

  let history = mergeHistoryEntries(
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

  let systemPrepended = false
  if (effectiveSystemPrompt && history[0]?.userInputMessage) {
    history[0].userInputMessage.content = `${effectiveSystemPrompt}\n\n${history[0].userInputMessage.content}`
    systemPrepended = true
  }

  history = sanitizeHistory(stripHistoryImages(history))

  let currentContent = ""
  let currentImages = firstCurrentMessage ? imagesFromContent(firstCurrentMessage.content) : undefined
  const currentToolResults = collectToolResults(currentMessages)

  if (firstCurrentMessage && hasAssistantToolCalls(firstCurrentMessage)) {
    appendAssistantHistory(history, firstCurrentMessage)
    currentContent = currentToolResults.length > 0 ? "Tool results provided." : "Please proceed with the task."
  } else if (firstCurrentMessage && isToolResultMessage(firstCurrentMessage)) {
    currentContent = "Tool results provided."
  } else {
    const currentText = sanitizeSurrogates(firstCurrentMessage ? textFromContent(firstCurrentMessage.content) : "")
    currentContent = [systemPrepended ? "" : effectiveSystemPrompt, currentText].filter(Boolean).join("\n\n")
  }

  const tools = addPlaceholderTools(convertTools(body.tools), history)
  const userInputMessageContext =
    currentToolResults.length > 0 || (tools && tools.length > 0)
      ? {
          ...(currentToolResults.length > 0 ? { toolResults: currentToolResults } : {}),
          ...(tools && tools.length > 0 ? { tools } : {}),
        }
      : undefined

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
          ...(userInputMessageContext ? { userInputMessageContext } : {}),
        },
      },
      ...(history.length > 0 ? { history } : {}),
    },
    ...(profileArn ? { profileArn } : {}),
    agentMode: "vibe",
  }
}
