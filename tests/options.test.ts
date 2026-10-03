import { describe, expect, it } from "vitest"
import { modelSelection, parseModelReference, parseOptions } from "../src/options.js"
import { requiredTierOptions } from "./tier-fixtures.js"

const valid = {
  tiers: requiredTierOptions(),
}

describe("parseOptions", () => {
  it("normalizes enabled options", () => {
    expect(parseOptions(valid)).toMatchObject({
      enabled: true,
      directThreshold: "trivial",
      logging: false,
      tiers: { medium: { modelRef: parseModelReference(requiredTierOptions().medium.model) } },
    })
  })

  it("allows enabled false without validating tier targets", () => {
    expect(parseOptions({ enabled: false })).toEqual({ enabled: false })
    expect(parseOptions({
      enabled: false,
      tiers: {
        fast: { model: "other/fast" },
        medium: { model: "other/medium" },
        heavy: { model: "other/heavy" },
      },
    })).toEqual({ enabled: false })
  })

  it("rejects unknown nested fields even when disabled", () => {
    expect(() => parseOptions({ enabled: false, taxonomy: { other: ["x"] } }))
      .toThrow(/unknown field/)
    expect(() => parseOptions({
      enabled: false,
      tiers: { fast: { ...requiredTierOptions().fast, cost: 1 } },
    })).toThrow(/unknown field: cost/)
  })

  it("rejects unknown fields", () => {
    expect(() => parseOptions({ ...valid, fallback: true })).toThrow(/unknown field: fallback/)
    expect(() => parseOptions({ tiers: { ...valid.tiers, fast: { ...requiredTierOptions().fast, cost: 1 } } }))
      .toThrow(/unknown field: cost/)
  })

  it("defaults the packaged tier models when tiers are omitted", () => {
    expect(parseOptions({})).toMatchObject({
      enabled: true,
      tiers: requiredTierOptions(),
    })
    expect(parseOptions({ tiers: { medium: { instructions: "Keep the patch small" } } }))
      .toMatchObject({ tiers: { medium: { instructions: "Keep the patch small", ...requiredTierOptions().medium } } })
  })

  it("validates taxonomy values", () => {
    expect(() => parseOptions({ ...valid, taxonomy: { fast: [""] } })).toThrow(/non-empty string/)
    expect(() => parseOptions({ ...valid, taxonomy: { other: ["x"] } })).toThrow(/unknown field/)
  })

  it("requires the configured tier model mapping", () => {
    expect(() => parseOptions({
      ...valid,
      tiers: { ...valid.tiers, fast: { model: "openai/other" } },
    })).toThrow(/options\.tiers\.fast must use model/)
  })
})

describe("parseModelReference", () => {
  it("splits only the provider prefix", () => {
    expect(parseModelReference("provider/model/path")).toEqual({ providerID: "provider", id: "model/path" })
  })

  it.each(["provider", "/model", "provider/"])("rejects %s", (value) => {
    expect(() => parseModelReference(value)).toThrow(/provider\/model/)
  })

  it("adds an explicit variant to a model selection", () => {
    expect(modelSelection("provider/model", "medium")).toEqual({
      providerID: "provider",
      id: "model",
      variant: "medium",
    })
  })
})
