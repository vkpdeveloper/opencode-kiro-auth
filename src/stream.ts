import { getBaseUrl } from "./models.js"
import { buildKiroRequest } from "./transform.js"
import type { KiroCredentials, KiroEvent, OpenAIChatMessage, OpenAIChatRequest, OpenAIResponseInputItem, OpenAIResponsesRequest } from "./types.js"

const CHAT_COMPLETIONS_PATH = "/chat/completions"
const RESPONSES_PATH = "/responses"
const EVENT_PATTERNS = [
  '{"content":',
  '{"name":',
  '{"input":',
  '{"stop":',
  '{"contextUsagePercentage":',
  '{"usage":',
  '{"error":',
  '{"Error":',
] as const

function findJsonEnd(text: string, start: number): number {
  let braceCount = 0
  let inString = false
  let escapeNext = false
  for (let i = start; i < text.length; i++) {
    const char = text[i]
    if (escapeNext) {
      escapeNext = false
      continue
    }
    if (char === "\\") {
      escapeNext = true
      continue
    }
    if (char === '"') {
      inString = !inString
      continue
    }
    if (!inString) {
      if (char === "{") braceCount++
      else if (char === "}") {
        braceCount--
        if (braceCount === 0) return i
      }
    }
  }
  return -1
}

function parseEvent(parsed: Record<string, unknown>): KiroEvent | undefined {
  if (typeof parsed.content === "string") return { type: "content", data: parsed.content }
  if (typeof parsed.name === "string" && typeof parsed.toolUseId === "string") {
    const input =
      typeof parsed.input === "string"
        ? parsed.input
        : parsed.input && typeof parsed.input === "object"
          ? JSON.stringify(parsed.input)
          : ""
    return { type: "toolUse", data: { name: parsed.name, toolUseId: parsed.toolUseId, input, stop: parsed.stop === true } }
  }
  if (parsed.input !== undefined && typeof parsed.name !== "string") {
    return { type: "toolUseInput", data: { input: typeof parsed.input === "string" ? parsed.input : JSON.stringify(parsed.input) } }
  }
  if (parsed.stop !== undefined && parsed.contextUsagePercentage === undefined) {
    return { type: "toolUseStop", data: { stop: parsed.stop === true } }
  }
  if (typeof parsed.contextUsagePercentage === "number") {
    return { type: "contextUsage", data: { contextUsagePercentage: parsed.contextUsagePercentage } }
  }
  if (parsed.usage && typeof parsed.usage === "object") {
    const usage = parsed.usage as { inputTokens?: number; outputTokens?: number }
    return { type: "usage", data: { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens } }
  }
  if (parsed.error !== undefined || parsed.Error !== undefined) {
    const error = typeof parsed.error === "string" ? parsed.error : typeof parsed.Error === "string" ? parsed.Error : "unknown"
    const message = typeof parsed.message === "string" ? parsed.message : typeof parsed.Message === "string" ? parsed.Message : undefined
    return { type: "error", data: { error, message } }
  }
  return undefined
}

function parseKiroEvents(buffer: string): { events: KiroEvent[]; remaining: string } {
  const events: KiroEvent[] = []
  let position = 0
  while (position < buffer.length) {
    const start = EVENT_PATTERNS.map((pattern) => buffer.indexOf(pattern, position)).filter((idx) => idx >= 0).sort((a, b) => a - b)[0] ?? -1
    if (start < 0) break
    const end = findJsonEnd(buffer, start)
    if (end < 0) return { events, remaining: buffer.slice(start) }
    try {
      const parsed = JSON.parse(buffer.slice(start, end + 1)) as Record<string, unknown>
      const event = parseEvent(parsed)
      if (event) events.push(event)
    } catch {
      // ignore non-json chunks in framing noise
    }
    position = end + 1
  }
  return { events, remaining: "" }
}

function sseData(data: unknown): string {
  return `data: ${JSON.stringify(data)}\n\n`
}

function createChunk(id: string, model: string, delta: Record<string, unknown>, finishReason: string | null = null) {
  return {
    id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  }
}

function parseRequestBody(init?: RequestInit): OpenAIChatRequest {
  if (typeof init?.body !== "string") {
    throw new Error("Kiro adapter expected a JSON request body")
  }
  return normalizeRequestBody(JSON.parse(init.body) as OpenAIChatRequest | OpenAIResponsesRequest)
}

function isResponsesRequest(body: OpenAIChatRequest | OpenAIResponsesRequest): body is OpenAIResponsesRequest {
  return !Array.isArray((body as OpenAIChatRequest).messages)
}

function normalizeResponseContent(content: unknown): OpenAIChatMessage["content"] {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""

  const normalized: Array<{ type: "text"; text: string } | { type: "image"; image_url: { url: string } }> = []
  for (const item of content) {
    if (!item || typeof item !== "object") continue
    const typed = item as { type?: string; text?: string; image_url?: string; file_url?: string }
    if ((typed.type === "input_text" || typed.type === "output_text" || typed.type === "text") && typeof typed.text === "string") {
      normalized.push({ type: "text", text: typed.text })
      continue
    }
    const url = typed.image_url ?? typed.file_url
    if ((typed.type === "input_image" || typed.type === "image") && typeof url === "string") {
      normalized.push({ type: "image", image_url: { url } })
    }
  }

  return normalized.length > 0 ? normalized : ""
}

function normalizeResponsesInputItem(item: OpenAIResponseInputItem): OpenAIChatMessage[] {
  if (typeof item === "string") {
    return [{ role: "user", content: item }]
  }

  if (!item || typeof item !== "object") return []

  if (item.type === "function_call") {
    return [
      {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: item.call_id ?? crypto.randomUUID(),
            type: "function",
            function: {
              name: item.name,
              arguments: item.arguments ?? "{}",
            },
          },
        ],
      },
    ]
  }

  if (item.type === "function_call_output") {
    return [
      {
        role: "tool",
        tool_call_id: item.call_id,
        content: typeof item.output === "string" ? item.output : JSON.stringify(item.output ?? ""),
      },
    ]
  }

  const role = typeof item.role === "string" ? item.role : "user"
  return [{ role, content: normalizeResponseContent(item.content) }]
}

function normalizeResponsesRequest(body: OpenAIResponsesRequest): OpenAIChatRequest {
  const messages: OpenAIChatMessage[] = []

  if (body.instructions) {
    messages.push({ role: "system", content: body.instructions })
  }

  if (typeof body.input === "string") {
    messages.push({ role: "user", content: body.input })
  } else if (Array.isArray(body.input)) {
    for (const item of body.input) {
      messages.push(...normalizeResponsesInputItem(item))
    }
  }

  return {
    model: body.model,
    messages,
    tools: body.tools,
    stream: body.stream,
    max_completion_tokens: body.max_output_tokens,
    reasoning_effort: body.reasoning?.effort,
    tool_choice: body.tool_choice,
  }
}

function normalizeRequestBody(body: OpenAIChatRequest | OpenAIResponsesRequest): OpenAIChatRequest {
  return isResponsesRequest(body) ? normalizeResponsesRequest(body) : body
}

function isKiroInterceptUrl(requestInput: RequestInfo | URL): boolean {
  const url = requestInput instanceof URL ? requestInput.href : typeof requestInput === "string" ? requestInput : requestInput.url
  return url.includes(CHAT_COMPLETIONS_PATH) || url.includes(RESPONSES_PATH)
}

function buildUsageFromContextPercentage(body: OpenAIChatRequest, percentage: number, currentCompletion: number) {
  const context = body.max_tokens ?? body.max_completion_tokens ?? 200_000
  const prompt = Math.round((percentage / 100) * context)
  return {
    prompt_tokens: prompt,
    completion_tokens: currentCompletion,
    total_tokens: prompt + currentCompletion,
  }
}

function toolCallChunk(tool: { id: string; name: string; input: string }) {
  return {
    tool_calls: [
      {
        index: 0,
        id: tool.id,
        type: "function",
        function: {
          name: tool.name,
          arguments: tool.input || "{}",
        },
      },
    ],
  }
}

export function shouldInterceptKiroRequest(requestInput: RequestInfo | URL): boolean {
  return isKiroInterceptUrl(requestInput)
}

export async function createKiroResponse(body: OpenAIChatRequest, auth: KiroCredentials): Promise<Response> {
  const responseId = crypto.randomUUID()
  const conversationId = crypto.randomUUID()
  const request = buildKiroRequest(body, conversationId, auth.profileArn)
  const kiroResponse = await fetch(getBaseUrl(auth.region), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${auth.access}`,
      "Content-Type": "application/json",
      "User-Agent": "opencode",
    },
    body: JSON.stringify(request),
  })

  if (!kiroResponse.ok || !kiroResponse.body) {
    const errorBody = await kiroResponse.text().catch(() => "")
    return Response.json(
      {
        error: {
          message: errorBody || `Kiro request failed with status ${kiroResponse.status}`,
          type: "kiro_error",
        },
      },
      { status: kiroResponse.status || 500 },
    )
  }

  if (!body.stream) {
    const text = await kiroResponse.text()
    const { events } = parseKiroEvents(text)
    let content = ""
    let finishReason: "stop" | "tool_calls" = "stop"
    let pendingTool: { id: string; name: string; input: string } | undefined
    let usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
    for (const event of events) {
      if (event.type === "content") content += event.data
      if (event.type === "toolUse") {
        pendingTool = { id: event.data.toolUseId, name: event.data.name, input: event.data.input }
        finishReason = "tool_calls"
      }
      if (event.type === "usage") {
        const prompt = event.data.inputTokens ?? usage.prompt_tokens
        const completion = event.data.outputTokens ?? usage.completion_tokens
        usage = { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion }
      }
      if (event.type === "contextUsage" && usage.prompt_tokens === 0) {
        usage = buildUsageFromContextPercentage(body, event.data.contextUsagePercentage, usage.completion_tokens)
      }
      if (event.type === "error") {
        return Response.json({ error: { message: event.data.message ?? event.data.error, type: event.data.error } }, { status: 502 })
      }
    }

    const message = pendingTool
      ? {
          role: "assistant",
          content,
          tool_calls: [
            {
              id: pendingTool.id,
              type: "function",
              function: {
                name: pendingTool.name,
                arguments: pendingTool.input || "{}",
              },
            },
          ],
        }
      : { role: "assistant", content }

    return Response.json({
      id: responseId,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: body.model,
      choices: [{ index: 0, message, finish_reason: finishReason }],
      usage,
    })
  }

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const encoder = new TextEncoder()
      controller.enqueue(encoder.encode(sseData(createChunk(responseId, body.model, { role: "assistant" }))))

      const reader = kiroResponse.body!.getReader()
      const decoder = new TextDecoder()
      let buffer = ""
      let currentTool: { id: string; name: string; input: string } | undefined
      let sawToolStop = false

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const parsed = parseKiroEvents(buffer)
        buffer = parsed.remaining

        for (const event of parsed.events) {
          if (event.type === "content") {
            controller.enqueue(encoder.encode(sseData(createChunk(responseId, body.model, { content: event.data }))))
          }
          if (event.type === "toolUse") {
            currentTool = { id: event.data.toolUseId, name: event.data.name, input: event.data.input }
            if (event.data.stop) {
              sawToolStop = true
              controller.enqueue(encoder.encode(sseData(createChunk(responseId, body.model, toolCallChunk(currentTool), "tool_calls"))))
              currentTool = undefined
            }
          }
          if (event.type === "toolUseInput" && currentTool) {
            currentTool.input += event.data.input
          }
          if (event.type === "toolUseStop" && currentTool && event.data.stop) {
            sawToolStop = true
            controller.enqueue(
              encoder.encode(
                sseData(createChunk(responseId, body.model, toolCallChunk(currentTool), "tool_calls")),
              ),
            )
            currentTool = undefined
          }
          if (event.type === "error") {
            controller.error(new Error(event.data.message ?? event.data.error))
            return
          }
        }
      }

      if (!sawToolStop) {
        controller.enqueue(encoder.encode(sseData(createChunk(responseId, body.model, {}, "stop"))))
      }
      controller.enqueue(encoder.encode("data: [DONE]\n\n"))
      controller.close()
    },
  })

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  })
}

export async function createKiroResponseFromRequest(requestInput: RequestInfo | URL, init: RequestInit | undefined, auth: KiroCredentials) {
  if (!shouldInterceptKiroRequest(requestInput)) return fetch(requestInput, init)
  return createKiroResponse(parseRequestBody(init), auth)
}
