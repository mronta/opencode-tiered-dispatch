import { describe, expect, it } from "vitest"
import { parseOptions } from "../src/options.js"
import { buildRoutingProtocol } from "../src/protocol.js"

const options = parseOptions({
  tiers: {
    fast: { model: "x/fast" },
    medium: { model: "x/medium" },
    heavy: { model: "x/heavy" },
  },
  taxonomy: { fast: ["schema lookup"] },
})

describe("buildRoutingProtocol", () => {
  it("describes tiers, splitting, serialization, and the tool", () => {
    if (!options.enabled) throw new Error("test setup")
    const protocol = buildRoutingProtocol(options)
    expect(protocol).toContain("schema lookup")
    expect(protocol).toContain("collect context with fast")
    expect(protocol).toContain("Serialize medium/heavy")
    expect(protocol).toContain("tiered_dispatch")
  })
})
