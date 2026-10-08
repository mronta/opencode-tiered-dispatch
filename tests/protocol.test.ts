import { describe, expect, it } from "vitest"
import { getEncoding } from "js-tiktoken"
import { TIER_AGENT_DEFINITIONS } from "../src/agents.js"
import { parseOptions } from "../src/options.js"
import { buildRoutingProtocol } from "../src/protocol.js"
import { defaultTierOptions } from "./tier-fixtures.js"

const tierConfig = defaultTierOptions()

const options = parseOptions({
  tiers: tierConfig,
  taxonomy: { fast: ["schema lookup"] },
})

describe("buildRoutingProtocol", () => {
  it("describes tiers, splitting, delegation briefs, and the native subagent tool", () => {
    if (!options.enabled) throw new Error("test setup")
    const protocol = buildRoutingProtocol(options)
    expect(protocol).toContain("schema lookup")
    expect(protocol).toContain("serialize dependent phases")
    expect(protocol).toContain("native `subagent`")
    expect(protocol).toContain("MANDATORY")
    expect(protocol).toContain("Hard route")
    expect(protocol).toContain("first tool MUST be native `subagent`")
    expect(protocol).toContain("agent fast|medium|heavy")
    expect(protocol).toContain("prompt: goal")
    expect(protocol).toContain("goal")
    expect(protocol).toContain("paths/scope")
    expect(protocol).toContain("constraints")
    expect(protocol).toContain("verification")
    expect(protocol).toContain("expected result")
    expect(protocol).toContain("No per-call model override")
    expect(protocol).toContain("Classify→decompose→delegate→integrate→answer")
    expect(protocol).toContain("Reuse same child for execution follow-ups")
    expect(protocol).toContain("integrate returned evidence")
    expect(protocol).toContain("ONLY requested root verification ONCE")
    expect(protocol).toContain("children may run tests")
    expect(protocol).toContain("read/search, not arbitrary shell")
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
    expect(protocol).toContain("After fast, execute")
    expect(protocol).toContain("Batch related discovery")
    expect(protocol).toContain("pass findings, paths and unresolved questions")
    expect(protocol).toContain("NEED CONTEXT / SCOPE GROWTH")
    expect(protocol).toContain("dependent phases and overlapping edits")
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
