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
    const providerError = { type: "rate_limit", message: "rate limited", status: 429 }
    try {
      assertSuccessfulOutcome("failed", [
        { type: "assistant", content: [], error: providerError },
      ])
      throw new Error("expected provider failure")
    } catch (error) {
      expect(error).toBe(providerError)
    }
  })

  it("preserves failures recorded on compaction messages", () => {
    const providerError = { type: "rate_limit", message: "compaction rate limited", status: 429 }
    expect(() => assertSuccessfulOutcome("failed", [
      { type: "assistant", content: [{ type: "text", text: "partial" }] },
      { type: "compaction", status: "failed", error: providerError },
      { type: "idle", outcome: "failed" },
    ])).toThrow()
    try {
      assertSuccessfulOutcome("failed", [
        { type: "compaction", status: "failed", error: providerError },
      ])
    } catch (error) {
      expect(error).toBe(providerError)
    }
  })

  it("preserves failures recorded on tool content", () => {
    const providerError = { type: "provider_error", message: "tool request failed", status: 502 }
    expect(() => assertSuccessfulOutcome("failed", [
      {
        type: "assistant",
        content: [{ type: "tool", state: { status: "error", error: providerError } }],
      },
    ])).toThrow()
    try {
      assertSuccessfulOutcome("failed", [
        {
          type: "assistant",
          content: [{ type: "tool", state: { status: "error", error: providerError } }],
        },
      ])
    } catch (error) {
      expect(error).toBe(providerError)
    }
  })

  it("rejects empty output", () => {
    expect(() => extractFinalText([{ type: "assistant", content: [] }])).toThrow(/without assistant text/)
  })
})
