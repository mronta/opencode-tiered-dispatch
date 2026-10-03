import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { REQUIRED_TIER_MODELS, TIER_NAMES } from "../src/tiers.js"

describe("packaged tier configuration", () => {
  it("loads the runtime mapping from tiers.json", () => {
    const file = JSON.parse(readFileSync(new URL("../tiers.json", import.meta.url), "utf8"))
    expect(file).toEqual(REQUIRED_TIER_MODELS)
    expect(TIER_NAMES).toEqual(["fast", "medium", "heavy"])
  })

  it("pins the fast tier to GPT-6 Luna medium reasoning", () => {
    expect(REQUIRED_TIER_MODELS.fast).toEqual({
      model: "openai/gpt-6-luna",
      variant: "medium",
    })
  })
})
