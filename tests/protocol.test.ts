import { describe, expect, it } from "vitest"
import { getEncoding } from "js-tiktoken"
import { TIER_AGENT_DEFINITIONS } from "../src/agents.js"
import { parseOptions } from "../src/options.js"
import { buildRoutingProtocol } from "../src/protocol.js"

const tierConfig = {
  fast: { model: "openai/gpt-6-luna" },
  medium: { model: "openai/gpt-5.6-luna", variant: "max" },
  heavy: { model: "openai/gpt-5.6-sol", variant: "medium" },
}

const options = parseOptions({
  tiers: tierConfig,
  taxonomy: { fast: ["schema lookup"] },
})

describe("buildRoutingProtocol", () => {
  it("describes tiers, splitting, delegation briefs, and the native subagent tool", () => {
    if (!options.enabled) throw new Error("test setup")
    const protocol = buildRoutingProtocol(options)
    expect(protocol).toContain("schema lookup")
    expect(protocol).toContain("serialize phases")
    expect(protocol).toContain("native `subagent`")
    expect(protocol).toContain("agent `fast`")
    expect(protocol).toContain("self-contained prompt")
    expect(protocol).toContain("goal")
    expect(protocol).toContain("paths/scope")
    expect(protocol).toContain("constraints")
    expect(protocol).toContain("verification")
    expect(protocol).toContain("expected result")
    expect(protocol).toContain("No per-call model override")
    expect(protocol).toContain("classify, decompose, delegate, integrate")
    expect(protocol).toContain("At most two direct read-only discovery calls")
  })

  it("makes never-direct mode explicit", () => {
    const neverDirect = parseOptions({
      tiers: tierConfig,
      directThreshold: "never",
    })
    if (!neverDirect.enabled) throw new Error("test setup")

    expect(buildRoutingProtocol(neverDirect)).toContain("Delegate every executable task")
  })

  it("requires evidence handoff for composite work without splitting known scope", () => {
    if (!options.enabled) throw new Error("test setup")
    const protocol = buildRoutingProtocol(options)

    expect(protocol).toContain("missing context + edits→fast then medium")
    expect(protocol).toContain("missing context + difficult analysis→fast then heavy")
    expect(protocol).toContain("known scope→one delegation")
    expect(protocol).toContain("Batch related discovery")
    expect(protocol).toContain("Pass findings, paths and unresolved questions forward")
    expect(protocol).toContain("NEED CONTEXT / SCOPE GROWTH")
    expect(protocol).toContain("serialize overlapping edits")
  })

  it("keeps default routing and tier prompts within explicit token budgets", () => {
    const defaults = parseOptions({})
    if (!defaults.enabled) throw new Error("test setup")
    const encoding = getEncoding("o200k_base")

    expect(encoding.encode(buildRoutingProtocol(defaults)).length).toBeLessThanOrEqual(380)
    for (const tier of Object.values(TIER_AGENT_DEFINITIONS)) {
      expect(encoding.encode(tier.system).length).toBeLessThanOrEqual(85)
    }
  })
})
