import { describe, expect, it } from "vitest"
import { parseOptions } from "../src/options.js"
import { buildRoutingProtocol } from "../src/protocol.js"

const options = parseOptions({
  tiers: {
    fast: { model: "openai/gpt-5.6-luna-fast" },
    medium: { model: "openai/gpt-5.6-luna", variant: "max" },
    heavy: { model: "openai/gpt-5.6-sol", variant: "medium" },
  },
  taxonomy: { fast: ["schema lookup"] },
})

describe("buildRoutingProtocol", () => {
  it("describes tiers, splitting, delegation briefs, and the native subagent tool", () => {
    if (!options.enabled) throw new Error("test setup")
    const protocol = buildRoutingProtocol(options)
    expect(protocol).toContain("schema lookup")
    expect(protocol).toContain("collect context with fast")
    expect(protocol).toContain("Serialize medium/heavy")
    expect(protocol).toContain("native `subagent` tool")
    expect(protocol).toContain("agent `fast`")
    expect(protocol).toContain("self-contained prompt")
    expect(protocol).toContain("the goal")
    expect(protocol).toContain("relevant paths or boundaries when known")
    expect(protocol).toContain("constraints")
    expect(protocol).toContain("required verification")
    expect(protocol).toContain("exact result to return")
    expect(protocol).toContain("Do not pass a per-call model override")
  })
})
