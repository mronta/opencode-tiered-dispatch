import { describe, expect, it } from "vitest"
import { assessRouting } from "../scripts/routing-eval.mjs"

function childSession(sessionID, agent, overrides = {}) {
  return { sessionID, parentID: "root", agent, outcome: "succeeded", usage: [], ...overrides }
}

function children(...agents) {
  return agents.map((agent, index) => childSession(`${agent}-${index}`, agent))
}

function trace(tools, childSessions = [], extra = {}) {
  return {
    id: "composite",
    rootSessionID: "root",
    elapsedMs: 100,
    tools,
    sessions: [{ sessionID: "root", agent: "build", outcome: "succeeded", usage: [] }, ...childSessions],
    ...extra,
  }
}

const discovery = { phase: "before", tool: "subagent", sessionID: "root", id: "a", input: { agent: "fast" } }
const complete = { ...discovery, phase: "after", status: "completed", resultText: "Validation belongs in src/controller.js." }
const implement = { ...discovery, id: "b", input: { agent: "medium", prompt: "Change src/controller.js using the discovered validation flow." } }
const implemented = { ...implement, phase: "after", status: "completed" }

describe("spontaneous routing assessment", () => {
  it("accepts sequential discovery and implementation with evidence handoff", () => {
    expect(assessRouting(trace([discovery, complete, implement, implemented], children("fast", "medium")), ["fast", "medium"]).problems).toEqual([])
  })

  it("rejects implementation-only execution of a composite discovery task", () => {
    expect(assessRouting(trace([implement, implemented], children("medium")), ["fast", "medium"]).problems).toContain("expected fast→medium (focused discovery/resume cycles allowed); observed medium")
  })

  it("rejects dependent execution started before discovery completes", () => {
    expect(assessRouting(trace([discovery, implement, complete, implemented], children("fast", "medium")), ["fast", "medium"]).problems).toContain("dependent phases overlapped or discovery failed")
  })

  it("rejects a second phase without discovered file paths", () => {
    const missing = { ...implement, input: { agent: "medium", prompt: "Fix it." } }
    expect(assessRouting(trace([discovery, complete, missing, implemented], children("fast", "medium")), ["fast", "medium"]).problems).toContain("execution prompt did not carry discovered file evidence")
  })

  it("rejects a fabricated handoff path not returned by discovery", () => {
    const fabricated = { ...implement, input: { agent: "medium", prompt: "Change src/unrelated.js." } }
    expect(assessRouting(trace([discovery, complete, fabricated, implemented], children("fast", "medium")), ["fast", "medium"]).problems).toContain("execution prompt did not carry discovered file evidence")
  })

  it("requires the final delegation to complete", () => {
    expect(assessRouting(trace([discovery, complete, implement], children("fast", "medium")), ["fast", "medium"]).problems).toContain("native delegation did not complete")
  })

  it("rejects completed root-only subagent events without observed child sessions", () => {
    const report = assessRouting(trace([discovery, complete, implement, implemented]), ["fast", "medium"])
    expect(report.problems.filter(problem => problem.includes("did not correlate to an observed child session"))).toHaveLength(2)
  })

  it("requires root-owned, successful child sessions and validates configured models when observed", () => {
    const models = {
      fast: { model: "provider/fast", variant: "low" },
      medium: { model: "provider/medium", variant: "high" },
    }
    const invalidChildren = [
      childSession("fast-child", "fast", { parentID: "other" }),
      childSession("medium-child", "medium", { outcome: "failed" }),
    ]
    const report = assessRouting(trace([discovery, complete, implement, implemented], invalidChildren), ["fast", "medium"], models)
    expect(report.problems).toContain("native delegation fast did not correlate to an observed child session with parent root")
    expect(report.problems).toContain("native delegation medium child session did not succeed")
  })

  it("rejects a child model or variant that differs from the runtime tier configuration", () => {
    const models = {
      fast: { model: "provider/fast", variant: "low" },
      medium: { model: "provider/medium", variant: "high" },
    }
    const child = childSession("medium-child", "medium", {
      model: { providerID: "provider", id: "medium", variant: "wrong" },
    })
    const report = assessRouting(trace([implement, implemented], [child]), ["medium"], models)
    expect(report.problems).toContain("native delegation medium child session used an unexpected model or variant")
  })

  it("rejects a missing child model when runtime tier configuration is supplied", () => {
    const models = { medium: { model: "provider/medium", variant: "high" } }
    const report = assessRouting(trace([implement, implemented], [childSession("medium-child", "medium")]), ["medium"], models)
    expect(report.problems).toContain("native delegation medium child session used an unexpected model or variant")
  })

  it("allows a focused discovery and execution resumption cycle", () => {
    const followup = { ...discovery, id: "c" }
    const followed = { ...complete, id: "c" }
    const resume = { ...implement, id: "d" }
    const resumed = { ...implemented, id: "d" }
    expect(assessRouting(trace([discovery, complete, implement, implemented, followup, followed, resume, resumed], children("fast", "medium", "fast", "medium")), ["fast", "medium"]).problems).toEqual([])
  })

  it("rejects recovery and overlapping edits before the originating tier returns", () => {
    const followup = { ...discovery, id: "c" }
    const followed = { ...complete, id: "c" }
    const resume = { ...implement, id: "d" }
    const resumed = { ...implemented, id: "d" }
    expect(assessRouting(trace([discovery, complete, implement, followup, followed, resume, implemented, resumed], children("fast", "medium", "fast", "medium")), ["fast", "medium"]).problems).toContain("recovery or execution began before the previous execution returned")
  })

  it("preserves per-scenario verification failures", () => {
    const result = { ...trace([discovery, complete, implement, implemented], children("fast", "medium")), fixtureProblems: ["validation failed"] }
    expect(assessRouting(result, ["fast", "medium"]).problems).toEqual(["validation failed"])
  })

  it("allows direct trivial work and rejects pre-dispatch nontrivial tools", () => {
    expect(assessRouting(trace([]), []).problems).toEqual([])
    const reads = [{ phase: "before", tool: "read", sessionID: "root" }]
    expect(assessRouting(trace(reads), ["fast", "medium"]).problems).toContain("primary used tools before first nontrivial delegation: read")
  })

  it("allows root reads for integration or final verification after delegation", () => {
    const read = { phase: "before", tool: "read", sessionID: "root", id: "verify" }
    expect(assessRouting(trace([discovery, complete, implement, implemented, read], children("fast", "medium")), ["fast", "medium"]).problems).toEqual([])
  })

  it("rejects root mutation or command execution after delegation", () => {
    const patch = { phase: "before", tool: "patch", sessionID: "root", id: "mutate" }
    expect(assessRouting(trace([discovery, complete, implement, implemented, patch], children("fast", "medium")), ["fast", "medium"]).problems).toContain("primary used disallowed tools after delegation: patch")
  })

  it("allows post-delegation orchestration and standalone verification commands", () => {
    const skill = { phase: "before", tool: "skill", sessionID: "root", id: "skill" }
    const shell = { phase: "before", tool: "shell", sessionID: "root", id: "test", input: { command: "npm test" } }
    const analysis = { ...shell, id: "analysis", input: { command: "node --input-type=module -e \"console.log(JSON.stringify({ ok: true }))\"" } }
    expect(assessRouting(trace([discovery, complete, implement, implemented, skill, shell, analysis], children("fast", "medium")), ["fast", "medium"]).problems).toEqual([])
  })

  it("rejects mutating shell commands after delegation", () => {
    const shell = { phase: "before", tool: "shell", sessionID: "root", id: "mutate", input: { command: "printf BAD > src/controller.js" } }
    expect(assessRouting(trace([implement, implemented, shell], children("medium")), ["medium"]).problems).toContain("primary used disallowed tools after delegation: shell")
  })

  it("rejects verification-looking shell commands with output or update flags", () => {
    const output = { phase: "before", tool: "shell", sessionID: "root", id: "output", input: { command: "git diff --output=changes.patch" } }
    const update = { phase: "before", tool: "shell", sessionID: "root", id: "update", input: { command: "npm test -- --updateSnapshot" } }
    const outputReport = assessRouting(trace([implement, implemented, output], children("medium")), ["medium"])
    const updateReport = assessRouting(trace([implement, implemented, update], children("medium")), ["medium"])
    expect(outputReport.problems).toContain("primary used disallowed tools after delegation: shell")
    expect(updateReport.problems).toContain("primary used disallowed tools after delegation: shell")
  })

  it("rejects inline node verification that can mutate or spawn processes", () => {
    const shell = { phase: "before", tool: "shell", sessionID: "root", id: "mutate", input: { command: "node --input-type=module -e \"import fs from 'node:fs'; fs.writeFileSync('changed.js', '')\"" } }
    expect(assessRouting(trace([implement, implemented, shell], children("medium")), ["medium"]).problems).toContain("primary used disallowed tools after delegation: shell")
  })

  it("counts trivial root calls from before events without double-counting after events", () => {
    const first = { phase: "before", tool: "read", sessionID: "root", id: "first" }
    const firstAfter = { phase: "after", tool: "read", sessionID: "root", id: "first", status: "completed" }
    const second = { phase: "before", tool: "grep", sessionID: "root", id: "second" }
    const secondAfter = { phase: "after", tool: "grep", sessionID: "root", id: "second", status: "completed" }
    expect(assessRouting(trace([first, firstAfter]), []).problems).toEqual([])
    expect(assessRouting(trace([first, firstAfter, second, secondAfter]), []).problems).toContain("trivial route used 2 primary tool calls (expected at most one)")
  })
})
