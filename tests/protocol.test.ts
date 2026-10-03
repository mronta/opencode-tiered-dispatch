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
    expect(protocol).toContain("Use fast for missing context")
    expect(protocol).toContain("serialize phases")
    expect(protocol).toContain("native `subagent` tool")
    expect(protocol).toContain("agent `fast`")
    expect(protocol).toContain("self-contained prompt")
    expect(protocol).toContain("the goal")
    expect(protocol).toContain("relevant paths or boundaries when known")
    expect(protocol).toContain("constraints")
    expect(protocol).toContain("required verification")
    expect(protocol).toContain("exact result to return")
    expect(protocol).toContain("Do not pass a per-call model override")
    expect(protocol).toContain("classify, decompose, delegate, integrate")
    expect(protocol).toContain("delegate fast first")
    expect(protocol).toContain("at most two read-only calls")
  })

  it("makes never-direct mode explicit", () => {
    const neverDirect = parseOptions({
      tiers: {
        fast: { model: "openai/gpt-5.6-luna-fast" },
        medium: { model: "openai/gpt-5.6-luna", variant: "max" },
        heavy: { model: "openai/gpt-5.6-sol", variant: "medium" },
      },
      directThreshold: "never",
    })
    if (!neverDirect.enabled) throw new Error("test setup")

    expect(buildRoutingProtocol(neverDirect)).toContain("Delegate every executable task")
  })
})
