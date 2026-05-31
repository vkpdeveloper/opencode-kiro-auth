import { logDebug } from "./debug.js"
import { getBaseUrl } from "./models.js"
import { buildKiroRequest } from "./transform.js"
import type { KiroCredentials, KiroEvent, OpenAIChatMessage, OpenAIChatRequest, OpenAIResponseInputItem, OpenAIResponsesRequest } from "./types.js"

const CHAT_COMPLETIONS_PATH = "/chat/completions"
const RESPONSES_PATH = "/responses"
const KIRO_AGENT_MODE = "vibe"
const profileArnCache = new Map<string, { arn?: string; checkedAt: number }>()
const EVENT_PATTERNS = [
  '{"content":',
  '{"name":',
  '{"input":',
  '{"stop":',
  '{"contextUsagePercentage":',
  '{"usage":',
  '{"message":',
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
  if (parsed.error !== undefined || parsed.Error !== undefined || parsed.message !== undefined || parsed.Message !== undefined) {
    const error = typeof parsed.error === "string" ? parsed.error : typeof parsed.Error === "string" ? parsed.Error : "unknown"
    const message =
      typeof parsed.message === "string"
        ? parsed.message
        : typeof parsed.Message === "string"
          ? parsed.Message
          : typeof parsed.reason === "string"
            ? parsed.reason
            : undefined
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

function createResponsesOutputItems(content: string, tool?: { id: string; name: string; input: string }) {
  const items: unknown[] = []

  if (content) {
    items.push({
      id: crypto.randomUUID(),
      type: "message",
      status: "completed",
      role: "assistant",
      content: [
        {
          type: "output_text",
          text: content,
          annotations: [],
        },
      ],
    })
  }

  if (tool) {
    items.push({
      id: crypto.randomUUID(),
      type: "function_call",
      call_id: tool.id,
      name: tool.name,
      arguments: tool.input || "{}",
      status: "completed",
    })
  }

  return items
}

function createResponsesPayload(
  id: string,
  model: string,
  content: string,
  tool: { id: string; name: string; input: string } | undefined,
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number },
) {
  return {
    id,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status: "completed",
    model,
    output: createResponsesOutputItems(content, tool),
    usage: {
      input_tokens: usage.prompt_tokens,
      output_tokens: usage.completion_tokens,
      total_tokens: usage.total_tokens,
      input_tokens_details: {
        cached_tokens: 0,
      },
      output_tokens_details: {
        reasoning_tokens: 0,
      },
    },
  }
}

function createKiroHeaders(accessToken: string): Record<string, string> {
  const middlewareId = crypto.randomUUID().replace(/-/g, "")
  const awsUserAgent = `aws-sdk-rust/1.0.0 ua/2.1 os/other lang/rust api/codewhispererstreaming#1.28.3 m/E app/AmazonQ-For-CLI md/appVersion-1.28.3-${middlewareId}`

  return {
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/x-amz-json-1.0",
    Accept: "application/json",
    "X-Amz-Target": "AmazonCodeWhispererStreamingService.GenerateAssistantResponse",
    "x-amzn-codewhisperer-optout": "true",
    "amz-sdk-invocation-id": crypto.randomUUID(),
    "amz-sdk-request": "attempt=1; max=1",
    "x-amzn-kiro-agent-mode": KIRO_AGENT_MODE,
    "x-amz-user-agent": awsUserAgent,
    "user-agent": awsUserAgent,
  }
}

function createProfileHeaders(accessToken: string): Record<string, string> {
  return {
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/x-amz-json-1.0",
    "X-Amz-Target": "AmazonCodeWhispererService.ListAvailableProfiles",
  }
}

async function resolveProfileArn(accessToken: string, endpoint: string): Promise<string | undefined> {
  const cacheKey = `${endpoint}:${accessToken.slice(-16)}`
  const cached = profileArnCache.get(cacheKey)
  if (cached && Date.now() - cached.checkedAt < 300_000) return cached.arn

  try {
    const profileEndpoint = new URL(endpoint)
    profileEndpoint.pathname = profileEndpoint.pathname.replace(/\/generateAssistantResponse\/?$/, "/")
    profileEndpoint.search = ""
    profileEndpoint.hash = ""

    const response = await fetch(profileEndpoint.toString(), {
      method: "POST",
      headers: createProfileHeaders(accessToken),
      body: "{}",
    })

    if (!response.ok) {
      logDebug("profile arn lookup failed", { status: response.status, statusText: response.statusText })
      profileArnCache.set(cacheKey, { checkedAt: Date.now() })
      return undefined
    }

    const data = (await response.json()) as { profiles?: Array<{ arn?: string }> }
    const arn = data.profiles?.find((profile) => profile.arn)?.arn
    profileArnCache.set(cacheKey, { arn, checkedAt: Date.now() })
    logDebug("profile arn lookup completed", { hasProfileArn: !!arn })
    return arn
  } catch (error) {
    logDebug("profile arn lookup exception", { message: error instanceof Error ? error.message : String(error) })
    profileArnCache.set(cacheKey, { checkedAt: Date.now() })
    return undefined
  }
}

function getKiroErrorMessage(errorBody: string, fallback: string): string {
  if (!errorBody) return fallback
  try {
    const parsed = JSON.parse(errorBody) as { message?: unknown; Message?: unknown; error?: unknown; Error?: unknown; reason?: unknown }
    const message = parsed.message ?? parsed.Message ?? parsed.error ?? parsed.Error ?? parsed.reason
    return typeof message === "string" && message ? message : errorBody
  } catch {
    return errorBody
  }
}

function parseRequestBody(init?: RequestInit): OpenAIChatRequest {
  if (typeof init?.body !== "string") {
    throw new Error("Kiro adapter expected a JSON request body")
  }
  const parsed = JSON.parse(init.body) as OpenAIChatRequest | OpenAIResponsesRequest
  logDebug("incoming request body", parsed)
  const normalized = normalizeRequestBody(parsed)
  logDebug("normalized request body", normalized)
  return normalized
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

export async function createKiroResponse(body: OpenAIChatRequest, auth: KiroCredentials, responseMode: "chat" | "responses" = "chat"): Promise<Response> {
  const responseId = crypto.randomUUID()
  const conversationId = crypto.randomUUID()
  const endpoint = getBaseUrl(auth.region)
  const profileArn = auth.profileArn ?? (await resolveProfileArn(auth.access, endpoint))
  const request = buildKiroRequest(body, conversationId, profileArn)
  logDebug("kiro request", { conversationId, request, model: body.model, stream: body.stream === true })
  const kiroResponse = await fetch(endpoint, {
    method: "POST",
    headers: createKiroHeaders(auth.access),
    body: JSON.stringify(request),
  })

  if (!kiroResponse.ok || !kiroResponse.body) {
    const errorBody = await kiroResponse.text().catch(() => "")
    logDebug("kiro non-ok response", { status: kiroResponse.status, statusText: kiroResponse.statusText, body: errorBody })
    const message = getKiroErrorMessage(errorBody, `Kiro request failed with status ${kiroResponse.status}`)
    return Response.json(
      {
        error: {
          message,
          type: "kiro_error",
        },
      },
      { status: kiroResponse.status || 500 },
    )
  }

  if (!body.stream) {
    const text = await kiroResponse.text()
    const { events } = parseKiroEvents(text)
    logDebug("kiro non-stream response", { byteLength: text.length, events })
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
        logDebug("kiro parsed error event", event.data)
        return Response.json({ error: { message: event.data.message ?? event.data.error, type: event.data.error } }, { status: 502 })
      }
    }

    if (responseMode === "responses") {
      return Response.json(createResponsesPayload(responseId, body.model, content, pendingTool, usage))
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
            logDebug("kiro stream error event", event.data)
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
  const url = requestInput instanceof URL ? requestInput.href : typeof requestInput === "string" ? requestInput : requestInput.url
  logDebug("intercepted request", { url, method: init?.method ?? "GET" })
  const responseMode = url.includes(RESPONSES_PATH) ? "responses" : "chat"
  try {
    return await createKiroResponse(parseRequestBody(init), auth, responseMode)
  } catch (error) {
    logDebug("adapter exception", {
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    })
    throw error
  }
}
