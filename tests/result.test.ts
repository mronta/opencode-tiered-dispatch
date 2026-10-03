import { describe, expect, it } from "vitest"
import { assertSuccessfulOutcome, extractFinalText } from "../src/result.js"

describe("delegation result extraction", () => {
  it("returns the latest assistant text", () => {
    expect(extractFinalText([
      { type: "assistant", content: [{ type: "text", text: "first" }] },
      { type: "assistant", content: [{ type: "reasoning" }, { type: "text", text: "final" }] },
      { type: "idle", outcome: "succeeded" },
    ])).toBe("final")
  })

  it("reports provider failures", () => {
    const providerError = { type: "rate_limit", message: "rate limited" }
    try {
      assertSuccessfulOutcome("failed", [
        { type: "assistant", content: [], error: providerError },
      ])
      throw new Error("expected provider failure")
    } catch (error) {
      expect(error).toMatchObject({ message: "rate_limit: rate limited", cause: providerError })
    }
  })

  it("rejects empty output", () => {
    expect(() => extractFinalText([{ type: "assistant", content: [] }])).toThrow(/without assistant text/)
  })
})
