import { describe, expect, test } from "bun:test"
import { buildKiroRequest } from "../src/transform.js"

describe("buildKiroRequest", () => {
  test("folds system prompt into first/current user message and converts tools", () => {
    const request = buildKiroRequest(
      {
        model: "claude-sonnet-4-6",
        reasoning_effort: "high",
        tools: [
          {
            type: "function",
            function: {
              name: "bash",
              description: "Run shell",
              parameters: { type: "object", properties: { cmd: { type: "string" } } },
            },
          },
        ],
        messages: [
          { role: "system", content: "Be concise" },
          { role: "user", content: "First" },
          { role: "assistant", content: "Okay" },
          { role: "user", content: "Second" },
        ],
      },
      "conv-1",
    )

    expect(request.conversationState.history?.[0]?.userInputMessage?.content).toContain("Be concise")
    expect(request.conversationState.currentMessage.userInputMessage.content).toContain("<thinking_mode>enabled</thinking_mode>")
    expect(request.conversationState.currentMessage.userInputMessage.userInputMessageContext?.tools?.[0]?.toolSpecification.name).toBe("bash")
  })

  test("merges consecutive tool results into a single user history entry", () => {
    const request = buildKiroRequest(
      {
        model: "claude-sonnet-4-6",
        messages: [
          { role: "user", content: "Start" },
          {
            role: "assistant",
            content: "",
            tool_calls: [
              {
                id: "tc1",
                type: "function",
                function: { name: "bash", arguments: '{"cmd":"ls"}' },
              },
            ],
          },
          { role: "tool", tool_call_id: "tc1", content: "one" },
          { role: "tool", tool_call_id: "tc2", content: "two" },
          { role: "user", content: "Done" },
        ],
      },
      "conv-2",
    )

    const results = request.conversationState.history?.find((item) => item.userInputMessage?.userInputMessageContext?.toolResults)
    expect(results?.userInputMessage?.userInputMessageContext?.toolResults).toHaveLength(2)
  })

  test("maps max reasoning effort to the largest thinking budget", () => {
    const request = buildKiroRequest(
      {
        model: "claude-sonnet-4-6",
        reasoning_effort: "max",
        messages: [{ role: "user", content: "Think hard" }],
      },
      "conv-3",
    )

    expect(request.conversationState.currentMessage.userInputMessage.content).toContain("<max_thinking_length>50000</max_thinking_length>")
  })
})
