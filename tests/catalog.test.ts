import { describe, expect, it } from "vitest"
import { assertAgentsAvailable, assertModelsAvailable } from "../src/catalog.js"
import { parseOptions } from "../src/options.js"

const parsed = parseOptions({
  tiers: {
    fast: { model: "p/fast", variant: "low" },
    medium: { model: "p/medium" },
    heavy: { model: "p/heavy" },
  },
})
if (!parsed.enabled) throw new Error("test setup")

const models = ["fast", "medium", "heavy"].map((id) => ({
  providerID: "p",
  id,
  enabled: true,
  capabilities: { tools: true },
  variants: id === "fast" ? [{ id: "low" }] : [],
}))

describe("catalog validation", () => {
  it("accepts available models and required agents", () => {
    expect(() => assertModelsAvailable(parsed, models)).not.toThrow()
    expect(assertAgentsAvailable([
      { id: "build", mode: "primary" },
      { id: "explore", mode: "subagent" },
      { id: "general", mode: "subagent" },
    ])).toEqual(new Set(["explore", "general"]))
  })

  it("rejects an unavailable variant", () => {
    const invalid = structuredClone(parsed)
    invalid.tiers.fast.variant = "max"
    expect(() => assertModelsAvailable(invalid, models)).toThrow(/available variants: low/)
  })

  it("rejects models without tools", () => {
    const invalid = structuredClone(models)
    invalid[0]!.capabilities.tools = false
    expect(() => assertModelsAvailable(parsed, invalid)).toThrow(/does not support tools/)
  })
})
