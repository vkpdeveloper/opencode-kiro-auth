import type { Plugin } from "@opencode-ai/plugin"
import { OAUTH_DUMMY_KEY } from "./auth-constants.js"
import { KIRO_PROVIDER_ID } from "./constants.js"
import { getDebugLogFilePath, logDebug } from "./debug.js"
import { getConfigModels, getBaseUrl } from "./models.js"
import { authorizeKiro, parseStoredKiroOAuth, refreshKiroToken } from "./oauth.js"
import { getSharedKiroCredentials } from "./storage.js"
import { createKiroResponseFromRequest } from "./stream.js"

const KiroAuthPlugin: Plugin = async ({ client }) => {
  logDebug("plugin loaded", { provider: KIRO_PROVIDER_ID, logFile: getDebugLogFilePath() })

  async function ensureFreshAuth(getAuth: () => Promise<{ type: string; access?: string; refresh?: string; expires?: number }>) {
    const auth = await getAuth()
    if (auth.type !== "oauth" || !auth.access || !auth.refresh || typeof auth.expires !== "number") return undefined

    const parsed = parseStoredKiroOAuth({
      access: auth.access,
      refresh: auth.refresh,
      expires: auth.expires,
    })

    if (parsed.expires > Date.now() + 60_000) return parsed

    const refreshed = await refreshKiroToken({
      type: "oauth",
      access: parsed.access,
      refresh: parsed.refresh,
      expires: parsed.expires,
    })

    await client.auth.set({
      path: { id: KIRO_PROVIDER_ID },
      body: {
        type: "oauth",
        access: refreshed.access,
        refresh: refreshed.refresh,
        expires: refreshed.expires,
      },
    })

    return refreshed
  }

  return {
    auth: {
      provider: KIRO_PROVIDER_ID,
      async loader(getAuth, provider) {
        for (const model of Object.values(provider.models ?? {})) {
          model.cost = { input: 0, output: 0, cache: { read: 0, write: 0 } }
        }

        const stored = await getAuth()
        if (stored.type === "oauth" && stored.access && stored.refresh && typeof stored.expires === "number") {
          const parsed = parseStoredKiroOAuth({
            access: stored.access,
            refresh: stored.refresh,
            expires: stored.expires,
          })
          return {
            apiKey: OAUTH_DUMMY_KEY,
            baseURL: getBaseUrl(parsed.region),
            fetch: async (requestInput: RequestInfo | URL, init?: RequestInit) => {
              const auth = await ensureFreshAuth(getAuth)
              if (!auth) return fetch(requestInput, init)
              return createKiroResponseFromRequest(requestInput, init, auth)
            },
          }
        }

        const shared = getSharedKiroCredentials()
        if (!shared) return {}

        return {
          apiKey: OAUTH_DUMMY_KEY,
          baseURL: getBaseUrl(shared.region),
          fetch: async (requestInput: RequestInfo | URL, init?: RequestInit) => {
            return createKiroResponseFromRequest(requestInput, init, shared)
          },
        }
      },
      methods: [
        {
          type: "oauth",
          label: "Kiro (Builder ID / Organization / Google / GitHub)",
          prompts: [
            {
              type: "select",
              key: "method",
              message: "Select Kiro login method",
              options: [
                { label: "Auto / existing session", value: "auto", hint: "Reuse Kiro IDE or kiro-cli login when available" },
                { label: "AWS Builder ID", value: "builder-id", hint: "Native device-code flow" },
                { label: "Your organization", value: "organization", hint: "IAM Identity Center start URL" },
                { label: "Google via kiro-cli", value: "google", hint: "Requires kiro-cli in PATH" },
                { label: "GitHub via kiro-cli", value: "github", hint: "Requires kiro-cli in PATH" },
              ],
            },
            {
              type: "text",
              key: "startUrl",
              message: "IAM Identity Center start URL",
              placeholder: "https://mycompany.awsapps.com/start",
              when: { key: "method", op: "eq", value: "organization" },
            },
          ],
          authorize: authorizeKiro,
        },
      ],
    },
    async config(config) {
      config.provider = config.provider ?? {}
      config.provider[KIRO_PROVIDER_ID] = {
        npm: "@ai-sdk/openai-compatible",
        name: "Kiro",
        options: {
          baseURL: getBaseUrl(),
        },
        models: getConfigModels(),
      }
    },
  }
}

export default KiroAuthPlugin
export { KiroAuthPlugin }
