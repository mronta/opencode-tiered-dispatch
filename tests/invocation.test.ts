import { describe, expect, it } from "vitest"
import { tierModelOverrideError } from "../src/invocation.js"

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
