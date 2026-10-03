import { describe, expect, it } from "vitest"
import { assessRouting } from "../scripts/routing-eval.mjs"

function trace(tools) {
  return { id: "composite", rootSessionID: "root", elapsedMs: 100, tools, sessions: [{ outcome: "succeeded", usage: [] }] }
}

const discovery = { phase: "before", tool: "subagent", sessionID: "root", id: "a", input: { agent: "fast" } }
const complete = { ...discovery, phase: "after", status: "completed", resultText: "Validation belongs in src/controller.js." }
const implement = { ...discovery, id: "b", input: { agent: "medium", prompt: "Change src/controller.js using the discovered validation flow." } }
const implemented = { ...implement, phase: "after", status: "completed" }

describe("spontaneous routing assessment", () => {
  it("accepts sequential discovery and implementation with evidence handoff", () => {
    expect(assessRouting(trace([discovery, complete, implement, implemented]), ["fast", "medium"]).problems).toEqual([])
  })

  it("rejects implementation-only execution of a composite discovery task", () => {
    expect(assessRouting(trace([implement, implemented]), ["fast", "medium"]).problems).toContain("expected fast→medium (focused discovery/resume cycles allowed); observed medium")
  })

  it("rejects dependent execution started before discovery completes", () => {
    expect(assessRouting(trace([discovery, implement, complete, implemented]), ["fast", "medium"]).problems).toContain("dependent phases overlapped or discovery failed")
  })

  it("rejects a second phase without discovered file paths", () => {
    const missing = { ...implement, input: { agent: "medium", prompt: "Fix it." } }
    expect(assessRouting(trace([discovery, complete, missing, implemented]), ["fast", "medium"]).problems).toContain("execution prompt did not carry discovered file evidence")
  })

  it("rejects a fabricated handoff path not returned by discovery", () => {
    const fabricated = { ...implement, input: { agent: "medium", prompt: "Change src/unrelated.js." } }
    expect(assessRouting(trace([discovery, complete, fabricated, implemented]), ["fast", "medium"]).problems).toContain("execution prompt did not carry discovered file evidence")
  })

  it("requires the final delegation to complete", () => {
    expect(assessRouting(trace([discovery, complete, implement]), ["fast", "medium"]).problems).toContain("native delegation did not complete")
  })

  it("allows a focused discovery and execution resumption cycle", () => {
    const followup = { ...discovery, id: "c" }
    const followed = { ...complete, id: "c" }
    const resume = { ...implement, id: "d" }
    const resumed = { ...implemented, id: "d" }
    expect(assessRouting(trace([discovery, complete, implement, implemented, followup, followed, resume, resumed]), ["fast", "medium"]).problems).toEqual([])
  })

  it("rejects recovery and overlapping edits before the originating tier returns", () => {
    const followup = { ...discovery, id: "c" }
    const followed = { ...complete, id: "c" }
    const resume = { ...implement, id: "d" }
    const resumed = { ...implemented, id: "d" }
    expect(assessRouting(trace([discovery, complete, implement, followup, followed, resume, implemented, resumed]), ["fast", "medium"]).problems).toContain("recovery or execution began before the previous execution returned")
  })

  it("preserves per-scenario verification failures", () => {
    const result = { ...trace([discovery, complete, implement, implemented]), fixtureProblems: ["validation failed"] }
    expect(assessRouting(result, ["fast", "medium"]).problems).toEqual(["validation failed"])
  })

  it("allows direct trivial work and rejects pre-dispatch nontrivial tools", () => {
    expect(assessRouting(trace([]), []).problems).toEqual([])
    const reads = [{ phase: "before", tool: "read", sessionID: "root" }]
    expect(assessRouting(trace(reads), ["fast", "medium"]).problems).toContain("primary used tools before first nontrivial delegation: read")
  })
})
