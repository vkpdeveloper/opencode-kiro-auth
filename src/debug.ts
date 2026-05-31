import { appendFileSync, mkdirSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

const LOG_DIR = join(homedir(), ".config", "opencode", "kiro-logs")
const LOG_FILE = join(LOG_DIR, "adapter-debug.log")
const MAX_VALUE_LENGTH = 20_000

function truncate(value: string): string {
  if (value.length <= MAX_VALUE_LENGTH) return value
  const head = value.slice(0, 10_000)
  const tail = value.slice(-10_000)
  return `${head}\n... [TRUNCATED ${value.length - MAX_VALUE_LENGTH} CHARS] ...\n${tail}`
}

function serialize(value: unknown): string {
  try {
    if (typeof value === "string") return truncate(value)
    return truncate(JSON.stringify(value, null, 2))
  } catch (error) {
    return `<<unserializable: ${error instanceof Error ? error.message : String(error)}>>`
  }
}

export function logDebug(label: string, value?: unknown): void {
  if (process.env.NODE_ENV === "test") return

  try {
    mkdirSync(LOG_DIR, { recursive: true })
    const timestamp = new Date().toISOString()
    const suffix = value === undefined ? "" : `\n${serialize(value)}`
    appendFileSync(LOG_FILE, `[${timestamp}] ${label}${suffix}\n\n`, "utf8")
  } catch {
    // Ignore debug logging failures so the plugin never breaks on logging.
  }
}

export function getDebugLogFilePath(): string {
  return LOG_FILE
}
