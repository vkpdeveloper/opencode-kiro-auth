import { describe, expect, test } from "bun:test"
import { ensureSocialProvider, parseStoredKiroOAuth } from "../src/oauth.js"

describe("parseStoredKiroOAuth", () => {
  test("parses desktop refresh payload with profile arn", () => {
    const result = parseStoredKiroOAuth({
      access: "a",
      refresh: `refresh-token|desktop|eu-central-1|meta:profile:${encodeURIComponent("arn:aws:test")}`,
      expires: 123,
    })

    expect(result).toEqual({
      access: "a",
      refresh: `refresh-token|desktop|eu-central-1|meta:profile:${encodeURIComponent("arn:aws:test")}`,
      expires: 123,
      clientId: "",
      clientSecret: "",
      region: "eu-central-1",
      authMethod: "desktop",
      profileArn: "arn:aws:test",
      socialProvider: undefined,
    })
  })

  test("parses desktop refresh payload with explicit social provider", () => {
    const result = parseStoredKiroOAuth({
      access: "a",
      refresh: "refresh-token|desktop|us-east-1|meta:profile:abc|social:google",
      expires: 123,
    })

    expect(result.socialProvider).toBe("google")
    expect(result.profileArn).toBe("abc")
  })

  test("parses legacy profile suffix format", () => {
    const result = parseStoredKiroOAuth({
      access: "a",
      refresh: `refresh-token|desktop|eu-central-1|profile:${encodeURIComponent("arn:aws:test")}`,
      expires: 123,
    })

    expect(result.profileArn).toBe("arn:aws:test")
  })

  test("parses idc refresh payload", () => {
    const result = parseStoredKiroOAuth({
      access: "a",
      refresh: "refresh-token|client|secret|idc|us-east-1",
      expires: 456,
    })

    expect(result.region).toBe("us-east-1")
    expect(result.clientId).toBe("client")
    expect(result.clientSecret).toBe("secret")
    expect(result.authMethod).toBe("idc")
  })

  test("accepts matching social provider", () => {
    const result = ensureSocialProvider(
      {
        access: "a",
        refresh: "r|desktop|us-east-1",
        expires: 1,
        clientId: "",
        clientSecret: "",
        region: "us-east-1",
        authMethod: "desktop",
        socialProvider: "google",
      },
      "google",
    )

    expect(result.socialProvider).toBe("google")
  })

  test("rejects mismatched social provider", () => {
    expect(() =>
      ensureSocialProvider(
        {
          access: "a",
          refresh: "r|desktop|us-east-1",
          expires: 1,
          clientId: "",
          clientSecret: "",
          region: "us-east-1",
          authMethod: "desktop",
          socialProvider: "google",
        },
        "github",
      ),
    ).toThrow("kiro-cli logged into google, but github was requested")
  })
})
