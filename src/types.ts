export type KiroAuthMethod = "idc" | "desktop"
export type KiroSocialProvider = "google" | "github"
export type KiroLoginMethod = "auto" | "builder-id" | "organization" | "google" | "github"

export type KiroStoredOAuth = {
  type: "oauth"
  access: string
  refresh: string
  expires: number
  accountId?: string
  enterpriseUrl?: string
  region?: string
  authMethod?: KiroAuthMethod
  profileArn?: string
}

export type KiroCredentials = {
  access: string
  refresh: string
  expires: number
  clientId: string
  clientSecret: string
  region: string
  authMethod: KiroAuthMethod
  profileArn?: string
  socialProvider?: KiroSocialProvider
}

export type DeviceAuth = {
  verificationUri: string
  verificationUriComplete: string
  userCode: string
  deviceCode: string
  interval: number
  expiresIn: number
}

export type OpenAIChatMessage = {
  role: string
  content?: unknown
  tool_calls?: Array<{
    id: string
    type: "function"
    function: {
      name: string
      arguments: string
    }
  }>
  tool_call_id?: string
  name?: string
}

export type OpenAIChatRequest = {
  model: string
  messages: OpenAIChatMessage[]
  tools?: OpenAITool[]
  stream?: boolean
  max_tokens?: number
  max_completion_tokens?: number
  reasoning_effort?: string
  tool_choice?: "auto" | "required" | "none" | { type: string }
}

export type OpenAITool = {
  type: "function"
  function?: {
    name: string
    description?: string
    parameters?: Record<string, unknown>
  }
  name?: string
  description?: string
  parameters?: Record<string, unknown>
}

type OpenAIResponseInputText = {
  type: "input_text" | "output_text" | "text"
  text: string
}

type OpenAIResponseInputImage = {
  type: "input_image" | "image"
  image_url?: string
  file_url?: string
}

type OpenAIResponseFunctionCall = {
  type: "function_call"
  call_id?: string
  name: string
  arguments?: string
}

type OpenAIResponseFunctionCallOutput = {
  type: "function_call_output"
  call_id: string
  output?: unknown
}

type OpenAIResponseReasoning = {
  type: "reasoning"
}

export type OpenAIResponseInputItem =
  | string
  | {
      type?: "message"
      role: string
      content:
        | string
        | Array<OpenAIResponseInputText | OpenAIResponseInputImage | OpenAIResponseFunctionCall | OpenAIResponseFunctionCallOutput | OpenAIResponseReasoning>
    }
  | OpenAIResponseFunctionCall
  | OpenAIResponseFunctionCallOutput

export type OpenAIResponsesRequest = {
  model: string
  input?: string | OpenAIResponseInputItem[]
  instructions?: string
  tools?: OpenAITool[]
  stream?: boolean
  max_output_tokens?: number
  reasoning?: {
    effort?: string
  }
  tool_choice?: OpenAIChatRequest["tool_choice"]
}

export type KiroImage = {
  format: string
  source: { bytes: string }
}

export type KiroToolSpec = {
  toolSpecification: {
    name: string
    description: string
    inputSchema: { json: Record<string, unknown> }
  }
}

export type KiroToolResult = {
  content: Array<{ text: string }>
  status: "success" | "error"
  toolUseId: string
}

export type KiroToolUse = {
  name: string
  toolUseId: string
  input: Record<string, unknown>
}

export type KiroUserInputMessage = {
  content: string
  modelId: string
  origin: "KIRO_CLI"
  images?: KiroImage[]
  userInputMessageContext?: {
    toolResults?: KiroToolResult[]
    tools?: KiroToolSpec[]
  }
}

export type KiroHistoryEntry = {
  userInputMessage?: KiroUserInputMessage
  assistantResponseMessage?: {
    content: string
    toolUses?: KiroToolUse[]
  }
}

export type KiroRequest = {
  conversationState: {
    chatTriggerType: "MANUAL"
    agentTaskType: "vibe"
    conversationId: string
    currentMessage: {
      userInputMessage: KiroUserInputMessage
    }
    history?: KiroHistoryEntry[]
  }
  profileArn?: string
  agentMode?: string
}

export type KiroEvent =
  | { type: "content"; data: string }
  | { type: "toolUse"; data: { name: string; toolUseId: string; input: string; stop?: boolean } }
  | { type: "toolUseInput"; data: { input: string } }
  | { type: "toolUseStop"; data: { stop: boolean } }
  | { type: "contextUsage"; data: { contextUsagePercentage: number } }
  | { type: "usage"; data: { inputTokens?: number; outputTokens?: number } }
  | { type: "error"; data: { error: string; message?: string } }
