import { execFileSync, spawn } from "node:child_process"
import { BUILDER_ID_START_URL, IDC_PROBE_REGIONS, SSO_SCOPES } from "./constants.js"
import { getKiroCliSocialCredentials, getSharedKiroCredentials } from "./storage.js"
import type { DeviceAuth, KiroCredentials, KiroLoginMethod, KiroSocialProvider, KiroStoredOAuth } from "./types.js"

const METADATA_SEPARATOR = "|meta:"
const LEGACY_PROFILE_SEPARATOR = "|profile:"

function splitMetadata(refresh: string): { base: string; extras: string[] } {
  if (refresh.includes(METADATA_SEPARATOR)) {
    const [base, metadata] = refresh.split(METADATA_SEPARATOR)
    return { base, extras: (metadata ?? "").split("|").filter(Boolean) }
  }
  if (refresh.includes(LEGACY_PROFILE_SEPARATOR)) {
    const [base, metadata] = refresh.split(LEGACY_PROFILE_SEPARATOR)
    const extras = (metadata ?? "").split("|").filter(Boolean)
    if (extras.length === 0) return { base, extras: [] }
    return { base, extras: [`profile:${extras[0]}`, ...extras.slice(1)] }
  }
  return { base: refresh, extras: [] }
}

function encodeRefreshToken(credentials: KiroCredentials): string {
  const refreshToken = credentials.refresh.split("|")[0] ?? credentials.refresh
  const tags = [
    credentials.profileArn ? `profile:${encodeURIComponent(credentials.profileArn)}` : "",
    credentials.socialProvider ? `social:${credentials.socialProvider}` : "",
  ].filter(Boolean)
  const suffix = tags.length > 0 ? `${METADATA_SEPARATOR}${tags.join("|")}` : ""
  if (credentials.authMethod === "desktop") {
    return `${refreshToken}|desktop|${credentials.region}${suffix}`
  }
  return `${refreshToken}|${credentials.clientId}|${credentials.clientSecret}|idc|${credentials.region}${suffix}`
}

export function parseStoredKiroOAuth(auth: Pick<KiroStoredOAuth, "access" | "refresh" | "expires">): KiroCredentials {
  const { base, extras } = splitMetadata(auth.refresh)
  const parts = base.split("|")
  const profileTag = extras.find((item) => item.startsWith("profile:"))
  const socialTag = extras.find((item) => item.startsWith("social:"))
  const profileArn = profileTag ? decodeURIComponent(profileTag.slice("profile:".length)) : undefined
  const socialProvider = socialTag ? (socialTag.slice("social:".length) as KiroSocialProvider) : undefined
  if (parts[1] === "desktop") {
    return {
      access: auth.access,
      refresh: auth.refresh,
      expires: auth.expires,
      clientId: "",
      clientSecret: "",
      region: parts[2] ?? "us-east-1",
      authMethod: "desktop",
      profileArn,
      socialProvider,
    }
  }

  return {
    access: auth.access,
    refresh: auth.refresh,
    expires: auth.expires,
    clientId: parts[1] ?? "",
    clientSecret: parts[2] ?? "",
    authMethod: "idc",
    region: parts[4] ?? "us-east-1",
    profileArn,
  }
}

export function ensureSocialProvider(credentials: KiroCredentials | undefined, provider: KiroSocialProvider): KiroCredentials {
  if (!credentials) {
    throw new Error(`kiro-cli login completed but no social credentials were found for ${provider}`)
  }
  if (credentials.authMethod !== "desktop") {
    throw new Error(`kiro-cli login did not produce social-login credentials for ${provider}`)
  }
  if (credentials.socialProvider && credentials.socialProvider !== provider) {
    throw new Error(`kiro-cli logged into ${credentials.socialProvider}, but ${provider} was requested`)
  }
  return {
    ...credentials,
    socialProvider: provider,
  }
}

function openBrowser(url: string): void {
  try {
    const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "rundll32" : "xdg-open"
    const args = process.platform === "win32" ? ["url.dll,FileProtocolHandler", url] : [url]
    const child = spawn(command, args, { stdio: "ignore", detached: true })
    child.unref?.()
  } catch {
    // ignore browser open failures
  }
}

async function tryRegisterAndAuthorize(startUrl: string, region: string) {
  const oidcEndpoint = `https://oidc.${region}.amazonaws.com`
  const register = await fetch(`${oidcEndpoint}/client/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": "opencode" },
    body: JSON.stringify({
      clientName: "opencode",
      clientType: "public",
      scopes: SSO_SCOPES,
      grantTypes: ["urn:ietf:params:oauth:grant-type:device_code", "refresh_token"],
    }),
  })
  if (!register.ok) return undefined
  const reg = (await register.json()) as { clientId: string; clientSecret: string }

  const authorize = await fetch(`${oidcEndpoint}/device_authorization`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": "opencode" },
    body: JSON.stringify({ clientId: reg.clientId, clientSecret: reg.clientSecret, startUrl }),
  })
  if (!authorize.ok) return undefined

  return {
    oidcEndpoint,
    clientId: reg.clientId,
    clientSecret: reg.clientSecret,
    device: (await authorize.json()) as DeviceAuth,
  }
}

async function pollDeviceCode(
  oidcEndpoint: string,
  clientId: string,
  clientSecret: string,
  region: string,
  device: DeviceAuth,
): Promise<KiroCredentials> {
  const deadline = Date.now() + device.expiresIn * 1000
  let intervalMs = (device.interval || 5) * 1000

  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, intervalMs))

    const token = await fetch(`${oidcEndpoint}/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": "opencode" },
      body: JSON.stringify({
        clientId,
        clientSecret,
        deviceCode: device.deviceCode,
        grantType: "urn:ietf:params:oauth:grant-type:device_code",
      }),
    })
    const data = (await token.json()) as {
      error?: string
      accessToken?: string
      refreshToken?: string
      expiresIn?: number
    }

    if (data.accessToken && data.refreshToken) {
      return {
        access: data.accessToken,
        refresh: `${data.refreshToken}|${clientId}|${clientSecret}|idc|${region}`,
        expires: Date.now() + (data.expiresIn ?? 3600) * 1000 - 300_000,
        clientId,
        clientSecret,
        region,
        authMethod: "idc",
      }
    }
    if (data.error === "slow_down") intervalMs += 5000
    else if (data.error && data.error !== "authorization_pending") throw new Error(`Authorization failed: ${data.error}`)
  }

  throw new Error("Authorization timed out")
}

async function startIdcFlow(startUrl: string) {
  for (const region of IDC_PROBE_REGIONS) {
    const result = await tryRegisterAndAuthorize(startUrl, region)
    if (result) return { ...result, region }
  }
  throw new Error(`Could not find an AWS region that accepts ${startUrl}`)
}

export async function refreshKiroToken(auth: KiroStoredOAuth): Promise<KiroCredentials> {
  const shared = getSharedKiroCredentials()
  if (shared && shared.expires > Date.now()) return shared

  const parsed = parseStoredKiroOAuth(auth)
  const { base } = splitMetadata(auth.refresh)
  const parts = base.split("|")
  const refreshToken = parts[0] ?? ""
  const authMethod = parts[1] === "desktop" ? "desktop" : "idc"
  const region = authMethod === "desktop" ? (parts[2] ?? "us-east-1") : (parts[4] ?? "us-east-1")

  if (authMethod === "desktop") {
    const url = `https://prod.${region}.auth.desktop.kiro.dev/refreshToken`
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": "opencode" },
      body: JSON.stringify({ refreshToken }),
    })
    if (!response.ok) throw new Error(`Desktop token refresh failed: ${response.status}`)
    const data = (await response.json()) as {
      accessToken?: string
      refreshToken?: string
      expiresIn?: number
      profileArn?: string
    }
    if (!data.accessToken) throw new Error("Desktop token refresh returned no access token")
    return {
      access: data.accessToken,
      refresh: `${data.refreshToken ?? refreshToken}|desktop|${region}`,
      expires: Date.now() + (data.expiresIn ?? 3600) * 1000 - 300_000,
      clientId: "",
      clientSecret: "",
      region,
      authMethod: "desktop",
      profileArn: data.profileArn ?? parsed.profileArn,
    }
  }

  const clientId = parts[1] ?? ""
  const clientSecret = parts[2] ?? ""
  const response = await fetch(`https://oidc.${region}.amazonaws.com/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": "opencode" },
    body: JSON.stringify({ clientId, clientSecret, refreshToken, grantType: "refresh_token" }),
  })
  if (!response.ok) throw new Error(`Token refresh failed: ${response.status}`)
  const data = (await response.json()) as { accessToken?: string; refreshToken?: string; expiresIn?: number }
  if (!data.accessToken || !data.refreshToken) throw new Error("Token refresh returned incomplete credentials")
  return {
    access: data.accessToken,
    refresh: `${data.refreshToken}|${clientId}|${clientSecret}|idc|${region}`,
    expires: Date.now() + (data.expiresIn ?? 3600) * 1000 - 300_000,
    clientId,
    clientSecret,
    region,
    authMethod: "idc",
    profileArn: parsed.profileArn,
  }
}

export async function authorizeKiro(inputs?: Record<string, string>) {
  const method = (inputs?.method as KiroLoginMethod | undefined) ?? "auto"

  if (method === "auto") {
    const shared = getSharedKiroCredentials()
    if (shared) {
      return {
        url: "",
        instructions: "Using existing Kiro credentials from your IDE or kiro-cli session.",
        method: "auto" as const,
        callback: async () => ({
          type: "success" as const,
          access: shared.access,
          refresh: encodeRefreshToken(shared),
          expires: shared.expires,
        }),
      }
    }
  }

  if (method === "google" || method === "github") {
    return {
      url: "",
      instructions: `Running kiro-cli login for ${method}. Complete ${method} sign-in in the Kiro browser flow.`,
      method: "auto" as const,
      callback: async () => {
        try {
          execFileSync("kiro-cli", ["login", "--license", "free"], { timeout: 120000, stdio: "inherit" })
          const creds = ensureSocialProvider(getKiroCliSocialCredentials(), method)
          return {
            type: "success" as const,
            access: creds.access,
            refresh: encodeRefreshToken(creds),
            expires: creds.expires,
          }
        } catch {
          return { type: "failed" as const }
        }
      },
    }
  }

  const startUrl =
    method === "builder-id"
      ? BUILDER_ID_START_URL
      : method === "organization"
        ? (inputs?.startUrl?.trim() || "")
        : BUILDER_ID_START_URL
  if (method === "organization" && !startUrl) {
    throw new Error("IAM Identity Center start URL is required")
  }
  const flow = await startIdcFlow(startUrl)
  openBrowser(flow.device.verificationUriComplete)

  return {
    url: flow.device.verificationUriComplete,
    instructions: `Enter code: ${flow.device.userCode}`,
    method: "auto" as const,
    callback: async () => {
      try {
        const creds = await pollDeviceCode(flow.oidcEndpoint, flow.clientId, flow.clientSecret, flow.region, flow.device)
        return {
          type: "success" as const,
          access: creds.access,
          refresh: encodeRefreshToken(creds),
          expires: creds.expires,
        }
      } catch {
        return { type: "failed" as const }
      }
    },
  }
}
