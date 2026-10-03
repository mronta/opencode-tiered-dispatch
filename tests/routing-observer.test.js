import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { pathToFileURL } from "node:url"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { routingObserverSource, seedRoutingFixture } from "../scripts/routing-eval.mjs"

async function waitForFile(pathname, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (existsSync(pathname)) return true
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  return false
}

function makeFixtureStub(control) {
  const countersPath = join(control, "fixture-calls.json")
  const modulePath = join(control, "fixture-stub.mjs")
  writeFileSync(countersPath, JSON.stringify({ restore: 0, verifier: 0 }))
  writeFileSync(modulePath, `
import { readFileSync, writeFileSync } from "node:fs"
const countersPath = ${JSON.stringify(countersPath)}
function bump(name) {
  const counters = JSON.parse(readFileSync(countersPath, "utf8"))
  counters[name] += 1
  writeFileSync(countersPath, JSON.stringify(counters))
}
export function checkFixture() { bump("verifier"); return [] }
export function diffRoutingSnapshots() { return [] }
export function resolveRoutingCommandDirectory() { return { root: undefined, directory: undefined, problems: [] } }
export function restoreRoutingFixture() { bump("restore") }
export function fingerprintRoutingWorkspace() { return {} }
export function snapshotRoutingCommandDirectory() { return { fingerprint: {}, problems: [] } }
export function snapshotInfrastructure() { return {} }
export function snapshotRoutingWorkspace() { return {} }
`)
  return {
    url: pathToFileURL(modulePath).href,
    counters() {
      return JSON.parse(readFileSync(countersPath, "utf8"))
    },
  }
}

function makeObserverHarness({ childTerminal = true, childMode = "orphan", nativeResult, scenarios, missingNativeField } = {}) {
  const workspace = mkdtempSync(join(tmpdir(), "routing-observer-lifecycle-"))
  const control = mkdtempSync(join(tmpdir(), "routing-observer-lifecycle-control-"))
  const paths = {
    marker: join(control, "ready"),
    result: join(control, "result.json"),
    failure: join(control, "failure.json"),
    progress: join(control, "progress.jsonl"),
    controlDirectory: control,
  }
  seedRoutingFixture(workspace)
  const fixture = makeFixtureStub(control)

  const contextHooks = []
  const toolHooks = new Map()
  const interrupts = []
  const getCalls = []
  const createCalls = []
  const childID = "uncorrelated-child"
  const states = new Map([
    ["root", { parentID: undefined, outcome: "succeeded", agent: "build", model: { providerID: "provider", id: "root" } }],
    [childID, { parentID: "root", outcome: childTerminal ? "succeeded" : undefined, agent: "medium", model: { providerID: "provider", id: "child" } }],
  ])

  function emitContext(sessionID, agent, model, system) {
    contextHooks[0]({ sessionID, agent, model, system, tools: {} })
  }

  const ctx = {
    location: { directory: workspace },
    session: {
      async hook(name, callback) {
        if (name === "context") contextHooks.push(callback)
        return { dispose: async () => {} }
      },
      async create(input) {
        createCalls.push(input)
        return { id: "root" }
      },
      async prompt() {
        emitContext("root", "build", { providerID: "provider", id: "root" }, [{ text: "Tiered Dispatch Protocol" }])
        const before = {
          sessionID: "root",
          messageID: "message-subagent",
          id: "subagent-1",
          tool: "subagent",
          agent: "build",
          input: { agent: "medium", prompt: "Reply with evidence." },
        }
        if (missingNativeField !== undefined) delete before[missingNativeField]
        if (nativeResult !== undefined) toolHooks.get("execute.before")?.(before)
        if (childMode !== "none") emitContext(childID, "medium", { providerID: "provider", id: "child" }, [])
        if (nativeResult !== undefined) {
          toolHooks.get("execute.after")?.({
            ...before,
            status: "completed",
            result: nativeResult,
          })
        }
      },
      async wait() {},
      async get({ sessionID }) {
        getCalls.push(sessionID)
        return states.get(sessionID)
      },
      async context() {
        return []
      },
      async interrupt({ sessionID }) {
        interrupts.push(sessionID)
        const state = states.get(sessionID)
        if (state !== undefined) state.outcome = "interrupted"
      },
    },
    tool: {
      async hook(name, callback) {
        toolHooks.set(name, callback)
        return { dispose: async () => {} }
      },
    },
  }

  const source = routingObserverSource(paths, { providerID: "provider", id: "root" }, {
    fixtureModule: fixture.url,
    scenarios: scenarios ?? [{ id: "trivial", text: "Reply with 4.", route: [], verificationCommands: [], allowedChanges: [] }],
  })
  const filename = join(control, "observer.mjs")
  return {
    workspace,
    control,
    paths,
    ctx,
    source,
    filename,
    interrupts,
    getCalls,
    createCalls,
    states,
    counters: fixture.counters,
    cleanup() {
      rmSync(workspace, { recursive: true, force: true })
      rmSync(control, { recursive: true, force: true })
    },
  }
}

async function loadObserver(harness) {
  writeFileSync(harness.filename, harness.source)
  const module = await import(`${harness.filename}?observer-test=${Date.now()}-${Math.random()}`)
  return module.default
}

const validNativeResult = {
  output: { sessionID: "uncorrelated-child", status: "completed", output: "done" },
  metadata: { sessionID: "uncorrelated-child", status: "completed" },
}

describe("routing observer session lifecycle", () => {
  it("accepts a strictly correlated child and passes the verifier once", async () => {
    const harness = makeObserverHarness({ childMode: "correlated", nativeResult: validNativeResult })
    try {
      const observer = await loadObserver(harness)
      const teardown = await observer.setup(harness.ctx)
      expect(await waitForFile(harness.paths.result)).toBe(true)
      await teardown()

      expect(harness.createCalls[0].permissions).toEqual([{ action: "external_directory", resource: "*", effect: "deny" }])
      expect(harness.counters()).toEqual({ restore: 1, verifier: 1 })
      const result = JSON.parse(readFileSync(harness.paths.result, "utf8"))
      expect(result[0].sessions.map((session) => session.sessionID)).toEqual(["root", "uncorrelated-child"])
      expect(harness.interrupts).toEqual([])
    } finally {
      harness.cleanup()
    }
  }, 15_000)

  it.each([
    ["missing structured output", { childMode: "correlated", nativeResult: { metadata: validNativeResult.metadata } }],
    ["mismatched structured metadata", { childMode: "correlated", nativeResult: { output: validNativeResult.output, metadata: { sessionID: "other-child", status: "completed" } } }],
    ["missing native identity field", { childMode: "correlated", nativeResult: validNativeResult, missingNativeField: "messageID" }],
    ["orphan child context", { childMode: "orphan", nativeResult: undefined }],
  ])("fails closed for %s before verifier or next reset", async (_label, options) => {
    const scenarios = [
      { id: "trivial", text: "Reply with 4.", route: [], verificationCommands: [], allowedChanges: [] },
      { id: "second", text: "Reply with 5.", route: [], verificationCommands: [], allowedChanges: [] },
    ]
    const harness = makeObserverHarness({ ...options, scenarios })
    try {
      const observer = await loadObserver(harness)
      const teardown = await observer.setup(harness.ctx)
      expect(await waitForFile(harness.paths.failure)).toBe(true)
      await teardown()

      const failure = JSON.parse(readFileSync(harness.paths.failure, "utf8"))
      expect(failure.message).toMatch(/native linkage gate failed before fixture verification/u)
      if (options.missingNativeField !== undefined) {
        expect(failure.message).toContain("native delegation medium did not complete")
      }
      expect(harness.counters()).toEqual({ restore: 1, verifier: 0 })
      expect(harness.interrupts).toEqual(expect.arrayContaining(["root", "uncorrelated-child"]))
      expect(harness.states.get("uncorrelated-child").outcome).toBe("interrupted")
      expect(existsSync(harness.paths.result)).toBe(false)
    } finally {
      harness.cleanup()
    }
  }, 15_000)

  it("interrupts an uncorrelated active child on terminal-wait teardown", async () => {
    const harness = makeObserverHarness({ childTerminal: false, childMode: "orphan" })
    try {
      const observer = await loadObserver(harness)
      const teardown = await observer.setup(harness.ctx)
      expect(await waitForFile(harness.paths.progress)).toBe(true)
      while (!readFileSync(harness.paths.progress, "utf8").includes('"phase":"terminal-session-check"')) {
        await new Promise((resolve) => setTimeout(resolve, 5))
      }
      await teardown()

      expect(harness.interrupts).toContain("uncorrelated-child")
      expect(existsSync(harness.paths.result)).toBe(false)
      expect(existsSync(harness.paths.failure)).toBe(true)
    } finally {
      harness.cleanup()
    }
  }, 15_000)
})
