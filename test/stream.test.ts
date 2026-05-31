import { afterEach, describe, expect, mock, test } from "bun:test"
import { createKiroResponse, shouldInterceptKiroRequest } from "../src/stream.js"

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe("stream adapter", () => {
  test("detects intercepted urls", () => {
    expect(shouldInterceptKiroRequest("https://example.com/chat/completions")).toBe(true)
    expect(shouldInterceptKiroRequest("https://example.com/responses")).toBe(true)
    expect(shouldInterceptKiroRequest("https://example.com/models")).toBe(false)
  })

  test("maps non-stream Kiro response into chat completion", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response('{"content":"Hello"}{"usage":{"inputTokens":10,"outputTokens":2}}', {
          status: 200,
        }),
      ),
    ) as typeof fetch

    const response = await createKiroResponse(
      {
        model: "claude-sonnet-4-6",
        messages: [{ role: "user", content: "Hi" }],
        stream: false,
      },
      {
        access: "access",
        refresh: "refresh|client|secret|idc|us-east-1",
        expires: Date.now() + 100000,
        clientId: "client",
        clientSecret: "secret",
        region: "us-east-1",
        authMethod: "idc",
      },
    )

    const json = await response.json()
    expect(json.choices[0].message.content).toBe("Hello")
    expect(json.usage).toEqual({ prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 })
  })
})
