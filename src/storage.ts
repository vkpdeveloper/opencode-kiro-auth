import { existsSync, readFileSync } from "node:fs"
import { homedir, platform } from "node:os"
import { join } from "node:path"
import type { KiroAuthMethod, KiroCredentials, KiroSocialProvider } from "./types.js"

const SSO_CACHE_DIR = join(homedir(), ".aws", "sso", "cache")
const KIRO_IDE_TOKEN_PATH = join(SSO_CACHE_DIR, "kiro-auth-token.json")

function getKiroCliDbPath(): string | undefined {
  const current = platform()
  const dbPath =
    current === "win32"
      ? join(process.env.APPDATA || join(homedir(), "AppData", "Roaming"), "kiro-cli", "data.sqlite3")
      : current === "darwin"
        ? join(homedir(), "Library", "Application Support", "kiro-cli", "data.sqlite3")
        : join(homedir(), ".local", "share", "kiro-cli", "data.sqlite3")
  return existsSync(dbPath) ? dbPath : undefined
}

function queryCliJson(sql: string): string | undefined {
  const dbPath = getKiroCliDbPath()
  if (!dbPath) return undefined
  try {
    return Bun.spawnSync(["sqlite3", "-json", dbPath, sql], { stdout: "pipe", stderr: "pipe" }).stdout.toString().trim() || undefined
  } catch {
    return undefined
  }
}

function tryCliToken(tokenKey: string, authMethod: KiroAuthMethod, allowExpired = false): KiroCredentials | undefined {
  const tokenResult = queryCliJson(`SELECT value FROM auth_kv WHERE key = '${tokenKey}'`)
  if (!tokenResult) return undefined
  try {
    const rows = JSON.parse(tokenResult) as Array<{ value?: string }>
    const rawValue = rows[0]?.value
    if (!rawValue) return undefined
    const tokenData = JSON.parse(rawValue) as {
      access_token?: string
      refresh_token?: string
      expires_at?: string
      region?: string
      profile_arn?: string
      profileArn?: string
      provider?: string
    }
    if (!tokenData.access_token || !tokenData.refresh_token) return undefined
    const expiresAt = tokenData.expires_at ? new Date(tokenData.expires_at).getTime() : Date.now() + 3_600_000
    if (!allowExpired && Date.now() >= expiresAt - 120_000) return undefined
    if (authMethod === "desktop") {
      const socialProvider = tokenData.provider === "google" || tokenData.provider === "github" ? (tokenData.provider as KiroSocialProvider) : undefined
      return {
        access: tokenData.access_token,
        refresh: `${tokenData.refresh_token}|desktop|${tokenData.region ?? "us-east-1"}`,
        expires: expiresAt,
        clientId: "",
        clientSecret: "",
        region: tokenData.region ?? "us-east-1",
        authMethod,
        profileArn: tokenData.profile_arn ?? tokenData.profileArn,
        socialProvider,
      }
    }

    let clientId = ""
    let clientSecret = ""
    const keyPrefix = tokenKey.split(":")[0]
    const device = queryCliJson(`SELECT value FROM auth_kv WHERE key = '${keyPrefix}:odic:device-registration'`)
    if (device) {
      const deviceRows = JSON.parse(device) as Array<{ value?: string }>
      const rawDevice = deviceRows[0]?.value
      if (rawDevice) {
        const parsed = JSON.parse(rawDevice) as { client_id?: string; client_secret?: string; clientId?: string; clientSecret?: string }
        clientId = parsed.client_id ?? parsed.clientId ?? ""
        clientSecret = parsed.client_secret ?? parsed.clientSecret ?? ""
      }
    }

    return {
      access: tokenData.access_token,
      refresh: `${tokenData.refresh_token}|${clientId}|${clientSecret}|idc|${tokenData.region ?? "us-east-1"}`,
      expires: expiresAt,
      clientId,
      clientSecret,
      region: tokenData.region ?? "us-east-1",
      authMethod,
    }
  } catch {
    return undefined
  }
}

export function getKiroIdeCredentials(allowExpired = false): KiroCredentials | undefined {
  try {
    if (!existsSync(KIRO_IDE_TOKEN_PATH)) return undefined
    const tokenData = JSON.parse(readFileSync(KIRO_IDE_TOKEN_PATH, "utf-8")) as {
      accessToken?: string
      refreshToken?: string
      expiresAt?: string
      region?: string
      clientIdHash?: string
    }
    if (!tokenData.accessToken || !tokenData.refreshToken || !tokenData.expiresAt) return undefined
    const expiresAt = new Date(tokenData.expiresAt).getTime()
    if (!allowExpired && Date.now() >= expiresAt - 120_000) return undefined

    let clientId = ""
    let clientSecret = ""
    if (tokenData.clientIdHash) {
      const regPath = join(SSO_CACHE_DIR, `${tokenData.clientIdHash}.json`)
      if (existsSync(regPath)) {
        const reg = JSON.parse(readFileSync(regPath, "utf-8")) as { clientId?: string; clientSecret?: string }
        clientId = reg.clientId ?? ""
        clientSecret = reg.clientSecret ?? ""
      }
    }

    return {
      access: tokenData.accessToken,
      refresh: `${tokenData.refreshToken}|${clientId}|${clientSecret}|idc|${tokenData.region ?? "us-east-1"}`,
      expires: expiresAt - 120_000,
      clientId,
      clientSecret,
      region: tokenData.region ?? "us-east-1",
      authMethod: "idc",
    }
  } catch {
    return undefined
  }
}

export function getSharedKiroCredentials(allowExpired = false): KiroCredentials | undefined {
  return (
    getKiroIdeCredentials(allowExpired) ??
    tryCliToken("kirocli:social:token", "desktop", allowExpired) ??
    tryCliToken("kirocli:odic:token", "idc", allowExpired) ??
    tryCliToken("codewhisperer:odic:token", "idc", allowExpired)
  )
}

export function getKiroCliSocialCredentials(allowExpired = false): KiroCredentials | undefined {
  return tryCliToken("kirocli:social:token", "desktop", allowExpired)
}
