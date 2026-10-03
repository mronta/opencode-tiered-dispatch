import { describe, expect, it } from "vitest"
import { assessRouting } from "../scripts/routing-eval.mjs"

function trace(tools) {
  return { id: "composite", rootSessionID: "root", elapsedMs: 100, tools, sessions: [{ outcome: "succeeded", usage: [] }] }
}

const discovery = { phase: "before", tool: "subagent", sessionID: "root", id: "a", input: { agent: "fast" } }
const complete = { ...discovery, phase: "after", status: "completed" }
const implement = { ...discovery, id: "b", input: { agent: "medium", prompt: "Change src/controller.js using the discovered validation flow." } }

describe("spontaneous routing assessment", () => {
  it("accepts sequential discovery and implementation with evidence handoff", () => {
    expect(assessRouting(trace([discovery, complete, implement]), ["fast", "medium"]).problems).toEqual([])
  })

  it("rejects implementation-only execution of a composite discovery task", () => {
    expect(assessRouting(trace([implement]), ["fast", "medium"]).problems).toContain("expected fast→medium; observed medium")
  })

  it("rejects dependent execution started before discovery completes", () => {
    expect(assessRouting(trace([discovery, implement, complete]), ["fast", "medium"]).problems).toContain("dependent phases overlapped or discovery failed")
  })

  it("rejects a second phase without discovered file paths", () => {
    const missing = { ...implement, input: { agent: "medium", prompt: "Fix it." } }
    expect(assessRouting(trace([discovery, complete, missing]), ["fast", "medium"]).problems).toContain("execution prompt did not carry discovered file paths")
  })

  it("allows direct trivial work and flags discovery budget overruns", () => {
    expect(assessRouting(trace([]), []).problems).toEqual([])
    const reads = Array.from({ length: 3 }, () => ({ phase: "before", tool: "read", sessionID: "root" }))
    expect(assessRouting(trace(reads), []).problems).toContain("primary exceeded discovery budget: 3 calls")
  })
})
