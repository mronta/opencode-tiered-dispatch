import { describe, expect, it } from "vitest"
import { parseModelReference, parseOptions } from "../src/options.js"

const valid = {
  tiers: {
    fast: { model: "openai/gpt-5.6-luna-fast" },
    medium: { model: "openai/gpt-5.6-luna", variant: "max" },
    heavy: { model: "openai/gpt-5.6-sol", variant: "medium" },
  },
}

describe("parseOptions", () => {
  it("normalizes enabled options", () => {
    expect(parseOptions(valid)).toMatchObject({
      enabled: true,
      directThreshold: "trivial",
      logging: false,
      tiers: { medium: { modelRef: { providerID: "openai", id: "gpt-5.6-luna" } } },
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
      tiers: { fast: { model: "openai/gpt-5.6-luna-fast", cost: 1 } },
    })).toThrow(/unknown field: cost/)
  })

  it("rejects unknown fields", () => {
    expect(() => parseOptions({ ...valid, fallback: true })).toThrow(/unknown field: fallback/)
    expect(() => parseOptions({ tiers: { ...valid.tiers, fast: { model: "openai/gpt-5.6-luna-fast", cost: 1 } } }))
      .toThrow(/unknown field: cost/)
  })

  it("requires all tiers when enabled", () => {
    expect(() => parseOptions({ tiers: { fast: {}, medium: {}, heavy: undefined } })).toThrow()
  })

  it("validates taxonomy values", () => {
    expect(() => parseOptions({ ...valid, taxonomy: { fast: [""] } })).toThrow(/non-empty string/)
    expect(() => parseOptions({ ...valid, taxonomy: { other: ["x"] } })).toThrow(/unknown field/)
  })

  it("requires the configured tier model mapping", () => {
    expect(() => parseOptions({
      ...valid,
      tiers: { ...valid.tiers, fast: { model: "openai/gpt-5.6-luna", variant: "max" } },
    })).toThrow(/options\.tiers\.fast must use model openai\/gpt-5\.6-luna-fast/)
  })
})

describe("parseModelReference", () => {
  it("splits only the provider prefix", () => {
    expect(parseModelReference("provider/model/path")).toEqual({ providerID: "provider", id: "model/path" })
  })

  it.each(["provider", "/model", "provider/"])("rejects %s", (value) => {
    expect(() => parseModelReference(value)).toThrow(/provider\/model/)
  })
})
