import { describe, expect, it } from "vitest"
import { modelSelection, parseModelReference, parseOptions } from "../src/options.js"
import { defaultTierOptions } from "./tier-fixtures.js"

const valid = {
  tiers: defaultTierOptions(),
}

describe("parseOptions", () => {
  it("normalizes enabled options", () => {
    expect(parseOptions(valid)).toMatchObject({
      enabled: true,
      directThreshold: "trivial",
      logging: false,
      tiers: { medium: { modelRef: parseModelReference(defaultTierOptions().medium.model) } },
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
      tiers: { fast: { ...defaultTierOptions().fast, cost: 1 } },
    })).toThrow(/unknown field: cost/)
  })

  it("rejects unknown fields", () => {
    expect(() => parseOptions({ ...valid, fallback: true })).toThrow(/unknown field: fallback/)
    expect(() => parseOptions({ tiers: { ...valid.tiers, fast: { ...defaultTierOptions().fast, cost: 1 } } }))
      .toThrow(/unknown field: cost/)
  })

  it("defaults the packaged tier models when tiers are omitted", () => {
    expect(parseOptions({})).toMatchObject({
      enabled: true,
      tiers: defaultTierOptions(),
    })
    expect(parseOptions({ tiers: { medium: { instructions: "Keep the patch small" } } }))
      .toMatchObject({ tiers: { medium: { instructions: "Keep the patch small", ...defaultTierOptions().medium } } })
  })

  it("rejects null instead of defaulting directThreshold", () => {
    expect(() => parseOptions({ ...valid, directThreshold: null })).toThrow(/directThreshold/)
  })

  it("validates taxonomy values", () => {
    expect(() => parseOptions({ ...valid, taxonomy: { fast: [""] } })).toThrow(/non-empty string/)
    expect(() => parseOptions({ ...valid, taxonomy: { other: ["x"] } })).toThrow(/unknown field/)
  })

  it("accepts a custom tier model mapping", () => {
    const parsed = parseOptions({
      ...valid,
      tiers: {
        fast: { model: "provider/custom", variant: "deliberate" },
        medium: { model: "provider/defaulted" },
        heavy: { variant: "careful" },
      },
    })
    expect(parsed).toMatchObject({
      tiers: {
        fast: {
          model: "provider/custom",
          modelRef: { providerID: "provider", id: "custom" },
          variant: "deliberate",
        },
        medium: {
          model: "provider/defaulted",
          modelRef: { providerID: "provider", id: "defaulted" },
        },
        heavy: {
          model: defaultTierOptions().heavy.model,
          modelRef: parseModelReference(defaultTierOptions().heavy.model),
          variant: "careful",
        },
      },
    })
    expect(parsed.enabled && parsed.tiers.medium.variant).toBeUndefined()
  })

  it("keeps strict model and variant validation for custom mappings", () => {
    expect(() => parseOptions({ tiers: { fast: { model: "not-a-model" } } }))
      .toThrow(/provider\/model/)
    expect(() => parseOptions({ tiers: { fast: { model: "provider/model", variant: "" } } }))
      .toThrow(/variant must be a non-empty string/)
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
