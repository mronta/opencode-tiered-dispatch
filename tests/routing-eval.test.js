import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import {
  assessDirect,
  assessRouting,
  checkFixture,
  diffRoutingSnapshots,
  fingerprintRoutingWorkspace,
  restoreRoutingFixture,
  routingObserverSource,
  scenarios,
  seedRoutingFixture,
  snapshotInfrastructure,
  snapshotRoutingWorkspace,
  validateScenarioResultSet,
} from "../scripts/routing-eval.mjs"
import {
  enrichFailure,
  makeArtifact,
  parseNativeOptions,
  parseProgressJournal,
  selectScenarios,
} from "../scripts/opencode-native-smoke.mjs"

const MODELS = {
  fast: { model: "provider/fast", variant: "low" },
  medium: { model: "provider/medium", variant: "high" },
  heavy: { model: "provider/heavy", variant: "max" },
}

const WORKSPACE = "/tmp/routing-fixture"

function modelFor(agent) {
  const config = MODELS[agent]
  return { providerID: config.model.split("/")[0], id: config.model.split("/")[1], variant: config.variant }
}

function context(sessionID, agent, seq, { protocol = false, model = modelFor(agent), variant = model.variant } = {}) {
  return { seq, sessionID, agent, model, variant, hasProtocol: protocol, finalized: true }
}

function session(sessionID, agent, { parentID, model = agent === "build" ? { providerID: "provider", id: "root" } : modelFor(agent), outcome = "succeeded", text = "" } = {}) {
  return { sessionID, parentID, agent, model, outcome, text, usage: [] }
}

function toolEvent(phase, seq, id, input, extra = {}) {
  return {
    phase,
    seq,
    sessionID: "root",
    messageID: `message-${id}`,
    id,
    tool: "subagent",
    agent: "build",
    input,
    ...extra,
  }
}

function delegation(id, agent, childID, beforeSeq, output, options = {}) {
  const input = { agent, prompt: options.prompt ?? `Work in src/${agent}.js.` }
  if (options.sessionID !== undefined) input.sessionID = options.sessionID
  const before = toolEvent("before", beforeSeq, id, input)
  const completionSeq = options.completionSeq ?? beforeSeq + 2
  const outputStatus = options.status ?? "completed"
  const after = toolEvent("after", completionSeq, id, input, {
    status: "completed",
    result: {
      output: { sessionID: childID, status: outputStatus, output },
      metadata: options.metadata ?? { sessionID: childID, status: outputStatus },
    },
    resultOutput: { sessionID: childID, status: outputStatus, output },
    resultMetadata: options.metadata ?? { sessionID: childID, status: outputStatus },
    resultText: JSON.stringify({ output: { sessionID: childID, status: outputStatus, output } }),
  })
  return [before, after]
}

function shellCall(command, beforeSeq, options = {}) {
  const id = options.id ?? `shell-${beforeSeq}`
  const input = { command }
  if (options.cwd !== undefined) input.cwd = options.cwd
  if (options.workdir !== undefined) input.workdir = options.workdir
  const before = {
    phase: "before",
    seq: beforeSeq,
    sessionID: "root",
    messageID: `message-${id}`,
    id,
    tool: "shell",
    agent: "build",
    input,
  }
  const output = {
    output: options.output ?? "",
    truncated: options.truncated ?? false,
    status: options.outputStatus ?? "completed",
    ...(options.includeExit === false ? {} : { exit: options.exit ?? 0 }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.timeout === undefined ? {} : { timeout: options.timeout }),
  }
  const metadata = options.metadata ?? Object.fromEntries(["status", "exit", "signal", "timeout"]
    .filter((field) => Object.prototype.hasOwnProperty.call(output, field))
    .map((field) => [field, output[field]]))
  const after = {
    ...before,
    phase: "after",
    seq: options.afterSeq ?? beforeSeq + 1,
    status: options.status ?? "completed",
    result: { output, metadata },
    resultOutput: output,
    resultMetadata: metadata,
  }
  return [before, after]
}

function trace(id, tools, childSpecs = [], options = {}) {
  const childContexts = childSpecs.flatMap((child, index) => {
    const specs = child.contexts ?? [{ seq: child.contextSeq ?? 2 + index * 3, ...child.context }]
    return specs.map((spec) => context(child.id, child.agent, spec.seq, spec))
  })
  const childSessions = childSpecs.map((child) => session(child.id, child.agent, {
    parentID: child.parentID ?? "root",
    outcome: child.outcome ?? "succeeded",
    model: child.infoModel ?? modelFor(child.agent),
  }))
  const fixtureProblems = options.fixtureProblems ?? []
  const fingerprint = { "fixture/file.js": "sha256:" + "a".repeat(64) }
  const snapshotEvidence = options.snapshotEvidence ?? {
    baseline: fingerprint,
    execution: fingerprint,
    postVerifier: fingerprint,
    controlBaseline: fingerprint,
    controlPostVerifier: fingerprint,
    controlUnchanged: true,
  }
  const verificationSnapshots = options.verificationSnapshots ?? tools
    .filter((event) => event.phase === "before" && event.tool === "shell")
    .map((event) => ({
      identity: `${event.sessionID}/${event.messageID}/${event.id}/${event.tool}`,
      sessionID: event.sessionID,
      command: event.input?.command,
      before: fingerprint,
      after: fingerprint,
      changedFiles: [],
    }))
  return {
    id,
    workspace: WORKSPACE,
    rootSessionID: "root",
    elapsedMs: 100,
    tools,
    contexts: [context("root", "build", 0, { protocol: true, model: { providerID: "provider", id: "root" } }), ...childContexts],
    sessions: [session("root", "build", { model: { providerID: "provider", id: "root" } }), ...childSessions],
    fixtureProblems,
    fixtureVerification: options.fixtureVerification ?? {
      performed: true,
      clean: fixtureProblems.length === 0,
      problems: [...fixtureProblems],
      controlUnchanged: true,
    },
    snapshotEvidence,
    verificationSnapshots,
    ...options,
  }
}

function knownScopeTrace({ command = "node --test test/banner.test.js", cwd, workdir, status } = {}) {
  const delegationEvents = delegation("delegate-medium", "medium", "medium-child", 1, "Changed src/banner.js and test/banner.test.js.", { completionSeq: 3 })
  const shellEvents = shellCall(command, 5, { cwd, workdir, status })
  return trace("known-scope", [...delegationEvents, ...shellEvents], [{ id: "medium-child", agent: "medium", contextSeq: 2 }])
}

function implementationTrace(options = {}) {
  const discovery = delegation("discover", "fast", "fast-child", 1, "Validation belongs in src/controller.js and src/names/validate.js.", { completionSeq: 3 })
  const implementation = delegation("implement", "medium", "medium-child", 4, "Implemented validation.", {
    completionSeq: 6,
    prompt: options.prompt ?? "Change src/controller.js and test/names.test.js using src/names/validate.js.",
    sessionID: options.sessionID,
  })
  const shell = shellCall(options.command ?? "npm test", 8, { status: options.status })
  return trace("discover-implement", [...discovery, ...implementation, ...shell], [
    { id: "fast-child", agent: "fast", contextSeq: 2 },
    { id: "medium-child", agent: "medium", contextSeq: 5 },
  ])
}

describe("spontaneous routing assessment", () => {
  it("accepts realistic sequential native linkage and exact fixture verification", () => {
    expect(assessRouting(knownScopeTrace(), ["medium"], MODELS).problems).toEqual([])
  })

  it("accepts discovery evidence handed to implementation", () => {
    expect(assessRouting(implementationTrace(), ["fast", "medium"], MODELS).problems).toEqual([])
  })

  it("rejects dependent delegation that starts before the previous native call returns", () => {
    const discovery = delegation("discover", "fast", "fast-child", 1, "Validation belongs in src/controller.js.")
    const implementation = delegation("implement", "medium", "medium-child", 1, "Implemented.", {
      prompt: "Change src/controller.js using src/controller.js.",
    })
    const report = assessRouting(trace("discover-implement", [...discovery, ...implementation, ...shellCall("npm test", 5)], [
      { id: "fast-child", agent: "fast" },
      { id: "medium-child", agent: "medium" },
    ]), ["fast", "medium"], MODELS)
    expect(report.problems).toContain("recovery or execution began before the previous execution returned")
  })

  it("accepts direct trivial work with a single protocol context and no tools", () => {
    expect(assessRouting(trace("trivial", []), [], MODELS).problems).toEqual([])
  })

  it("accepts the direct control without a routing protocol or tier policy", () => {
    const result = trace("known-scope", shellCall("node --test test/banner.test.js", 1))
    result.contexts = [context("root", "build", 0, { protocol: false, model: { providerID: "provider", id: "root" } })]
    expect(assessDirect(result).problems).toEqual([])
  })

  it("can require the matched root model without weakening direct checks", () => {
    const result = trace("known-scope", shellCall("node --test test/banner.test.js", 1))
    result.contexts = [context("root", "build", 0, { protocol: false, model: { providerID: "provider", id: "wrong" }, variant: undefined })]
    const report = assessDirect(result, { rootModel: { providerID: "provider", id: "root" } })
    expect(report.problems).toContain("root execution context used an unexpected model or variant")
  })

  it("rejects direct delegation, extra sessions, failed tools, and a present protocol", () => {
    const result = trace("known-scope", [
      ...delegation("delegate-medium", "medium", "medium-child", 1, "Changed files."),
      ...shellCall("node --test test/banner.test.js", 3, { status: "error" }),
    ], [{ id: "medium-child", agent: "medium" }])
    result.contexts.find((entry) => entry.sessionID === "root").hasProtocol = true
    const report = assessDirect(result)
    expect(report.problems).toEqual(expect.arrayContaining([
      "direct baseline root execution context contained the routing protocol",
      "direct baseline used native delegation: medium",
      "direct baseline observed child execution context medium-child",
      "direct baseline observed child session medium-child",
      expect.stringContaining("failed tool completion"),
    ]))
  })

  it("rejects implementation-only execution of composite discovery work", () => {
    const events = delegation("implement", "medium", "medium-child", 1, "Implemented.")
    const report = assessRouting(trace("discover-implement", events, [{ id: "medium-child", agent: "medium" }]), ["fast", "medium"], MODELS)
    expect(report.problems).toContain("expected fast→medium (focused discovery/resume cycles allowed); observed medium")
  })

  it("requires a completed relevant delegation before exact verification", () => {
    const events = delegation("delegate-medium", "medium", "medium-child", 1, "Changed files.")
    const shell = shellCall("node --test test/banner.test.js", 0)
    const report = assessRouting(knownScopeTraceWith(events.concat(shell)), ["medium"], MODELS)
    expect(report.problems).toContain('verification command "node --test test/banner.test.js" did not follow a completed relevant delegation')
  })

  it("flags unknown commands exactly rather than applying a shell heuristic", () => {
    const report = assessRouting(knownScopeTrace({ command: "node --input-type=module -e \\\"console.log(1)\\\"" }), ["medium"], MODELS)
    expect(report.problems.some((problem) => problem.startsWith("unknown primary verification command:") && problem.includes("console.log(1)"))).toBe(true)
    expect(report.problems).toContain('expected exact fixture verification command was not observed: "node --test test/banner.test.js"')
  })

  it("matches a supplied verification workdir to the result workspace", () => {
    const report = assessRouting(knownScopeTrace({ workdir: "/elsewhere" }), ["medium"], MODELS)
    expect(report.problems).toContain('verification command "node --test test/banner.test.js" used workdir "/elsewhere" instead of result workspace "/tmp/routing-fixture"')
  })

  it("accepts a relative cwd that resolves to the fixture workspace", () => {
    expect(assessRouting(knownScopeTrace({ cwd: "." }), ["medium"], MODELS).problems).toEqual([])
  })

  it("rejects a cwd outside the fixture workspace", () => {
    const report = assessRouting(knownScopeTrace({ cwd: "../elsewhere" }), ["medium"], MODELS)
    expect(report.problems).toContain('verification command "node --test test/banner.test.js" used cwd "../elsewhere" instead of result workspace "/tmp/routing-fixture"')
  })

  it("rejects conflicting cwd and legacy workdir aliases", () => {
    const report = assessRouting(knownScopeTrace({ cwd: ".", workdir: "src" }), ["medium"], MODELS)
    expect(report.problems).toContain("verification command \"node --test test/banner.test.js\" cwd and workdir resolve to different directories: /tmp/routing-fixture and /tmp/routing-fixture/src")
  })

  it("rejects primary mutation tools even when they appear after delegation", () => {
    const delegationEvents = delegation("delegate-medium", "medium", "medium-child", 1, "Changed files.")
    const patch = {
      phase: "before", seq: 3, sessionID: "root", messageID: "message-patch", id: "patch", tool: "patch", agent: "build", input: {},
    }
    const patchAfter = { ...patch, phase: "after", seq: 4, status: "completed", result: {} }
    const report = assessRouting(trace("known-scope", [...delegationEvents, patch, patchAfter], [{ id: "medium-child", agent: "medium" }]), ["medium"], MODELS)
    expect(report.problems).toContain("primary used forbidden mutation tool: patch")
  })

  it("requires the complete tool identity tuple and one completion", () => {
    const events = delegation("delegate-medium", "medium", "medium-child", 1, "Changed files.")
    events[0].messageID = undefined
    events.splice(1, 1)
    events.push(delegation("missing", "medium", "other-child", 5, "never completed")[0])
    const report = assessRouting(trace("known-scope", events, [{ id: "medium-child", agent: "medium" }]), ["medium"], MODELS)
    expect(report.problems).toContain("tool subagent is missing identity fields: messageID")
    expect(report.problems.some((problem) => problem.startsWith("missing tool completion:"))).toBe(true)
  })

  it("rejects duplicate, orphan, and failed completions", () => {
    const events = delegation("delegate-medium", "medium", "medium-child", 1, "Changed files.")
    events.push({ ...events[1], seq: 4 })
    events.push({ ...events[1], id: "orphan", messageID: "message-orphan", seq: 5 })
    events.push({ ...events[1], id: "failed", messageID: "message-failed", seq: 6, status: "error" })
    const report = assessRouting(trace("known-scope", events, [{ id: "medium-child", agent: "medium" }]), ["medium"], MODELS)
    expect(report.problems.some((problem) => problem.startsWith("duplicate after tool call identity:"))).toBe(true)
    expect(report.problems.some((problem) => problem.startsWith("orphan tool completion:"))).toBe(true)
    expect(report.problems.some((problem) => problem.startsWith("failed tool completion:"))).toBe(true)
  })

  it("does not let session info model mask an invalid child execution context", () => {
    const result = knownScopeTrace()
    result.contexts.find((entry) => entry.sessionID === "medium-child").model = { providerID: "provider", id: "wrong", variant: "high" }
    result.sessions.find((entry) => entry.sessionID === "medium-child").infoModel = modelFor("medium")
    const report = assessRouting(result, ["medium"], MODELS)
    expect(report.problems).toContain("child execution context medium-child used an unexpected model or variant")
  })

  it("requires root protocol evidence and rejects protocol in every child context", () => {
    const result = knownScopeTrace()
    result.contexts.find((entry) => entry.sessionID === "medium-child").hasProtocol = true
    result.contexts.find((entry) => entry.sessionID === "root").hasProtocol = false
    const report = assessRouting(result, ["medium"], MODELS)
    expect(report.problems).toContain("root execution context did not contain the routing protocol")
    expect(report.problems).toContain("child execution context medium-child received the primary routing protocol")
  })

  it("uses structured native output for linkage and rejects prose-only results", () => {
    const result = knownScopeTrace()
    const completion = result.tools.find((event) => event.phase === "after" && event.tool === "subagent")
    completion.resultOutput = undefined
    completion.result = { content: "<subagent sessionID=medium-child>" }
    const report = assessRouting(result, ["medium"], MODELS)
    expect(report.problems).toContain("native delegation medium is missing structured result.output {sessionID,status,output}; resultText is not correlation evidence")
  })

  it("cross-checks native metadata and reports pending background evidence", () => {
    const result = knownScopeTrace()
    const completion = result.tools.find((event) => event.phase === "after" && event.tool === "subagent")
    completion.resultOutput.status = "running"
    completion.resultMetadata.status = "completed"
    const report = assessRouting(result, ["medium"], MODELS)
    expect(report.problems).toContain("native delegation medium returned pending/background status running; foreground evidence is unverifiable")
    expect(report.problems).toContain("native delegation medium has inconsistent result.metadata for child medium-child")
  })

  it("requires native metadata without losing otherwise valid output linkage", () => {
    const result = knownScopeTrace()
    const completion = result.tools.find((event) => event.phase === "after" && event.tool === "subagent")
    delete completion.result.metadata
    delete completion.resultMetadata
    const report = assessRouting(result, ["medium"], MODELS)
    expect(report.problems).toContain("native delegation medium is missing structured result.metadata for child medium-child")
    expect(report.problems).not.toContain("native delegation medium returned unobserved child session medium-child")
  })

  it.each([
    ["nonzero exit", { exit: 1 }, "result.output.exit was 1; expected 0"],
    ["missing exit", { includeExit: false }, "result.output.exit is missing; expected 0"],
    ["running output", { outputStatus: "running" }, "result.output.status was \"running\"; expected \"completed\""],
    ["signal", { signal: "SIGTERM" }, "result.output.signal was \"SIGTERM\"; expected no signal"],
    ["timeout", { timeout: true }, "result.output.timeout was true"],
    ["metadata mismatch", { metadata: { status: "completed", exit: 1 } }, "result.metadata.exit disagreed with result.output.exit"],
  ])("requires the authoritative native shell success shape (%s)", (_label, shellOptions, expectedProblem) => {
    const result = knownScopeTrace()
    const shell = result.tools.find((event) => event.phase === "after" && event.tool === "shell")
    const before = result.tools.find((event) => event.phase === "before" && event.tool === "shell")
    Object.assign(shell, shellCall(before.input.command, before.seq, shellOptions)[1])
    const report = assessRouting(result, ["medium"], MODELS)
    expect(report.problems).toContain(`verification command "node --test test/banner.test.js" ${expectedProblem}`)
  })

  it("allows direct arbitrary shell use while checking an exact command when one is reported", () => {
    const result = trace("known-scope", shellCall("grep -n banner src/banner.js", 1, { exit: 1 }))
    result.contexts = [context("root", "build", 0, { protocol: false, model: { providerID: "provider", id: "root" } })]
    expect(assessDirect(result).problems).toEqual([])
  })

  it("rejects isolated missing root, child context, failed outcome, and model metadata facts", () => {
    const missingRoot = knownScopeTrace()
    missingRoot.sessions = missingRoot.sessions.filter((entry) => entry.sessionID !== "root")
    expect(assessRouting(missingRoot, ["medium"], MODELS).problems).toContain("expected exactly one successful root session record")

    const missingChildContext = knownScopeTrace()
    missingChildContext.contexts = missingChildContext.contexts.filter((entry) => entry.sessionID !== "medium-child")
    expect(assessRouting(missingChildContext, ["medium"], MODELS).problems.some((problem) => problem.startsWith("native delegation medium returned child medium-child without an execution context"))).toBe(true)

    const failedChild = knownScopeTrace()
    failedChild.sessions.find((entry) => entry.sessionID === "medium-child").outcome = "failed"
    expect(assessRouting(failedChild, ["medium"], MODELS).problems).toContain("child session medium-child did not succeed")

    const metadataModelDisagreement = knownScopeTrace()
    metadataModelDisagreement.sessions.find((entry) => entry.sessionID === "medium-child").infoModel = { providerID: "provider", id: "wrong", variant: "high" }
    expect(assessRouting(metadataModelDisagreement, ["medium"], MODELS).problems).toContain("session metadata for medium-child used an unexpected model or variant")
  })

  it("requires fresh and resumed calls to identify the returned child session", () => {
    const first = delegation("first", "medium", "medium-child", 1, "first", { completionSeq: 3 })
    const second = delegation("resume", "medium", "medium-child", 4, "second", { sessionID: "medium-child", completionSeq: 6 })
    const result = trace("known-scope", [...first, ...second, ...shellCall("node --test test/banner.test.js", 8)], [{
      id: "medium-child",
      agent: "medium",
      contexts: [{ seq: 2 }, { seq: 5 }],
    }])
    expect(assessRouting(result, ["medium"], MODELS).problems).toEqual([])

    const invalid = trace("known-scope", [...first, ...delegation("bad-resume", "medium", "another-child", 4, "bad", { sessionID: "not-established", completionSeq: 6 }), ...shellCall("node --test test/banner.test.js", 8)], [
      { id: "medium-child", agent: "medium" },
      { id: "another-child", agent: "medium" },
    ])
    expect(assessRouting(invalid, ["medium"], MODELS).problems).toContain("native delegation medium resumed an unestablished child session not-established")

    const missingSecondContext = trace("known-scope", [...first, ...second, ...shellCall("node --test test/banner.test.js", 8)], [{
      id: "medium-child",
      agent: "medium",
      contexts: [{ seq: 2 }],
    }])
    expect(assessRouting(missingSecondContext, ["medium"], MODELS).problems).toContain("native delegation medium returned child medium-child without an execution context between dispatch 4 and completion 6")
  })

  it("rejects nested and uncorrelated child sessions", () => {
    const events = delegation("delegate-medium", "medium", "nested-child", 1, "Changed files.")
    const result = trace("known-scope", [...events, ...shellCall("node --test test/banner.test.js", 3)], [{ id: "nested-child", agent: "medium", parentID: "other" }])
    expect(assessRouting(result, ["medium"], MODELS).problems).toContain("native delegation medium returned nested or non-root child nested-child")
  })

  it("preserves verification and measurement fields without conflating elapsed time", () => {
    const result = knownScopeTrace()
    result.executionElapsedMs = 42
    result.verifierElapsedMs = 8
    result.harnessOverheadMs = 3
    result.sessions[0].usage = [{ tokens: { input: 1, output: 2, reasoning: 3, cache: { read: 4 } }, cost: 0.5, model: { providerID: "provider", id: "root" } }]
    const report = assessRouting(result, ["medium"], MODELS)
    expect(report).toMatchObject({ executionElapsedMs: 42, verifierElapsedMs: 8, harnessOverheadMs: 3, tokens: { input: 1, output: 2, reasoning: 3, cachedRead: 4 } })
  })

  it("preserves recorded fixture validation problems", () => {
    const result = trace("known-scope", knownScopeTrace().tools, [{ id: "medium-child", agent: "medium", contextSeq: 2 }], { fixtureProblems: ["validation failed"] })
    expect(assessRouting(result, ["medium"], MODELS).problems[0]).toBe("validation failed")
  })

  it("requires fixture validation and compact snapshot evidence", () => {
    const missingProblems = knownScopeTrace()
    delete missingProblems.fixtureProblems
    expect(assessRouting(missingProblems, ["medium"], MODELS).problems).toContain("fixture validation evidence is missing fixtureProblems")

    const missingVerification = knownScopeTrace()
    delete missingVerification.fixtureVerification
    expect(assessRouting(missingVerification, ["medium"], MODELS).problems).toContain("fixture validation evidence is missing fixtureVerification")

    const missingSnapshots = knownScopeTrace()
    delete missingSnapshots.snapshotEvidence
    expect(assessRouting(missingSnapshots, ["medium"], MODELS).problems).toContain("fixture validation evidence is missing snapshotEvidence")
  })

  it("detects verifier mutations from execution and post-verifier fingerprints", () => {
    const result = knownScopeTrace()
    result.snapshotEvidence.postVerifier = {
      ...result.snapshotEvidence.execution,
      "fixture/file.js": "sha256:" + "b".repeat(64),
    }
    const report = assessRouting(result, ["medium"], MODELS)
    expect(report.problems).toContain("snapshot evidence reports fixture verifier changes: fixture/file.js")
    expect(report.problems).toContain("fixture verification clean flag disagrees with recorded problems")
  })

  it("detects mutation during an exact primary verification invocation", () => {
    const result = knownScopeTrace()
    result.verificationSnapshots[0].after = {
      ...result.verificationSnapshots[0].before,
      "fixture/file.js": "sha256:" + "b".repeat(64),
    }
    result.verificationSnapshots[0].changedFiles = ["fixture/file.js"]
    const report = assessRouting(result, ["medium"], MODELS)
    expect(report.problems).toContain('verification command "node --test test/banner.test.js" changed fixture files: fixture/file.js')
  })

  it.each([
    ["missing before", (evidence) => { delete evidence.before }],
    ["empty before", (evidence) => { evidence.before = {} }],
    ["invalid before hash", (evidence) => { evidence.before = { "fixture/file.js": "sha256:not-a-hash" } }],
    ["empty after", (evidence) => { evidence.after = {} }],
    ["invalid after hash", (evidence) => { evidence.after = { "fixture/file.js": "sha256:not-a-hash" } }],
  ])("rejects %s per-command snapshot evidence", (_label, mutate) => {
    const result = knownScopeTrace()
    mutate(result.verificationSnapshots[0])
    const report = assessRouting(result, ["medium"], MODELS)
    expect(report.problems.some((problem) => problem.includes("snapshot evidence"))).toBe(true)
  })

  it("accepts a non-empty valid per-command snapshot baseline", () => {
    expect(assessRouting(knownScopeTrace(), ["medium"], MODELS).problems).toEqual([])
  })
})

describe("routing result and observer seams", () => {
  it("requires exactly one result for every known scenario", () => {
    const valid = scenarios.map((scenario) => ({ id: scenario.id }))
    expect(validateScenarioResultSet(valid)).toEqual([])
    expect(validateScenarioResultSet([...valid, { id: "known-scope" }])).toContain("duplicate scenario result: known-scope")
    expect(validateScenarioResultSet(valid.filter((result) => result.id !== "trivial"))).toContain("missing scenario result: trivial")
    expect(validateScenarioResultSet([...valid, { id: "surprise" }])).toContain("unexpected scenario result: surprise")
  })

  it("generates a parseable observer source with synchronous capture fields", () => {
    const source = routingObserverSource({
      marker: "/tmp/routing-marker",
      result: "/tmp/routing-result",
      failure: "/tmp/routing-failure",
      controlDirectory: "/tmp/routing-control",
    }, { providerID: "provider", id: "root" })
    expect(source).toContain("messageID: event.messageID")
    expect(source).toContain("cwd: compactText(input.cwd)")
    expect(source).toContain("resolveRoutingCommandDirectory")
    expect(source).toContain("resultOutput: phase === \"after\" ? clone(event.result?.output)")
    expect(source).toContain("appendFileSync(progressPath")
    expect(source).toContain("type: \"scenario-complete\"")
    expect(source).toContain("sessionGetWithTimeout")
    expect(source).toContain("sessionContextWithTimeout")
    const directory = mkdtempSync(join(tmpdir(), "routing-observer-source-"))
    const filename = join(directory, "observer.mjs")
    try {
      writeFileSync(filename, source)
      const check = spawnSync(process.execPath, ["--check", filename], { encoding: "utf8" })
      expect(check.status, check.stderr).toBe(0)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it.each(["tiered", "direct"])("adds the session-scoped external-directory deny to the %s fixture root", (arm) => {
    const source = routingObserverSource({
      marker: "/tmp/routing-marker",
      result: "/tmp/routing-result",
      failure: "/tmp/routing-failure",
      controlDirectory: "/tmp/routing-control",
    }, { providerID: "provider", id: "root" }, { arm })
    expect(source).toContain(`const arm = "${arm}"`)
    expect(source).toContain("const fixtureRootPermission = [{ permission: \"external_directory\", pattern: \"*\", action: \"deny\" }]")
    expect(source).toContain("permission: fixtureRootPermission")
  })

  it("retains completed scenarios and active native facts in a bounded timeout journal", () => {
    const completed = { id: "trivial", rootSessionID: "root-trivial", elapsedMs: 12 }
    const journal = [
      { type: "checkpoint", phase: "ready", scenarioID: null, rootSessionID: null, observedAt: 1 },
      { type: "scenario-complete", scenarioID: "trivial", rootSessionID: "root-trivial", result: completed, observedAt: 2 },
      { type: "checkpoint", phase: "wait", scenarioID: "known-scope", rootSessionID: "root-known", observedAt: 3 },
      { type: "context", phase: "context", scenarioID: "known-scope", rootSessionID: "root-known", sessionID: "root-known", seq: 7, agent: "build", observedAt: 4 },
      { type: "tool", phase: "before", scenarioID: "known-scope", rootSessionID: "root-known", sessionID: "root-known", messageID: "message-1", id: "tool-1", tool: "subagent", status: "running", observedAt: 5 },
    ].map((entry) => JSON.stringify(entry)).join("\n") + "\n"

    const progress = parseProgressJournal(journal)
    expect(progress).toMatchObject({
      phase: "wait",
      scenarioID: "known-scope",
      rootSessionID: "root-known",
      completedScenarioIDs: ["trivial"],
      activeContext: { sessionID: "root-known", agent: "build" },
      activeTool: { tool: "subagent", id: "tool-1" },
      partial: { scenarioID: "known-scope", rootSessionID: "root-known", tools: [{ id: "tool-1" }] },
    })
    expect(progress.completedResults).toEqual([completed])
    const timeout = new Error("native timeout")
    timeout.code = "NATIVE_SMOKE_TIMEOUT"
    expect(enrichFailure(timeout, undefined, progress, 123)).toMatchObject({
      kind: "timeout",
      timeoutMs: 123,
      phase: "wait",
      scenarioID: "known-scope",
      rootSessionID: "root-known",
    })
    expect(enrichFailure(timeout, undefined, progress, 123).hypothesis).toContain("does not by itself establish provider/model noncompliance")
    expect(makeArtifact({ arm: "tiered", rootModel: {}, tierModels: {}, startupMs: 17, timeoutMs: 123, reports: [], results: progress.completedResults, errors: ["timeout"], failure: {}, progress }).startupMs).toBe(17)
  })

  it("accepts an explicit positive native timeout without changing its default", () => {
    expect(parseNativeOptions(["--routing-eval", "--timeout-ms", "123"])).toMatchObject({ timeoutMs: 123 })
    expect(parseNativeOptions(["--routing-eval"]).timeoutMs).toBe(600_000)
    expect(() => parseNativeOptions(["--routing-eval", "--timeout-ms", "0"])).toThrow(/positive integer/u)
  })

  it("filters a targeted routing scenario and validates unknown scenario ids", () => {
    expect(parseNativeOptions(["--routing-eval", "--scenario", "discover-implement"])).toMatchObject({ scenario: "discover-implement" })
    expect(selectScenarios("discover-implement").map((scenario) => scenario.id)).toEqual(["discover-implement"])
    expect(() => parseNativeOptions(["--routing-eval", "--scenario", "missing"])).toThrow(/existing routing scenario/u)
  })

  it("restores the complete fixture while preserving immutable infrastructure", () => {
    const workspace = mkdtempSync(join(tmpdir(), "routing-fixture-isolation-"))
    try {
      mkdirSync(join(workspace, ".opencode", "plugins"), { recursive: true })
      writeFileSync(join(workspace, "opencode.jsonc"), "immutable\n")
      writeFileSync(join(workspace, ".opencode", "plugins", "observer.js"), "observer\n")
      seedRoutingFixture(workspace)
      const baseline = snapshotInfrastructure(workspace)
      writeFileSync(join(workspace, "unexpected.txt"), "provider edit")
      mkdirSync(join(workspace, "unexpected-empty"))
      restoreRoutingFixture(workspace, baseline)
      expect(existsSync(join(workspace, "unexpected.txt"))).toBe(false)
      expect(existsSync(join(workspace, "unexpected-empty"))).toBe(false)
      expect(readFileSync(join(workspace, "src", "banner.js"), "utf8")).toContain("return name")
      expect(diffRoutingSnapshots(baseline, snapshotInfrastructure(workspace))).toEqual([])
      const fingerprint = fingerprintRoutingWorkspace(workspace)
      expect(fingerprint["src/banner.js"]).toMatch(/^sha256:[a-f0-9]{64}$/u)
      expect(Object.values(snapshotRoutingWorkspace(workspace)).some((entry) => Object.hasOwn(entry, "content"))).toBe(false)
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  })

  it("passes a correct implementation through baseline and changed-limit verification", () => {
    const workspace = mkdtempSync(join(tmpdir(), "routing-verifier-isolation-"))
    const control = mkdtempSync(join(tmpdir(), "routing-verifier-control-"))
    try {
      seedRoutingFixture(workspace)
      writeFileSync(join(workspace, "src", "names", "validate.js"), "import { nameLimit } from '../settings.js'\nexport function validateName(name) { return { ok: name.length > 0 && name.length <= nameLimit, name, limit: nameLimit } }\n")
      expect(checkFixture(workspace, "discover-implement", process.execPath, { verifierDirectory: control })).toEqual([])
      expect(existsSync(join(workspace, "routing-limit-loader.mjs"))).toBe(false)
    } finally {
      rmSync(workspace, { recursive: true, force: true })
      rmSync(control, { recursive: true, force: true })
    }
  })

  it("reports a hardcoded configured limit only in the changed-limit run", () => {
    const workspace = mkdtempSync(join(tmpdir(), "routing-verifier-isolation-"))
    const control = mkdtempSync(join(tmpdir(), "routing-verifier-control-"))
    try {
      seedRoutingFixture(workspace)
      writeFileSync(join(workspace, "src", "names", "validate.js"), "import { nameLimit } from '../settings.js'\nexport function validateName(name) { return { ok: name.length > 0 && name.length <= 12, name, limit: nameLimit } }\n")
      const before = snapshotRoutingWorkspace(workspace)
      const problems = checkFixture(workspace, "discover-implement", process.execPath, { verifierDirectory: control })
      const after = snapshotRoutingWorkspace(workspace)
      expect(problems).toHaveLength(1)
      expect(problems[0]).toContain("changed-limit behavior (limit 11) failed:")
      expect(problems[0]).not.toContain("did not load expected configured limit")
      expect(diffRoutingSnapshots(before, after)).toEqual([])
      expect(existsSync(join(workspace, "routing-limit-loader.mjs"))).toBe(false)
    } finally {
      rmSync(workspace, { recursive: true, force: true })
      rmSync(control, { recursive: true, force: true })
    }
  })

  it("rejects an implementation that does not return the complete result shape", () => {
    const workspace = mkdtempSync(join(tmpdir(), "routing-verifier-shape-"))
    const control = mkdtempSync(join(tmpdir(), "routing-verifier-shape-control-"))
    try {
      seedRoutingFixture(workspace)
      writeFileSync(join(workspace, "src", "names", "validate.js"), "import { nameLimit } from '../settings.js'\nexport function validateName(name) { return { ok: name.length > 0 && name.length <= nameLimit } }\n")
      const problems = checkFixture(workspace, "discover-implement", process.execPath, { verifierDirectory: control })
      expect(problems.some((problem) => problem.startsWith("fixture behavior failed:"))).toBe(true)
      expect(problems.some((problem) => problem.includes("changed-limit behavior"))).toBe(true)
    } finally {
      rmSync(workspace, { recursive: true, force: true })
      rmSync(control, { recursive: true, force: true })
    }
  })
})

function knownScopeTraceWith(events) {
  return trace("known-scope", events, [{ id: "medium-child", agent: "medium" }])
}
