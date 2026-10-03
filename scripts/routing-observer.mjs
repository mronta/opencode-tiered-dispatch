import { routingLinkageHelperSource } from "./routing-linkage.mjs"

/**
 * Generate the plugin used by the routing evaluator.  The generated code is
 * intentionally an observer: it records native events and runs the fixture's
 * external verifier, but it never rewrites prompts or chooses a tier.
 */
export function buildRoutingObserverSource({ paths, model, scenarios, arm = "tiered", hideRootSubagent = false, fixtureModule = new URL("./routing-fixture.mjs", import.meta.url).href, nodeBinary = process.execPath }) {
  const controlDirectory = paths.controlDirectory ?? paths.control ?? new URL(".", `file://${paths.result}`).pathname
  return `
import { appendFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import {
  checkFixture,
  diffRoutingSnapshots,
  resolveRoutingCommandDirectory,
  restoreRoutingFixture,
  fingerprintRoutingWorkspace,
  snapshotRoutingCommandDirectory,
  snapshotInfrastructure,
  snapshotRoutingWorkspace,
} from ${JSON.stringify(fixtureModule)}
 ${routingLinkageHelperSource()}

const markerPath = ${JSON.stringify(paths.marker)}
const resultPath = ${JSON.stringify(paths.result)}
const failurePath = ${JSON.stringify(paths.failure)}
const controlDirectory = ${JSON.stringify(controlDirectory)}
const progressPath = ${JSON.stringify(paths.progress)} ?? join(controlDirectory, "scenario.progress.jsonl")
const rootModel = ${JSON.stringify(model)}
const nodeBinary = ${JSON.stringify(nodeBinary)}
const scenarios = ${JSON.stringify(scenarios)}
const arm = ${JSON.stringify(arm)}
const hideRootSubagent = ${JSON.stringify(hideRootSubagent)}
const fixtureRootPermissions = [{ action: "external_directory", resource: "*", effect: "deny" }]

function clone(value) {
  if (value === undefined) return undefined
  try { return structuredClone(value) } catch { return value }
}

function resultText(value) {
  try { return JSON.stringify(value) } catch { return String(value) }
}

function compactText(value, limit = 512) {
  if (value === undefined || value === null) return undefined
  const text = typeof value === "string" ? value : (resultText(value) ?? String(value))
  return text.length <= limit ? text : text.slice(0, limit) + "…"
}

function compactToolInput(tool, input) {
  if (input === undefined || input === null) return undefined
  if (tool === "subagent") {
    return {
      agent: input.agent,
      sessionID: input.sessionID,
      prompt: compactText(input.prompt),
    }
  }
  if (tool === "shell") {
    return {
      command: compactText(input.command),
      cwd: compactText(input.cwd),
      workdir: compactText(input.workdir),
    }
  }
  return { keys: Object.keys(input).slice(0, 32) }
}

function compactToolResult(result) {
  const output = result?.output
  if (output === undefined && result?.metadata === undefined) return undefined
  return {
    sessionID: output?.sessionID ?? result?.metadata?.sessionID,
    status: output?.status ?? result?.metadata?.status,
    metadata: result?.metadata === undefined ? undefined : {
      sessionID: result.metadata?.sessionID,
      status: result.metadata?.status,
    },
    output: compactText(output?.output),
    exit: output?.exit,
    signal: output?.signal,
    timeout: output?.timeout,
  }
}

function writeProgress(entry) {
  try {
    appendFileSync(progressPath, JSON.stringify({ schemaVersion: 1, ...entry }) + "\\n")
  } catch (error) {
    process.stderr.write("routing observer progress journal unavailable: " + (error?.message ?? String(error)) + "\\n")
  }
}

function fingerprintChanges(before, after) {
  return [...new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])]
    .filter((path) => before?.[path] !== after?.[path])
    .sort()
}

function protocolIn(system) {
  return Array.isArray(system) && system.some((part) => String(part?.text ?? "").includes("Tiered Dispatch Protocol"))
}

function assistantMessages(messages, executionModel) {
  return messages
    .filter((message) => message.type === "assistant")
    .map((message) => {
      const hasMessageModel = message.model !== undefined && message.model !== null
      const hasExecutionModel = executionModel !== undefined && executionModel !== null
      return {
        messageID: message.id,
        text: (message.content ?? []).filter((part) => part.type === "text").map((part) => part.text).join("\\n"),
        tokens: message.tokens,
        cost: message.cost,
        // session.model is the execution context. info.model is selected
        // configuration metadata and must not be presented as observed usage
        // when the message carries no actual model.
        model: hasMessageModel ? message.model : executionModel,
        modelProvenance: hasMessageModel
          ? "message"
          : (hasExecutionModel ? "execution-context" : "unknown"),
      }
    })
}

function textFromUsage(usage) {
  return usage.map((entry) => entry.text).filter(Boolean).join("\\n")
}

async function flushObserver() {
  await new Promise((resolve) => setImmediate(resolve))
  await new Promise((resolve) => setImmediate(resolve))
}

async function requestWithTimeout(operation, timeout, message) {
  let timer
  try {
    return await Promise.race([
      Promise.resolve().then(operation),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), Math.max(1, timeout))
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

async function sessionGetWithTimeout(ctx, sessionID, timeout) {
  return requestWithTimeout(() => ctx.session.get({ sessionID }), timeout, "session inspection timed out")
}

async function sessionContextWithTimeout(ctx, sessionID, timeout) {
  return requestWithTimeout(() => ctx.session.context({ sessionID }), timeout, "session context inspection timed out")
}

function absoluteChangedFiles(workspace, before, after) {
  return diffRoutingSnapshots(before, after).map((path) => join(workspace, path))
}

function changedConstraintProblems(scenario, workspace, changedFiles) {
  const changedRelative = changedFiles.map((path) => path.slice(workspace.length + 1))
  if (scenario.id === "known-scope") {
    const allowed = new Set(scenario.allowedChanges ?? [])
    const unrelated = changedRelative.filter((path) => !allowed.has(path))
    if (unrelated.length > 0) return ["known-scope edit changed unrelated files: " + unrelated.join(", ")]
  }
  if (scenario.id === "discover-analyze" && changedRelative.length > 0) {
    return ["analysis modified fixture files despite no-edit request: " + changedRelative.join(", ")]
  }
  return []
}

function pendingDispatches(toolEvents) {
  return toolEvents.filter((event) => event.phase === "after" && event.tool === "subagent" && event.status === "completed" && event.resultOutput?.status === "running")
}

async function inspectSessions(ctx, sessionIDs, contextRecords, shouldStop = () => false) {
  const sessions = []
  for (const sessionID of [...new Set(sessionIDs)]) {
    let info
    let messages = []
    let inspectionError
    if (shouldStop()) {
      sessions.push({ sessionID, inspectionError: "observer cleanup was requested before inspection" })
      continue
    }
    try {
      info = await sessionGetWithTimeout(ctx, sessionID, 5_000)
      messages = await sessionContextWithTimeout(ctx, sessionID, 5_000)
    } catch (error) {
      inspectionError = error?.message ?? String(error)
    }
    const records = contextRecords.filter((record) => record.sessionID === sessionID && record.finalized)
    const context = records[0]
    const usage = info === undefined ? [] : assistantMessages(messages, context?.model)
    sessions.push({
      sessionID,
      parentID: info?.parentID,
      outcome: info?.outcome,
      cost: typeof info?.cost === "number" && Number.isFinite(info.cost) ? info.cost : undefined,
      tokens: clone(info?.tokens),
      agent: context?.agent,
      model: clone(context?.model),
      variant: context?.variant,
      infoAgent: info?.agent,
      infoModel: clone(info?.model),
      inspectionError,
      text: textFromUsage(usage),
      usage,
    })
  }
  return sessions
}

async function waitForTerminalSessions(ctx, sessionIDs, shouldStop = () => false, additionalSessionIDs = () => []) {
  const observed = new Set([...sessionIDs].filter((sessionID) => typeof sessionID === "string" && sessionID.length > 0))
  const deadline = Date.now() + 5_000
  let latest = []
  while (Date.now() < deadline) {
    for (const sessionID of additionalSessionIDs()) {
      if (typeof sessionID === "string" && sessionID.length > 0) observed.add(sessionID)
    }
    latest = []
    for (const sessionID of observed) {
      if (shouldStop()) throw new Error("routing observer cleanup was requested during terminal-session checks")
      const remaining = deadline - Date.now()
      if (remaining <= 0) {
        latest.push(sessionID)
        continue
      }
      try {
        // The old deadline only bounded the loop; a stalled native session
        // lookup could block this await forever and prevent failure output.
        const info = await sessionGetWithTimeout(ctx, sessionID, remaining)
        if (!info?.outcome) latest.push(sessionID)
      } catch {
        latest.push(sessionID)
      }
    }
    if (latest.length === 0) {
      // Allow synchronous context hooks and one queued native event to land
      // before declaring the set terminal.  A child observed in this quiet
      // window must be included before verifier work or fixture reset.
      await flushObserver()
      const beforeSize = observed.size
      for (const sessionID of additionalSessionIDs()) {
        if (typeof sessionID === "string" && sessionID.length > 0) observed.add(sessionID)
      }
      if (observed.size === beforeSize) return
      continue
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error("background native sessions remained alive before verifier checks: " + resultText(latest))
}

function toolErrorMetrics(toolEvents, workspace, rootSessionID) {
  const after = toolEvents.filter((event) => event.phase === "after")
  const errors = after.filter((event) => event.status !== "completed")
  const timeouts = after.filter((event) => {
    const output = event.resultOutput ?? event.result?.output
    return output?.timeout === true
  })
  const nonzeroShellExits = after.filter((event) => {
    if (event.tool !== "shell") return false
    const output = event.resultOutput ?? event.result?.output
    return typeof output?.exit === "number" && Number.isFinite(output.exit) && output.exit !== 0
  })
  const deniedExternalReads = errors.filter((event) => {
    if (event.tool !== "read") return false
    const candidate = event.input?.filePath ?? event.input?.path ?? event.input?.filename
    const outside = typeof candidate === "string"
      && candidate.startsWith("/")
      && candidate !== workspace
      && !candidate.startsWith(workspace + "/")
    const detail = [event.errorText, resultText(event.resultOutput), resultText(event.resultMetadata)].filter(Boolean).join(" ")
    return outside && /permission|denied|external[ _-]?directory|ask/i.test(detail)
  })
  const byTool = {}
  for (const event of errors) byTool[event.tool] = (byTool[event.tool] ?? 0) + 1
  const nonzeroShellExitBySession = {}
  const nonzeroShellExitByRole = { root: 0, child: 0 }
  for (const event of nonzeroShellExits) {
    nonzeroShellExitBySession[event.sessionID] = (nonzeroShellExitBySession[event.sessionID] ?? 0) + 1
    const role = event.sessionID === rootSessionID ? "root" : "child"
    nonzeroShellExitByRole[role] += 1
  }
  return {
    // total and byTool retain their historical hook-status meaning.
    total: errors.length,
    hookErrorCount: errors.length,
    hookErrors: errors.length,
    timeoutCount: timeouts.length,
    timeouts: timeouts.length,
    byTool,
    deniedExternalReadCount: deniedExternalReads.length,
    otherErrorCount: errors.length - deniedExternalReads.length,
    deniedExternalReadIdentities: deniedExternalReads.map(toolIdentity).filter((identity) => identity !== undefined),
    nonzeroShellExitCount: nonzeroShellExits.length,
    nonzeroShellExitBySession,
    nonzeroShellExitByRole,
    nonzeroShellExitIdentities: nonzeroShellExits.map(toolIdentity).filter((identity) => identity !== undefined),
  }
}

export default {
  id: "tiered-routing-eval",
  async setup(ctx) {
    const tools = []
    const contexts = []
    const registrations = []
    const verificationSnapshots = []
    const activeSessions = new Set()
    const inspectedSessions = []
    let currentScenarioSessionIDs
    let progressState = {
      phase: "setup",
      scenarioID: null,
      rootSessionID: null,
      contextSeq: null,
      toolSeq: null,
      observedAt: Date.now(),
    }
    let sequence = 0
    let stopping = false
    let continuation
    let cleanupPromise

    function cleanupActiveSessions() {
      cleanupPromise ??= (async () => {
        const attempted = new Set()
        const errors = []
        while (true) {
          const pending = [...activeSessions].filter((sessionID) => !attempted.has(sessionID))
          if (pending.length === 0) {
            // A native interrupt can synchronously flush one last context or
            // completion event.  Give that event a turn before declaring
            // cleanup complete, otherwise a late child could survive into
            // the next scenario.
            await flushObserver()
            if ([...activeSessions].some((sessionID) => !attempted.has(sessionID))) continue
            break
          }
          for (const sessionID of pending) {
            attempted.add(sessionID)
            try {
              await requestWithTimeout(() => ctx.session.interrupt({ sessionID, resume: false }), 5_000, "session interrupt timed out during observer cleanup")
            } catch (error) {
              errors.push({ sessionID, message: error?.message ?? String(error) })
            }
          }
        }
        return errors
      })()
      return cleanupPromise
    }

    function checkpoint(phase, fields = {}) {
      progressState = {
        ...progressState,
        ...fields,
        phase,
        observedAt: Date.now(),
      }
      writeProgress({ type: "checkpoint", ...progressState })
    }

    registrations.push(await ctx.session.hook("context", (event) => {
      if (arm === "direct" && hideRootSubagent && event.agent === "build" && event.tools !== undefined) {
        // The direct control must not accidentally become a child-session run
        // because an unrelated global build-agent config exposed subagent.
        // This observer remains an independent .opencode/plugins plugin; it
        // does not change the tiered arm or the plugin under measurement.
        delete event.tools.subagent
      }
      if (typeof event.sessionID === "string" && event.sessionID.length > 0) {
        activeSessions.add(event.sessionID)
        currentScenarioSessionIDs?.add(event.sessionID)
      }
      const record = { seq: sequence++, observedAt: Date.now(), sessionID: event.sessionID, finalized: false }
      contexts.push(record)
      // The sequence is assigned in the hook, while final fields are delayed
      // until every synchronous plugin transform has had its turn.
      setImmediate(() => {
        record.agent = event.agent
        record.model = clone(event.model)
        record.variant = event.variant ?? event.model?.variant
        record.hasProtocol = protocolIn(event.system)
        record.toolNames = Object.keys(event.tools ?? {})
        record.finalized = true
        progressState = { ...progressState, contextSeq: record.seq }
        writeProgress({
          type: "context",
          observedAt: record.observedAt,
          scenarioID: progressState.scenarioID,
          rootSessionID: progressState.rootSessionID,
          seq: record.seq,
          sessionID: record.sessionID,
          agent: record.agent,
          model: clone(record.model),
          variant: record.variant,
          hasProtocol: record.hasProtocol,
          toolNames: record.toolNames,
        })
      })
    }))
    for (const phase of ["before", "after"]) {
      registrations.push(await ctx.tool.hook("execute." + phase, (event) => {
        if (typeof event.sessionID === "string" && event.sessionID.length > 0) {
          activeSessions.add(event.sessionID)
          currentScenarioSessionIDs?.add(event.sessionID)
        }
        const structuredChildID = event.result?.output?.sessionID
        if (phase === "after" && typeof structuredChildID === "string" && structuredChildID.length > 0) {
          activeSessions.add(structuredChildID)
          currentScenarioSessionIDs?.add(structuredChildID)
        }
        if (event.tool === "shell") {
          const identity = toolIdentity(event)
          if (identity !== undefined && phase === "before") {
            const observation = snapshotRoutingCommandDirectory(event.input, ctx.location.directory)
            verificationSnapshots.push({
              identity,
              sessionID: event.sessionID,
              command: clone(event.input?.command),
              before: observation.fingerprint,
              beforeProblems: observation.problems,
            })
          } else if (identity !== undefined) {
            const snapshot = [...verificationSnapshots].reverse().find((candidate) => candidate.identity === identity && candidate.after === undefined)
            if (snapshot !== undefined) {
              const observation = snapshotRoutingCommandDirectory(event.input, ctx.location.directory)
              snapshot.after = observation.fingerprint
              snapshot.afterProblems = observation.problems
              snapshot.snapshotProblems = [...(snapshot.beforeProblems ?? []), ...(snapshot.afterProblems ?? [])]
              if (snapshot.before !== undefined && snapshot.after !== undefined) {
                snapshot.changedFiles = fingerprintChanges(snapshot.before, snapshot.after)
              }
            }
          }
        }
        const record = {
          seq: sequence++,
          phase,
          observedAt: Date.now(),
          sessionID: event.sessionID,
          messageID: event.messageID,
          id: event.id,
          tool: event.tool,
          agent: event.agent,
          input: clone(event.input),
          status: event.status,
          result: phase === "after" ? clone(event.result) : undefined,
          resultOutput: phase === "after" ? clone(event.result?.output) : undefined,
          resultMetadata: phase === "after" ? clone(event.result?.metadata) : undefined,
          resultText: phase === "after" ? resultText(event.result) : undefined,
          errorText: phase === "after" && event.status === "error" ? resultText(event.error) : undefined,
        }
        tools.push(record)
        progressState = { ...progressState, toolSeq: record.seq }
        writeProgress({
          type: "tool",
          phase,
          observedAt: record.observedAt,
          scenarioID: progressState.scenarioID,
          rootSessionID: progressState.rootSessionID,
          seq: record.seq,
          sessionID: record.sessionID,
          messageID: record.messageID,
          id: record.id,
          tool: record.tool,
          agent: record.agent,
          input: compactToolInput(record.tool, record.input),
          status: record.status,
          result: phase === "after" ? compactToolResult(event.result) : undefined,
          error: record.errorText === undefined ? undefined : compactText(record.errorText),
        })
      }))
    }

    const infrastructureBaseline = snapshotInfrastructure(ctx.location.directory)
    checkpoint("ready")
    writeFileSync(markerPath, "ready")
    continuation = new Promise((resolveContinuation) => setImmediate(() => void (async () => {
      const results = []
      try {
        for (const scenario of scenarios) {
          if (stopping) throw new Error("routing observer cleanup was requested before scenario start")
          checkpoint("scenario-start", { scenarioID: scenario.id, rootSessionID: null, contextSeq: null, toolSeq: null })
          // A context observed after the previous result was written is an
          // orphan until proven terminal.  Settle it before touching the
          // fixture for the next scenario; never reset underneath a live
          // native session.
          if (activeSessions.size > 0) {
            checkpoint("pre-reset-session-check", { scenarioID: scenario.id })
            await waitForTerminalSessions(ctx, [...activeSessions], () => stopping, () => [...activeSessions])
            activeSessions.clear()
          }
          checkpoint("fixture-reset", { scenarioID: scenario.id })
          // Never restore while a detached child could still be reading or
          // writing the fixture. A pending result stops the run below.
          restoreRoutingFixture(ctx.location.directory, infrastructureBaseline)
          const before = snapshotRoutingWorkspace(ctx.location.directory)
          const baselineFingerprint = fingerprintRoutingWorkspace(ctx.location.directory)
          const toolStart = tools.length
          const contextStart = contexts.length
          const verificationSnapshotStart = verificationSnapshots.length
          const totalStart = Date.now()
          const executionStart = Date.now()
          checkpoint("session-create", { scenarioID: scenario.id })
          const scenarioSessionIDs = new Set()
          currentScenarioSessionIDs = scenarioSessionIDs
          const root = await ctx.session.create({
            title: "[routing eval] " + scenario.id,
            agent: "build",
            model: rootModel,
            location: { directory: ctx.location.directory },
            permissions: fixtureRootPermissions,
          })
          activeSessions.add(root.id)
          scenarioSessionIDs.add(root.id)
          checkpoint("prompt", { scenarioID: scenario.id, rootSessionID: root.id })
          await ctx.session.prompt({ sessionID: root.id, text: scenario.text })
          if (stopping) throw new Error("routing observer cleanup was requested after root prompt")
          checkpoint("wait", { scenarioID: scenario.id, rootSessionID: root.id })
          await ctx.session.wait({ sessionID: root.id })
          if (stopping) throw new Error("routing observer cleanup was requested after root wait")
          const executionElapsedMs = Date.now() - executionStart
          const executionFinishedAt = Date.now()
          checkpoint("wait-complete", { scenarioID: scenario.id, rootSessionID: root.id, executionElapsedMs })
          await flushObserver()

          const scenarioTools = tools.slice(toolStart)
          const outputSessionIDs = scenarioTools
            .filter((event) => event.phase === "after" && event.tool === "subagent" && event.resultOutput?.sessionID)
            .map((event) => event.resultOutput.sessionID)
          for (const sessionID of outputSessionIDs) activeSessions.add(sessionID)
          for (const sessionID of outputSessionIDs) scenarioSessionIDs.add(sessionID)
          const pending = pendingDispatches(scenarioTools)
          if (pending.length > 0) {
            throw new Error("pending/background native delegation is unverifiable; stopping before fixture reset: " + resultText(pending))
          }
          checkpoint("terminal-session-check", { scenarioID: scenario.id, rootSessionID: root.id })
          await waitForTerminalSessions(ctx, [root.id, ...outputSessionIDs], () => stopping, () => [...scenarioSessionIDs])
          if (stopping) throw new Error("routing observer cleanup was requested after terminal-session checks")

          const scenarioContextRecords = contexts.slice(contextStart)
          const sessionIDs = [root.id, ...outputSessionIDs, ...scenarioSessionIDs, ...scenarioContextRecords.map((event) => event.sessionID)]
          checkpoint("session-inspection", { scenarioID: scenario.id, rootSessionID: root.id })
          const sessions = await inspectSessions(ctx, sessionIDs, scenarioContextRecords, () => stopping)
          inspectedSessions.push(...clone(sessions))
          if (stopping) throw new Error("routing observer cleanup was requested during session inspection")
          const inspectionProblems = sessions
            .filter((session) => session.inspectionError !== undefined && session.inspectionError !== null)
            .map((session) => "session " + session.sessionID + " has inspectionError: " + session.inspectionError)
          const unresolvedSessions = sessions.filter((session) => !session.outcome)
          if (inspectionProblems.length > 0) {
            throw new Error("native session inspection failed before fixture verification: " + resultText(inspectionProblems))
          }
          if (unresolvedSessions.length > 0) {
            throw new Error("native sessions did not reach a terminal outcome before fixture verification: " + resultText(unresolvedSessions.map((session) => session.sessionID)))
          }
          const nativeDispatches = scenarioTools
            .filter((event) => event.phase === "before" && event.sessionID === root.id && event.tool === "subagent")
            .sort((left, right) => (sequenceOf(left) ?? Number.POSITIVE_INFINITY) - (sequenceOf(right) ?? Number.POSITIVE_INFINITY))
          const linkageGate = validateNativeLinkage({
            dispatches: nativeDispatches,
            tools: scenarioTools,
            sessions,
            contexts: scenarioContextRecords,
            rootSessionID: root.id,
            requireCompleted: true,
            validateTierModels: false,
          })
          const nativeToolProblems = validateNativeToolEvidence(scenarioTools, root.id)
          const nativeGateProblems = [...new Set([...linkageGate.problems, ...nativeToolProblems])]
          if (nativeGateProblems.length > 0) {
            throw new Error("native linkage gate failed before fixture verification: " + resultText(nativeGateProblems))
          }

          const afterExecution = snapshotRoutingWorkspace(ctx.location.directory)
          const executionFingerprint = fingerprintRoutingWorkspace(ctx.location.directory)
          const verificationStart = Date.now()
          checkpoint("fixture-verification", { scenarioID: scenario.id, rootSessionID: root.id })
          const controlBefore = snapshotRoutingWorkspace(controlDirectory)
          const controlBaselineFingerprint = fingerprintRoutingWorkspace(controlDirectory)
          const fixtureProblems = checkFixture(ctx.location.directory, scenario.id, nodeBinary, { verifierDirectory: controlDirectory })
          const controlAfter = snapshotRoutingWorkspace(controlDirectory)
          const controlPostVerifierFingerprint = fingerprintRoutingWorkspace(controlDirectory)
          const afterVerifier = snapshotRoutingWorkspace(ctx.location.directory)
          const postVerifierFingerprint = fingerprintRoutingWorkspace(ctx.location.directory)
          const verifierElapsedMs = Date.now() - verificationStart
          const changedFiles = absoluteChangedFiles(ctx.location.directory, before, afterExecution)
          const verifierChangedFiles = absoluteChangedFiles(ctx.location.directory, afterExecution, afterVerifier)
          fixtureProblems.push(...changedConstraintProblems(scenario, ctx.location.directory, changedFiles))
          if (verifierChangedFiles.length > 0) fixtureProblems.push("fixture verifier changed workspace files: " + verifierChangedFiles.join(", "))
          const verifierControlChanges = diffRoutingSnapshots(controlBefore, controlAfter)
          if (verifierControlChanges.length > 0) fixtureProblems.push("fixture verifier changed control files: " + verifierControlChanges.join(", "))
          const executionInfrastructureChanges = diffRoutingSnapshots(infrastructureBaseline, snapshotInfrastructure(ctx.location.directory))
          if (executionInfrastructureChanges.length > 0) fixtureProblems.push("immutable infrastructure changed during execution: " + executionInfrastructureChanges.join(", "))
          if (executionInfrastructureChanges.length > 0) {
            throw new Error("immutable routing infrastructure changed; stopping evaluation: " + executionInfrastructureChanges.join(", "))
          }

          const scenarioVerificationSnapshots = verificationSnapshots.slice(verificationSnapshotStart).map((snapshot) => ({
            identity: snapshot.identity,
            sessionID: snapshot.sessionID,
            command: snapshot.command,
            before: snapshot.before,
            after: snapshot.after,
            beforeProblems: snapshot.beforeProblems,
            afterProblems: snapshot.afterProblems,
            snapshotProblems: snapshot.snapshotProblems,
            changedFiles: snapshot.changedFiles,
          }))
          for (const snapshot of scenarioVerificationSnapshots) {
            if (snapshot.sessionID === root.id && Array.isArray(snapshot.changedFiles) && snapshot.changedFiles.length > 0) {
              fixtureProblems.push("primary verification command changed fixture files: " + snapshot.changedFiles.join(", "))
            }
          }
          const snapshotEvidence = {
            baseline: baselineFingerprint,
            execution: executionFingerprint,
            postVerifier: postVerifierFingerprint,
            controlBaseline: controlBaselineFingerprint,
            controlPostVerifier: controlPostVerifierFingerprint,
            controlUnchanged: verifierControlChanges.length === 0,
          }
          const fixtureVerification = {
            performed: true,
            clean: fixtureProblems.length === 0,
            problems: [...fixtureProblems],
            controlUnchanged: verifierControlChanges.length === 0,
          }

           const rootEvent = scenarioContextRecords.find((event) => event.sessionID === root.id)
          const elapsedMs = Date.now() - totalStart
          const harnessOverheadMs = Math.max(0, elapsedMs - executionElapsedMs - verifierElapsedMs)
          const scenarioResult = {
            id: scenario.id,
            workspace: ctx.location.directory,
            rootSessionID: root.id,
            elapsedMs,
            executionElapsedMs,
            executionStartedAt: executionStart,
            executionFinishedAt,
            verifierElapsedMs,
            harnessOverheadMs,
            tools: clone(scenarioTools),
            contexts: clone(contexts.slice(contextStart)),
            sessions,
            rootSessionPermissions: clone(fixtureRootPermissions),
            toolErrorMetrics: toolErrorMetrics(scenarioTools, ctx.location.directory, root.id),
            changedFiles,
            verifierChangedFiles,
            verifierControlChangedFiles: verifierControlChanges,
            fixtureProblems,
            fixtureVerification,
            snapshotEvidence,
            verificationSnapshots: scenarioVerificationSnapshots,
            rootContextSeq: rootEvent?.seq,
            rawTrace: {
              tools: clone(scenarioTools),
              contexts: clone(contexts.slice(contextStart)),
              sessions: clone(sessions),
              rootSessionPermissions: clone(fixtureRootPermissions),
              toolErrorMetrics: clone(toolErrorMetrics(scenarioTools, ctx.location.directory, root.id)),
              fixtureProblems: clone(fixtureProblems),
              fixtureVerification: clone(fixtureVerification),
              snapshotEvidence: clone(snapshotEvidence),
              verificationSnapshots: clone(scenarioVerificationSnapshots),
            },
          }
          results.push(scenarioResult)
          checkpoint("scenario-complete", {
            scenarioID: scenario.id,
            rootSessionID: root.id,
            elapsedMs,
            executionElapsedMs,
            verifierElapsedMs,
            harnessOverheadMs,
          })
          writeProgress({
            type: "scenario-complete",
            observedAt: Date.now(),
            scenarioID: scenario.id,
            rootSessionID: root.id,
            result: clone(scenarioResult),
          })
          activeSessions.delete(root.id)
          for (const sessionID of scenarioSessionIDs) activeSessions.delete(sessionID)
          if (currentScenarioSessionIDs === scenarioSessionIDs) currentScenarioSessionIDs = undefined
        }
        if (stopping) throw new Error("routing observer cleanup was requested before result write")
        checkpoint("complete", { scenarioID: null, rootSessionID: null, completedScenarioCount: results.length })
        writeFileSync(resultPath, JSON.stringify(results))
      } catch (error) {
        const failedFrom = { ...progressState }
        stopping = true
        checkpoint("failure", {
          error: compactText(error?.message ?? String(error)),
          failedFromPhase: failedFrom.phase,
          failedFromScenarioID: failedFrom.scenarioID,
          failedFromRootSessionID: failedFrom.rootSessionID,
        })
        writeFileSync(failurePath, JSON.stringify({
          message: error?.message ?? String(error),
          stack: error?.stack,
          arm,
          phase: failedFrom.phase,
          scenarioID: failedFrom.scenarioID,
          rootSessionID: failedFrom.rootSessionID,
          results,
          tools: clone(tools),
          contexts: clone(contexts),
          sessions: clone(inspectedSessions),
          cleanupErrors: await cleanupActiveSessions(),
        }))
      } finally {
        resolveContinuation()
      }
    })()))

    return async () => {
      stopping = true
      await cleanupActiveSessions()
      if (continuation !== undefined) {
        try { await Promise.race([continuation, new Promise((resolve) => setTimeout(resolve, 5_000))]) } catch {}
      }
      for (const registration of [...registrations].reverse()) {
        try {
          await requestWithTimeout(() => registration.dispose(), 5_000, "observer registration disposal timed out")
        } catch {}
      }
    }
  },
}
`
}
