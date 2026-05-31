export const KIRO_PROVIDER_ID = "kiro"

export const BUILDER_ID_START_URL = "https://view.awsapps.com/start"
export const KIRO_ENDPOINT_PATH = "/generateAssistantResponse"
export const SSO_SCOPES = [
  "codewhisperer:completions",
  "codewhisperer:analysis",
  "codewhisperer:conversations",
  "codewhisperer:transformations",
  "codewhisperer:taskassist",
] as const

export const ZERO_COST = {
  input: 0,
  output: 0,
  cache: {
    read: 0,
    write: 0,
  },
} as const

export const KIRO_MODEL_DEFS = {
  "claude-opus-4-8": { name: "Claude Opus 4.8", context: 1_000_000, output: 128_000, reasoning: true, image: true },
  "claude-opus-4-7": { name: "Claude Opus 4.7", context: 1_000_000, output: 128_000, reasoning: true, image: true },
  "claude-opus-4-6": { name: "Claude Opus 4.6", context: 1_000_000, output: 128_000, reasoning: true, image: true },
  "claude-sonnet-4-6": { name: "Claude Sonnet 4.6", context: 1_000_000, output: 64_000, reasoning: true, image: true },
  "claude-sonnet-4-5": { name: "Claude Sonnet 4.5", context: 200_000, output: 64_000, reasoning: true, image: true },
  "claude-sonnet-4": { name: "Claude Sonnet 4", context: 200_000, output: 64_000, reasoning: true, image: true },
  "claude-haiku-4-5": { name: "Claude Haiku 4.5", context: 200_000, output: 64_000, reasoning: false, image: true },
  "deepseek-3-2": { name: "DeepSeek 3.2", context: 164_000, output: 16_384, reasoning: true, image: false },
  "minimax-m2-1": { name: "MiniMax M2.1", context: 196_000, output: 16_384, reasoning: false, image: false },
  "minimax-m2-5": { name: "MiniMax M2.5", context: 196_000, output: 16_384, reasoning: false, image: false },
  "glm-5": { name: "GLM 5", context: 200_000, output: 16_384, reasoning: true, image: false },
  "qwen3-coder-next": { name: "Qwen3 Coder Next", context: 256_000, output: 32_768, reasoning: true, image: false },
  auto: { name: "Auto", context: 1_000_000, output: 65_536, reasoning: true, image: true },
} as const

export const API_REGION_MAP: Record<string, string> = {
  "us-west-1": "us-east-1",
  "us-west-2": "us-east-1",
  "us-east-2": "us-east-1",
  "ap-southeast-1": "us-east-1",
  "ap-southeast-2": "us-east-1",
  "ap-northeast-1": "us-east-1",
  "ap-south-1": "us-east-1",
  "eu-west-1": "eu-central-1",
  "eu-west-2": "eu-central-1",
  "eu-west-3": "eu-central-1",
  "eu-north-1": "eu-central-1",
  "eu-south-1": "eu-central-1",
  "eu-south-2": "eu-central-1",
  "eu-central-2": "eu-central-1",
}

export const IDC_PROBE_REGIONS = [
  "us-east-1",
  "eu-west-1",
  "eu-central-1",
  "us-east-2",
  "eu-west-2",
  "eu-west-3",
  "eu-north-1",
  "ap-southeast-1",
  "ap-northeast-1",
  "us-west-2",
] as const
