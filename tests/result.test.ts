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
    expect(() => assertSuccessfulOutcome("failed", [
      { type: "assistant", content: [], error: { message: "rate limited" } },
    ])).toThrow(/rate limited/)
  })

  it("rejects empty output", () => {
    expect(() => extractFinalText([{ type: "assistant", content: [] }])).toThrow(/without assistant text/)
  })
})
