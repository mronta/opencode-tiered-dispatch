import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { parseModelReference } from "../src/options.js"
import { DEFAULT_TIER_MODELS, TIER_NAMES } from "../src/tiers.js"

describe("packaged tier configuration", () => {
  it("loads the runtime mapping from tiers.json", () => {
    const file = JSON.parse(readFileSync(new URL("../tiers.json", import.meta.url), "utf8"))
    expect(file).toEqual(DEFAULT_TIER_MODELS)
    expect(TIER_NAMES).toEqual(["fast", "medium", "heavy"])
  })

  it("loads valid packaged defaults without pinning model settings", () => {
    const file = JSON.parse(readFileSync(new URL("../tiers.json", import.meta.url), "utf8")) as Record<string, unknown>

    expect(Object.keys(file).sort()).toEqual([...TIER_NAMES].sort())
    for (const tier of TIER_NAMES) {
      const entry = file[tier]
      expect(entry).toEqual(expect.any(Object))
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) throw new Error(`invalid ${tier} test fixture`)
      const config = entry as Record<string, unknown>
      expect(Object.keys(config).sort()).toEqual(["model", ...(config.variant === undefined ? [] : ["variant"])].sort())
      expect(config.model).toEqual(expect.any(String))
      expect((config.model as string).trim()).toBe(config.model)
      expect(() => parseModelReference(config.model as string)).not.toThrow()
      if (config.variant !== undefined) {
        expect(config.variant).toEqual(expect.any(String))
        expect((config.variant as string).trim()).toBe(config.variant)
        expect((config.variant as string).length).toBeGreaterThan(0)
      }
    }

    expect(DEFAULT_TIER_MODELS).toEqual(file)
  })
})
