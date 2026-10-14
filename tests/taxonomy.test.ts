import { describe, expect, it } from "vitest"
import { DEFAULT_TAXONOMY, mergeTaxonomy } from "../src/taxonomy.js"

describe("mergeTaxonomy", () => {
  it("appends additions while retaining defaults", () => {
    const result = mergeTaxonomy({ fast: ["API lookup"] })
    expect(result.fast).toEqual([...DEFAULT_TAXONOMY.fast, "API lookup"])
    expect(result.medium).toEqual(DEFAULT_TAXONOMY.medium)
  })

  it("trims and deduplicates case-insensitively", () => {
    const result = mergeTaxonomy({ fast: [" API lookup ", "api LOOKUP"] })
    expect(result.fast.at(-1)).toBe("API lookup")
    expect(result.fast.filter((value) => value.toLowerCase() === "api lookup")).toHaveLength(1)
  })

  it("keeps repository shell inspection out of fast discovery", () => {
    const result = mergeTaxonomy({})
    expect(result.fast).toContain("file/search repository mapping")
    expect(result.fast).not.toContain("fact collection and repository mapping")
    expect(result.fast.some((entry) => entry.toLowerCase().includes("shell"))).toBe(false)
  })
})
