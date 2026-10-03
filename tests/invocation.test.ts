import { describe, expect, it } from "vitest"
import { planMutatingTierError, tierModelOverrideError } from "../src/invocation.js"

describe("planMutatingTierError", () => {
  it("rejects only explicit plan calls to mutating packaged tiers", () => {
    expect(planMutatingTierError("plan", { agent: "medium" })).toContain("switch to Build to execute")
    expect(planMutatingTierError("plan", { agent: "heavy" })).toContain("switch to Build to execute")
    expect(planMutatingTierError("plan", { agent: "fast" })).toBeUndefined()
    expect(planMutatingTierError("build", { agent: "medium" })).toBeUndefined()
    expect(planMutatingTierError("customactor", { agent: "medium" })).toBeUndefined()
  })

  it("does not infer a target for resumed calls whose input omits agent", () => {
    expect(planMutatingTierError("plan", { sessionID: "resumed", prompt: "continue" })).toBeUndefined()
    expect(planMutatingTierError("plan", { prompt: "continue" })).toBeUndefined()
  })
})

describe("tierModelOverrideError", () => {
  it("rejects a model override for every packaged tier", () => {
    for (const agent of ["fast", "medium", "heavy"]) {
      expect(tierModelOverrideError({ agent, model: "other/model" })).toContain(`Tier agent ${agent}`)
    }
  })

  it("allows tier invocations without a model override", () => {
    expect(tierModelOverrideError({ agent: "fast", prompt: "inspect the API" })).toBeUndefined()
    expect(tierModelOverrideError({ agent: "medium", model: undefined })).toBeUndefined()
    expect(tierModelOverrideError({ agent: "heavy", model: "" })).toBeUndefined()
  })

  it("leaves other agents and malformed inputs to native validation", () => {
    expect(tierModelOverrideError({ agent: "custom", model: "other/model" })).toBeUndefined()
    expect(tierModelOverrideError({ model: "other/model" })).toBeUndefined()
    expect(tierModelOverrideError(null)).toBeUndefined()
  })
})
