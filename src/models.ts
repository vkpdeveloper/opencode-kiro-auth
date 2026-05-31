import { KIRO_ENDPOINT_PATH, KIRO_MODEL_DEFS, KIRO_PROVIDER_ID, ZERO_COST, API_REGION_MAP } from "./constants.js"

export function resolveApiRegion(region?: string): string {
  if (!region) return "us-east-1"
  return API_REGION_MAP[region] ?? region
}

export function getBaseUrl(region?: string): string {
  return `https://q.${resolveApiRegion(region)}.amazonaws.com${KIRO_ENDPOINT_PATH}`
}

export function getConfigModels() {
  return Object.fromEntries(
    Object.entries(KIRO_MODEL_DEFS).map(([id, model]) => [
      id,
      {
        name: model.name,
        reasoning: model.reasoning,
        attachment: model.image,
        temperature: true,
        input: model.image ? ["text", "image"] : ["text"],
        output: ["text"],
        limit: {
          context: model.context,
          output: model.output,
        },
        cost: {
          input: 0,
          output: 0,
          cache: {
            read: 0,
            write: 0,
          },
        },
        status: "active" as const,
      },
    ]),
  )
}

export function getProviderModels(region?: string) {
  const baseUrl = getBaseUrl(region)

  return Object.fromEntries(
    Object.entries(KIRO_MODEL_DEFS).map(([id, model]) => [
      id,
      {
        id,
        providerID: KIRO_PROVIDER_ID,
        api: {
          id,
          url: baseUrl,
          npm: "@ai-sdk/openai-compatible",
        },
        name: model.name,
        family: id.split("-").slice(0, 2).join("-"),
        capabilities: {
          temperature: true,
          reasoning: model.reasoning,
          attachment: model.image,
          toolcall: true,
          input: {
            text: true,
            audio: false,
            image: model.image,
            video: false,
            pdf: false,
          },
          output: {
            text: true,
            audio: false,
            image: false,
            video: false,
            pdf: false,
          },
          interleaved: false,
        },
        cost: ZERO_COST,
        limit: {
          context: model.context,
          output: model.output,
        },
        options: {},
        headers: {},
        release_date: new Date().toISOString(),
        variants: {},
        status: "active" as const,
      },
    ]),
  )
}

export function resolveKiroModel(modelId: string): string {
  return modelId.replace(/(\d)-(\d)/g, "$1.$2")
}
