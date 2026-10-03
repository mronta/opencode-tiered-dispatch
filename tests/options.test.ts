import { describe, expect, it } from "vitest"
import { parseModelReference, parseOptions } from "../src/options.js"

const valid = {
  tiers: {
    fast: { model: "openai/fast" },
    medium: { model: "openai/medium", variant: "high" },
    heavy: { model: "anthropic/heavy" },
  },
}

describe("parseOptions", () => {
  it("normalizes enabled options", () => {
    expect(parseOptions(valid)).toMatchObject({
      enabled: true,
      directThreshold: "trivial",
      logging: false,
      tiers: { medium: { modelRef: { providerID: "openai", id: "medium" } } },
    })
  })

  it("allows enabled false without tiers", () => {
    expect(parseOptions({ enabled: false })).toEqual({ enabled: false })
  })

  it("rejects unknown nested fields even when disabled", () => {
    expect(() => parseOptions({ enabled: false, taxonomy: { other: ["x"] } }))
      .toThrow(/unknown field/)
    expect(() => parseOptions({
      enabled: false,
      tiers: { fast: { model: "openai/fast", cost: 1 } },
    })).toThrow(/unknown field: cost/)
  })

  it("rejects unknown fields", () => {
    expect(() => parseOptions({ ...valid, fallback: true })).toThrow(/unknown field: fallback/)
    expect(() => parseOptions({ tiers: { ...valid.tiers, fast: { model: "openai/fast", cost: 1 } } }))
      .toThrow(/unknown field: cost/)
  })

  it("requires all tiers when enabled", () => {
    expect(() => parseOptions({ tiers: { fast: {}, medium: {}, heavy: undefined } })).toThrow()
  })

  it("validates taxonomy values", () => {
    expect(() => parseOptions({ ...valid, taxonomy: { fast: [""] } })).toThrow(/non-empty string/)
    expect(() => parseOptions({ ...valid, taxonomy: { other: ["x"] } })).toThrow(/unknown field/)
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
