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
    const mockedFetch = mock(() =>
      Promise.resolve(
        new Response('{"content":"Hello"}{"usage":{"inputTokens":10,"outputTokens":2}}', {
          status: 200,
        }),
      ),
    )
    globalThis.fetch = mockedFetch as typeof fetch

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

    const profileInit = mockedFetch.mock.calls[0]?.[1] as RequestInit
    expect((profileInit.headers as Record<string, string>)["X-Amz-Target"]).toBe("AmazonCodeWhispererService.ListAvailableProfiles")

    const generateCall = mockedFetch.mock.calls[mockedFetch.mock.calls.length - 1]
    const init = generateCall?.[1] as RequestInit
    const headers = init.headers as Record<string, string>
    const requestBody = JSON.parse(String(init.body))
    expect(headers["Content-Type"]).toBe("application/x-amz-json-1.0")
    expect(headers["X-Amz-Target"]).toBe("AmazonCodeWhispererStreamingService.GenerateAssistantResponse")
    expect(headers["x-amzn-kiro-agent-mode"]).toBe("vibe")
    expect(requestBody.agentMode).toBe("vibe")
  })

  test("returns parsed Kiro error messages", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response('{"message":"Improperly formed request.","reason":null}', {
          status: 400,
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
    expect(response.status).toBe(400)
    expect(json.error.message).toBe("Improperly formed request.")
  })

  test("resolves and includes Kiro profile arn when available", async () => {
    const mockedFetch = mock((input: RequestInfo | URL, init?: RequestInit) => {
      const target = (init?.headers as Record<string, string> | undefined)?.["X-Amz-Target"]
      if (target === "AmazonCodeWhispererService.ListAvailableProfiles") {
        return Promise.resolve(
          Response.json({
            profiles: [{ arn: "arn:aws:codewhisperer:us-east-1:123:profile/test" }],
          }),
        )
      }
      return Promise.resolve(
        new Response('{"content":"Hello"}{"usage":{"inputTokens":10,"outputTokens":2}}', {
          status: 200,
        }),
      )
    })
    globalThis.fetch = mockedFetch as typeof fetch

    await createKiroResponse(
      {
        model: "claude-sonnet-4-6",
        messages: [{ role: "user", content: "Hi" }],
        stream: false,
      },
      {
        access: "profile-access",
        refresh: "refresh|client|secret|idc|us-east-1",
        expires: Date.now() + 100000,
        clientId: "client",
        clientSecret: "secret",
        region: "us-east-1",
        authMethod: "idc",
      },
    )

    const generateCall = mockedFetch.mock.calls[mockedFetch.mock.calls.length - 1]
    const requestBody = JSON.parse(String((generateCall?.[1] as RequestInit).body))
    expect(requestBody.profileArn).toBe("arn:aws:codewhisperer:us-east-1:123:profile/test")
  })
})
