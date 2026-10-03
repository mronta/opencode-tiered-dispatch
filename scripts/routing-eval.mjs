import { createHash } from "node:crypto"
import { buildRoutingObserverSource } from "./routing-observer.mjs"
import {
  FIXTURE_MANIFEST,
  checkFixture,
  diffRoutingSnapshots,
  fixtureRelativeFiles,
  fingerprintRoutingWorkspace,
  resolveRoutingCommandDirectory,
  restoreRoutingFixture,
  seedRoutingFixture,
  snapshotInfrastructure,
  snapshotRoutingWorkspace,
} from "./routing-fixture.mjs"

const READ_TOOLS = new Set(["read", "glob", "grep", "webfetch", "websearch"])
const PRIMARY_POST_DELEGATION_TOOLS = new Set(["subagent", "skill", ...READ_TOOLS])
const PRIMARY_MUTATION_TOOLS = new Set(["patch", "edit", "write"])

export const scenarios = Object.freeze([
  Object.freeze({ id: "trivial", text: "What is 2 + 2? Reply with just the number.", route: [], verificationCommands: [], allowedChanges: [] }),
  Object.freeze({
    id: "known-scope",
    text: "In src/banner.js change banner(name) from `return name` to return the template literal `Hello, ${name}!`; keep the exported signature. Update test/banner.test.js to assert banner('Ada') is 'Hello, Ada!' and run node --test test/banner.test.js. No other files need changing.",
    route: ["medium"],
    verificationCommands: ["node --test test/banner.test.js"],
    allowedChanges: ["src/banner.js", "test/banner.test.js"],
  }),
  Object.freeze({
    id: "discover-implement",
    text: "Find how display names travel through this app and where their validation belongs. Reject blank names after trimming and names longer than the configured limit after trimming; preserve the existing result shape. Add regression tests and run npm test.",
    route: ["fast", "medium"],
    verificationCommands: ["npm test"],
    allowedChanges: undefined,
  }),
  Object.freeze({
    id: "discover-analyze",
    text: "Map the authentication trust boundaries and assess whether the login flow is safe against replay and forged identity. Recommend a migration strategy with trade-offs and cite concrete file evidence. Do not edit files.",
    route: ["fast", "heavy"],
    verificationCommands: [],
    allowedChanges: [],
  }),
])

export {
  FIXTURE_MANIFEST,
  checkFixture,
  diffRoutingSnapshots,
  fixtureRelativeFiles,
  fingerprintRoutingWorkspace,
  resolveRoutingCommandDirectory,
  restoreRoutingFixture,
  seedRoutingFixture,
  snapshotInfrastructure,
  snapshotRoutingWorkspace,
}

/**
 * Keep the generated observer separate from the assessment logic while
 * retaining the original public helper used by the smoke harness.
 */
export function routingObserverSource(paths, model, options = {}) {
  return buildRoutingObserverSource({ paths, model, scenarios, ...options })
}

/**
 * Validate the result set before looking up scenarios.  `Array.find` alone
 * silently accepts duplicates, missing records, and provider-added records;
 * none of those are safe evidence for an aggregate evaluation.
 */
export function validateScenarioResultSet(results, expectedScenarios = scenarios) {
  const problems = []
  if (!Array.isArray(results)) return ["scenario result set is not an array"]

  const expectedIDs = expectedScenarios.map((scenario) => scenario.id)
  const expectedSet = new Set(expectedIDs)
  if (expectedSet.size !== expectedIDs.length) problems.push("expected scenario set contains duplicate ids")

  const counts = new Map()
  for (const result of results) {
    const id = result?.id
    counts.set(id, (counts.get(id) ?? 0) + 1)
    if (!expectedSet.has(id)) problems.push(`unexpected scenario result: ${String(id)}`)
  }
  for (const id of expectedIDs) {
    const count = counts.get(id) ?? 0
    if (count === 0) problems.push(`missing scenario result: ${id}`)
    if (count > 1) problems.push(`duplicate scenario result: ${id}`)
  }
  return problems
}

export function assessDirect(result, options = {}) {
  return assessRouting(result, [], undefined, { ...options, arm: "direct" })
}

export function assessRouting(result, expectedRoute = [], tierModels, options = {}) {
  const arm = options.arm ?? options.mode ?? "tiered"
  const problems = []
  const tools = Array.isArray(result?.tools) ? result.tools : []
  const sessions = Array.isArray(result?.sessions) ? result.sessions : []
  const contexts = Array.isArray(result?.contexts) ? result.contexts : []
  const rootSessionID = result?.rootSessionID
  const scenario = scenarios.find((candidate) => candidate.id === result?.id)

  problems.push(...validateFixtureEvidence(result))

  const sessionEvidence = validateSessionEvidence({ result, sessions, contexts, rootSessionID, tierModels, rootModel: options.rootModel, arm })
  problems.push(...sessionEvidence.problems)

  const toolEvidence = validateToolEvidence(tools)
  problems.push(...toolEvidence.problems)
  problems.push(...validateGlobalSequence(contexts, tools))

  const dispatches = toolEvidence.before
    .filter((event) => event.sessionID === rootSessionID && event.tool === "subagent")
    .sort(compareSequence)
  const allSubagentCalls = toolEvidence.before.filter((event) => event.tool === "subagent")
  for (const event of allSubagentCalls) {
    if (event.sessionID !== rootSessionID) {
      problems.push(`nested or unattributed native delegation from session ${String(event.sessionID)}`)
    }
  }

  const route = dispatches.map((event) => event.input?.agent)
  if (!matchesRoute(route, expectedRoute)) {
    problems.push(`expected ${expectedRoute.join("→") || "direct"} (focused discovery/resume cycles allowed); observed ${route.join("→") || "direct"}`)
  }

  if (arm === "direct") {
    if (dispatches.length > 0) {
      problems.push(`direct baseline used native delegation: ${dispatches.map((event) => String(event.input?.agent)).join(", ")}`)
    }
    problems.push(...assessDirectToolUse({ result, scenario, tools, dispatches, toolEvidence }))
    problems.push(...assessVerificationCommands({ result, scenario, expectedRoute, dispatches, toolEvidence, arm }))
  } else {
    const linkage = assessNativeLinkage({
      result,
      dispatches,
      toolEvidence,
      sessions,
      contexts,
      rootSessionID,
      tierModels,
    })
    problems.push(...linkage.problems)

    problems.push(...assessHandoffEvidence(dispatches, toolEvidence, linkage.completions))
    problems.push(...assessPrimaryToolUse({ result, scenario, expectedRoute, tools, dispatches, toolEvidence }))
    problems.push(...assessVerificationCommands({ result, scenario, expectedRoute, dispatches, toolEvidence, arm }))
  }

  const usage = sessions.flatMap((session) => session.usage ?? [])
  const tokenUsage = usage.filter((entry) => entry?.tokens)
  const tokens = tokenUsage.length === 0 ? null : tokenUsage.reduce((total, entry) => {
    for (const key of ["input", "output", "reasoning"]) total[key] += entry.tokens[key] ?? 0
    total.cachedRead += entry.tokens.cache?.read ?? 0
    return total
  }, { input: 0, output: 0, reasoning: 0, cachedRead: 0 })

  const readCalls = toolEvidence.before.filter((event) => READ_TOOLS.has(event.tool))
  const primaryReads = readCalls.filter((event) => event.sessionID === rootSessionID)
  const readFingerprints = readCalls.map((event) => `${event.tool}:${JSON.stringify(event.input)}`)
  const repeatedReads = readFingerprints.length - new Set(readFingerprints).size
  const primaryToolCalls = toolEvidence.before.filter((event) => event.sessionID === rootSessionID)
  const firstDispatch = dispatches[0]
  const readsBeforeDispatch = primaryReads.filter((event) => firstDispatch === undefined || sequenceOf(event) < sequenceOf(firstDispatch)).length

  return {
    id: result?.id,
    route,
    elapsedMs: result?.elapsedMs,
    executionElapsedMs: result?.executionElapsedMs,
    verifierElapsedMs: result?.verifierElapsedMs,
    harnessOverheadMs: result?.harnessOverheadMs,
    primaryReadCount: primaryReads.length,
    readsBeforeDispatch,
    repeatedReads,
    toolCalls: toolEvidence.before.length,
    problems,
    tokens,
  }
}

/**
 * Fixture checks are evidence, not an optional annotation.  Keep this
 * validation shared by the direct control and the tiered arm so a missing
 * verifier result cannot make either arm look successful.
 */
export function validateFixtureEvidence(result) {
  const problems = []
  const fixtureProblems = result?.fixtureProblems
  if (!Array.isArray(fixtureProblems)) {
    problems.push("fixture validation evidence is missing fixtureProblems")
  } else {
    problems.push(...fixtureProblems)
  }

  const verification = result?.fixtureVerification
  const snapshotEvidence = result?.snapshotEvidence
  const derivedProblems = []
  let normalizedSnapshots

  if (!isRecord(verification)) {
    problems.push("fixture validation evidence is missing fixtureVerification")
  } else {
    if (verification.performed !== true) problems.push("fixture verifier did not explicitly report performed=true")
    if (!Array.isArray(verification.problems)) {
      problems.push("fixture verification evidence is missing its problems array")
    } else if (Array.isArray(fixtureProblems) && !sameJSON(verification.problems, fixtureProblems)) {
      problems.push("fixture verification problems disagree with fixtureProblems")
    }
    if (typeof verification.clean !== "boolean") problems.push("fixture verification evidence is missing its clean flag")
    if (typeof verification.controlUnchanged !== "boolean") problems.push("fixture verification evidence is missing controlUnchanged")
  }

  if (!isRecord(snapshotEvidence)) {
    problems.push("fixture validation evidence is missing snapshotEvidence")
  } else {
    const stages = {
      baseline: snapshotEvidence.baseline ?? snapshotEvidence.baselineFingerprint,
      execution: snapshotEvidence.execution ?? snapshotEvidence.executionFingerprint,
      postVerifier: snapshotEvidence.postVerifier ?? snapshotEvidence.postVerifierFingerprint,
      controlBaseline: snapshotEvidence.controlBaseline ?? snapshotEvidence.controlBaselineFingerprint,
      controlPostVerifier: snapshotEvidence.controlPostVerifier ?? snapshotEvidence.controlPostVerifierFingerprint,
    }
    normalizedSnapshots = {}
    for (const [name, manifest] of Object.entries(stages)) {
      const normalized = normalizeFingerprintManifest(manifest, `snapshotEvidence.${name}`, problems)
      if (normalized !== undefined) normalizedSnapshots[name] = normalized
    }

    if (typeof snapshotEvidence.controlUnchanged !== "boolean") {
      problems.push("snapshot evidence is missing controlUnchanged")
    } else if (normalizedSnapshots.controlBaseline !== undefined && normalizedSnapshots.controlPostVerifier !== undefined) {
      const controlChanges = diffFingerprintManifests(normalizedSnapshots.controlBaseline, normalizedSnapshots.controlPostVerifier)
      const expectedUnchanged = controlChanges.length === 0
      if (snapshotEvidence.controlUnchanged !== expectedUnchanged) {
        problems.push("snapshot evidence controlUnchanged disagrees with control fingerprints")
      }
      if (!expectedUnchanged && !hasProblemPrefix(fixtureProblems, "fixture verifier changed control files:")) {
        derivedProblems.push(`snapshot evidence reports changed control files: ${controlChanges.join(", ")}`)
      }
    }

    if (normalizedSnapshots.execution !== undefined && normalizedSnapshots.postVerifier !== undefined) {
      const verifierChanges = diffFingerprintManifests(normalizedSnapshots.execution, normalizedSnapshots.postVerifier)
      if (verifierChanges.length > 0 && !hasProblemPrefix(fixtureProblems, "fixture verifier changed workspace files:")) {
        derivedProblems.push(`snapshot evidence reports fixture verifier changes: ${verifierChanges.join(", ")}`)
      }
    }

    if (isRecord(verification) && typeof verification.controlUnchanged === "boolean" && typeof snapshotEvidence.controlUnchanged === "boolean" && verification.controlUnchanged !== snapshotEvidence.controlUnchanged) {
      problems.push("fixture verification controlUnchanged disagrees with snapshot evidence")
    }
  }

  problems.push(...derivedProblems)
  if (isRecord(verification) && typeof verification.clean === "boolean") {
    const expectedClean = Array.isArray(fixtureProblems) && fixtureProblems.length === 0 && derivedProblems.length === 0
    if (verification.clean !== expectedClean) problems.push("fixture verification clean flag disagrees with recorded problems")
  }
  return problems
}

function normalizeFingerprintManifest(value, label, problems) {
  if (!isRecord(value)) {
    problems.push(`${label} is missing a fingerprint manifest`)
    return undefined
  }
  const normalized = {}
  const entries = Object.entries(value)
  if (entries.length === 0) problems.push(`${label} fingerprint manifest is empty`)
  for (const [path, entry] of entries) {
    if (path.startsWith("/") || path.includes("\\")) problems.push(`${label} contains a non-relative path: ${path}`)
    const fingerprint = normalizeFingerprintEntry(entry)
    if (fingerprint === undefined) {
      problems.push(`${label} contains an invalid fingerprint for ${path}`)
    } else {
      normalized[path] = fingerprint
    }
  }
  return normalized
}

function normalizeFingerprintEntry(entry) {
  if (typeof entry === "string") {
    if (/^sha256:[a-f0-9]{64}$/u.test(entry)) return entry
    if (entry === "directory" || /^symlink-sha256:[a-f0-9]{64}$/u.test(entry)) return entry
    return undefined
  }
  // Accept the raw compact snapshot shape too, but never accept serialized
  // file contents in an observation.
  if (!isRecord(entry) || Object.prototype.hasOwnProperty.call(entry, "content")) return undefined
  if (entry.type === "file" && typeof entry.hash === "string" && /^[a-f0-9]{64}$/u.test(entry.hash)) return `sha256:${entry.hash}`
  if (entry.type === "directory") return "directory"
  if (entry.type === "symlink" && typeof entry.target === "string" && entry.target.length > 0) return `symlink-sha256:${createHash("sha256").update(entry.target).digest("hex")}`
  return undefined
}

function diffFingerprintManifests(before, after) {
  return [...new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])]
    .filter((path) => before?.[path] !== after?.[path])
    .sort()
}

function hasProblemPrefix(problems, prefix) {
  return Array.isArray(problems) && problems.some((problem) => typeof problem === "string" && problem.startsWith(prefix))
}

function sameJSON(left, right) {
  return JSON.stringify(left) === JSON.stringify(right)
}

function validateSessionEvidence({ result, sessions, contexts, rootSessionID, tierModels, rootModel, arm }) {
  const problems = []
  const sessionByID = new Map()
  for (const session of sessions) {
    const id = session?.sessionID
    if (typeof id !== "string" || id.length === 0) {
      problems.push("session evidence contains a record without a sessionID")
      continue
    }
    if (sessionByID.has(id)) problems.push(`duplicate session record: ${id}`)
    else sessionByID.set(id, session)
  }

  const rootRecords = sessions.filter((session) => session?.sessionID === rootSessionID)
  if (rootRecords.length !== 1 || rootRecords[0]?.outcome !== "succeeded") {
    problems.push("expected exactly one successful root session record")
  }

  const rootContexts = contexts.filter((context) => context?.sessionID === rootSessionID)
  if (rootContexts.length === 0) {
    problems.push("primary routing protocol context was not observed")
  } else if (arm === "direct") {
    if (!rootContexts.every((context) => context.hasProtocol === false)) {
      problems.push("direct baseline root execution context contained the routing protocol")
    }
  } else if (!rootContexts.some((context) => context.hasProtocol === true)) {
    problems.push("primary routing protocol was not observed in the final root execution context")
  }

  const contextIDs = new Set()
  for (const context of contexts) {
    if (!Number.isInteger(context?.seq)) problems.push(`execution context ${String(context?.sessionID)} is missing its synchronous sequence`)
    const id = context?.sessionID
    if (typeof id !== "string" || id.length === 0) {
      problems.push("execution context is missing sessionID")
      continue
    }
    contextIDs.add(id)
    if (!sessionByID.has(id)) problems.push(`observed execution context ${id} has no session record`)

    if (id === rootSessionID) {
      if (rootModel !== undefined && !matchesTierModel(context.model, rootModel, context.variant)) {
        problems.push("root execution context used an unexpected model or variant")
      }
      if (arm === "direct") {
        if (context.hasProtocol !== false) problems.push("direct baseline root execution context did not explicitly omit the routing protocol")
      } else if (context.hasProtocol !== true) {
        problems.push("root execution context did not contain the routing protocol")
      }
      continue
    }

    if (arm === "direct") {
      problems.push(`direct baseline observed child execution context ${id}`)
      continue
    }

    if (context.hasProtocol === true) problems.push(`child execution context ${id} received the primary routing protocol`)
    else if (context.hasProtocol !== false) problems.push(`child execution context ${id} is missing an explicit no-protocol observation`)
    const expected = tierModels?.[context.agent]
    if (expected === undefined) {
      problems.push(`child execution context ${id} used unknown tier ${String(context.agent)}`)
    } else if (!matchesTierModel(context.model, expected, context.variant)) {
      problems.push(`child execution context ${id} used an unexpected model or variant`)
    }
  }

  for (const session of sessions) {
    const id = session?.sessionID
    if (id === rootSessionID) {
      if (session.parentID !== undefined && session.parentID !== null) problems.push(`root session ${id} unexpectedly has parent ${session.parentID}`)
      continue
    }
    if (typeof id !== "string") continue
    if (arm === "direct") {
      problems.push(`direct baseline observed child session ${id}`)
      continue
    }
    if (!contextIDs.has(id)) problems.push(`observed child session ${id} has no execution context`)
    if (session.parentID !== rootSessionID) problems.push(`child session ${id} is nested or not owned by root ${String(rootSessionID)}`)
    const context = contexts.find((candidate) => candidate.sessionID === id)
    if (context !== undefined && session.agent !== undefined && session.agent !== context.agent) {
      problems.push(`session info for ${id} disagrees with its execution context agent`)
    }
    if (session.infoAgent !== undefined && context !== undefined && session.infoAgent !== context.agent) {
      problems.push(`session metadata for ${id} disagrees with its execution context agent`)
    }
    const expectedModel = tierModels?.[context?.agent ?? session.agent]
    if (expectedModel !== undefined && session.model !== undefined && !matchesTierModel(session.model, expectedModel, session.variant)) {
      problems.push(`session info for ${id} used an unexpected model or variant`)
    }
    if (expectedModel !== undefined && session.infoModel !== undefined && !matchesTierModel(session.infoModel, expectedModel, session.variant)) {
      problems.push(`session metadata for ${id} used an unexpected model or variant`)
    }
    if (session.outcome !== "succeeded") problems.push(`child session ${id} did not succeed`)
  }

  if (result?.workspace !== undefined && typeof result.workspace !== "string") {
    problems.push("result workspace is not a string")
  }
  return { problems, sessionByID }
}

function validateToolEvidence(tools) {
  const problems = []
  const before = []
  const after = []
  const beforeByIdentity = new Map()
  const afterByIdentity = new Map()
  const seenSequences = new Set()

  for (const event of tools) {
    const phase = event?.phase
    if (phase !== "before" && phase !== "after") {
      problems.push(`tool event has unknown phase: ${String(phase)}`)
      continue
    }
    if (!Number.isInteger(event.seq)) problems.push(`tool ${String(event.tool)} is missing its synchronous sequence`)
    else if (seenSequences.has(event.seq)) problems.push(`duplicate tool sequence: ${event.seq}`)
    else seenSequences.add(event.seq)

    const missing = ["sessionID", "messageID", "id", "tool"].filter((field) => typeof event[field] !== "string" || event[field].length === 0)
    if (missing.length > 0) {
      problems.push(`tool ${String(event.tool)} is missing identity fields: ${missing.join(", ")}`)
      continue
    }
    const identity = toolIdentity(event)
    const target = phase === "before" ? beforeByIdentity : afterByIdentity
    if (target.has(identity)) problems.push(`duplicate ${phase} tool call identity: ${identity}`)
    else target.set(identity, event)
    ;(phase === "before" ? before : after).push(event)
  }

  for (const event of after) {
    const identity = toolIdentity(event)
    const start = beforeByIdentity.get(identity)
    if (start === undefined) {
      problems.push(`orphan tool completion: ${identity}`)
    } else if (sequenceOf(event) <= sequenceOf(start)) {
      problems.push(`tool completion preceded its call: ${identity}`)
    }
    if (event.status !== "completed") problems.push(`failed tool completion: ${identity} (${String(event.status)})`)
  }
  for (const event of before) {
    if (!afterByIdentity.has(toolIdentity(event))) problems.push(`missing tool completion: ${toolIdentity(event)}`)
  }

  return { problems, before, after, beforeByIdentity, afterByIdentity }
}

function validateGlobalSequence(contexts, tools) {
  const problems = []
  const seen = new Set()
  for (const event of [...contexts, ...tools]) {
    if (!Number.isInteger(event?.seq)) continue
    if (seen.has(event.seq)) problems.push(`duplicate observed sequence across context/tool events: ${event.seq}`)
    else seen.add(event.seq)
  }
  return problems
}

function assessNativeLinkage({ result, dispatches, toolEvidence, sessions, contexts, rootSessionID, tierModels }) {
  const problems = []
  const completions = new Map()
  const sessionByID = new Map(sessions.filter((session) => typeof session?.sessionID === "string").map((session) => [session.sessionID, session]))
  const contextsByID = new Map()
  for (const context of contexts) {
    if (!contextsByID.has(context?.sessionID)) contextsByID.set(context?.sessionID, [])
    contextsByID.get(context?.sessionID).push(context)
  }

  const established = new Map()
  const linkedSessionIDs = new Set()
  let previousDelegation
  for (const dispatch of dispatches) {
    const identity = toolIdentity(dispatch)
    const completion = toolEvidence.afterByIdentity.get(identity)
    if (completion !== undefined) completions.set(identity, completion)
    const agent = dispatch.input?.agent
    if (typeof agent !== "string") problems.push(`native delegation ${identity} did not specify an agent`)
    if (tierModels?.[agent] === undefined) problems.push(`native delegation ${identity} used unknown tier ${String(agent)}`)

    if (previousDelegation !== undefined && sequenceOf(dispatch) < sequenceOf(previousDelegation.completion ?? previousDelegation.dispatch)) {
      problems.push("recovery or execution began before the previous execution returned")
    }

    if (completion === undefined) {
      problems.push(`native delegation ${String(agent)} did not complete`)
      continue
    }
    if (completion.status !== "completed") continue

    const structured = completion.resultOutput ?? completion.result?.output
    const metadata = completion.resultMetadata ?? completion.result?.metadata
    if (!isRecord(structured) || typeof structured.sessionID !== "string" || structured.sessionID.length === 0 || !["completed", "running"].includes(structured.status) || typeof structured.output !== "string") {
      problems.push(`native delegation ${String(agent)} is missing structured result.output {sessionID,status,output}; resultText is not correlation evidence`)
      continue
    }
    if (structured.status === "running") {
      problems.push(`native delegation ${String(agent)} returned pending/background status running; foreground evidence is unverifiable`)
    }
    if (!isRecord(metadata)) {
      problems.push(`native delegation ${String(agent)} is missing structured result.metadata for child ${structured.sessionID}`)
    } else if (metadata.sessionID !== structured.sessionID || metadata.status !== structured.status) {
      problems.push(`native delegation ${String(agent)} has inconsistent result.metadata for child ${structured.sessionID}`)
    }

    const inputSessionID = dispatch.input?.sessionID
    const childID = structured.sessionID
    const existingOwner = established.get(childID)
    if (inputSessionID !== undefined) {
      if (typeof inputSessionID !== "string" || inputSessionID.length === 0) {
        problems.push(`native delegation ${String(agent)} supplied an invalid continuation sessionID`)
      } else if (!established.has(inputSessionID)) {
        problems.push(`native delegation ${String(agent)} resumed an unestablished child session ${inputSessionID}`)
      } else if (established.get(inputSessionID) !== agent) {
        problems.push(`native delegation ${String(agent)} resumed child ${inputSessionID} owned by tier ${String(established.get(inputSessionID))}`)
      } else if (inputSessionID !== childID) {
        problems.push(`native delegation ${String(agent)} returned child ${childID} for continuation ${inputSessionID}`)
      }
    } else if (existingOwner !== undefined) {
      problems.push(`native delegation ${String(agent)} reused child session ${childID} without explicit continuation linkage`)
    }

    const session = sessionByID.get(childID)
    if (session === undefined) {
      problems.push(`native delegation ${String(agent)} returned unobserved child session ${childID}`)
    } else {
      if (session.parentID !== rootSessionID) problems.push(`native delegation ${String(agent)} returned nested or non-root child ${childID}`)
      const childContexts = contextsByID.get(childID) ?? []
      const dispatchSequence = sequenceOf(dispatch)
      const completionSequence = sequenceOf(completion)
      const relevantContexts = childContexts.filter((context) => Number.isInteger(context?.seq)
        && context.seq > dispatchSequence
        && context.seq < completionSequence)
      if (relevantContexts.length === 0) {
        problems.push(`native delegation ${String(agent)} returned child ${childID} without an execution context between dispatch ${dispatchSequence} and completion ${completionSequence}`)
      }
      for (const context of relevantContexts) {
        if (context.agent !== agent) problems.push(`native delegation ${String(agent)} correlated to child ${childID} with context agent ${String(context.agent)}`)
        if (!matchesTierModel(context.model, tierModels?.[agent], context.variant)) {
          problems.push(`native delegation ${String(agent)} child session used an unexpected model or variant`)
        }
      }
      if (session.agent !== undefined && session.agent !== agent) problems.push(`native delegation ${String(agent)} correlated to child ${childID} with mismatched session agent`)
    }
    established.set(childID, agent)
    linkedSessionIDs.add(childID)
    previousDelegation = { dispatch, completion }
  }

  for (const session of sessions) {
    if (session?.sessionID !== rootSessionID && typeof session?.sessionID === "string" && !linkedSessionIDs.has(session.sessionID)) {
      problems.push(`observed non-root session ${session.sessionID} did not belong to a correlated native delegation`)
    }
  }
  for (const context of contexts) {
    if (context?.sessionID !== rootSessionID && typeof context?.sessionID === "string" && !linkedSessionIDs.has(context.sessionID)) {
      problems.push(`observed non-root context ${context.sessionID} did not belong to a correlated native delegation`)
    }
  }
  for (const event of [...toolEvidence.before, ...toolEvidence.after]) {
    if (event.sessionID !== rootSessionID && !linkedSessionIDs.has(event.sessionID)) {
      problems.push(`observed non-root tool session ${event.sessionID} did not belong to a correlated native delegation`)
    }
  }

  return { problems, completions, linkedSessionIDs }
}

function assessHandoffEvidence(dispatches, toolEvidence, completions) {
  const problems = []
  for (let index = 0; index < dispatches.length; index += 1) {
    const dispatch = dispatches[index]
    if (dispatch.input?.agent === "fast") continue
    const discovery = [...dispatches.slice(0, index)].reverse().find((candidate) => candidate.input?.agent === "fast")
    if (discovery === undefined) continue
    const completion = completions.get(toolIdentity(discovery))
    const output = completion?.resultOutput ?? completion?.result?.output
    const text = isRecord(output) && typeof output.output === "string" ? output.output : ""
    const paths = [...text.matchAll(/(?:src|test)\/[\w./-]+/g)].map((match) => match[0].replace(/\.+$/, ""))
    if (paths.length === 0) {
      problems.push(`discovery handoff for ${String(dispatch.input?.agent)} contained no structured file evidence`)
    } else if (typeof dispatch.input?.prompt !== "string" || !paths.some((path) => dispatch.input.prompt.includes(path))) {
      problems.push("execution prompt did not carry discovered file evidence")
    }
  }
  return problems
}

function assessPrimaryToolUse({ result, scenario, expectedRoute, tools, dispatches, toolEvidence }) {
  const problems = []
  const rootSessionID = result?.rootSessionID
  const primaryToolCalls = toolEvidence.before.filter((event) => event.sessionID === rootSessionID)
  const firstDispatch = dispatches[0]
  const firstDispatchSequence = firstDispatch === undefined ? Number.POSITIVE_INFINITY : sequenceOf(firstDispatch)

  for (const event of primaryToolCalls) {
    if (PRIMARY_MUTATION_TOOLS.has(event.tool)) {
      problems.push(`primary used forbidden mutation tool: ${event.tool}`)
    }
  }

  const preDispatch = primaryToolCalls.filter((event) => event.tool !== "subagent" && sequenceOf(event) < firstDispatchSequence)
  if (expectedRoute.length > 0 && preDispatch.length > 0) {
    problems.push(`primary used tools before first nontrivial delegation: ${preDispatch.map((event) => event.tool).join(", ")}`)
  }
  if (expectedRoute.length === 0 && primaryToolCalls.length > 1) {
    problems.push(`trivial route used ${primaryToolCalls.length} primary tool calls (expected at most one)`)
  }

  if (dispatches.length > 0) {
    const postDispatch = primaryToolCalls.filter((event) => sequenceOf(event) > sequenceOf(firstDispatch) && !PRIMARY_POST_DELEGATION_TOOLS.has(event.tool) && event.tool !== "shell")
    if (postDispatch.length > 0) {
      problems.push(`primary used disallowed tools after delegation: ${postDispatch.map((event) => event.tool).join(", ")}`)
    }
  }
  return problems
}

function assessDirectToolUse({ result, scenario, toolEvidence }) {
  const problems = []
  const rootSessionID = result?.rootSessionID
  const primaryToolCalls = toolEvidence.before.filter((event) => event.sessionID === rootSessionID)

  // Direct control is intentionally permissive about how the primary completes
  // the task.  The only routing-specific constraint is that it cannot create a
  // child session; retain the natural one-call guard for the arithmetic control
  // so a direct run cannot quietly turn into an unbounded tool exercise.
  if (scenario?.id === "trivial" && primaryToolCalls.length > 1) {
    problems.push(`trivial direct route used ${primaryToolCalls.length} primary tool calls (expected at most one)`)
  }
  return problems
}

function assessVerificationCommands({ result, scenario, expectedRoute, dispatches, toolEvidence, arm }) {
  const problems = []
  const expected = scenario?.verificationCommands ?? []
  const rootSessionID = result?.rootSessionID
  const shellCalls = toolEvidence.before.filter((event) => event.sessionID === rootSessionID && event.tool === "shell").sort(compareSequence)
  const expectedSeen = new Map(expected.map((command) => [command, 0]))
  const requireDelegation = arm !== "direct"

  for (const shell of shellCalls) {
    const command = shell.input?.command
    if (typeof command !== "string" || !expectedSeen.has(command)) {
      if (arm !== "direct") problems.push(`unknown primary verification command: ${formatExact(command)}`)
      continue
    }
    expectedSeen.set(command, expectedSeen.get(command) + 1)
    const workspace = result?.workspace
    const commandDirectory = resolveRoutingCommandDirectory(shell.input, workspace)
    for (const resolutionProblem of commandDirectory.problems) {
      problems.push(`verification command ${formatExact(command)} ${resolutionProblem}`)
    }
    if (commandDirectory.root !== undefined && commandDirectory.directory !== commandDirectory.root) {
      const outsideAlias = commandDirectory.aliases.find((alias) => alias.directory !== commandDirectory.root)
      const alias = outsideAlias?.name ?? "cwd"
      const value = outsideAlias?.value
      problems.push(`verification command ${formatExact(command)} used ${alias} ${formatExact(value)} instead of result workspace ${formatExact(workspace)}`)
    }
    const relevant = [...dispatches].filter((dispatch) => sequenceOf(dispatch) < sequenceOf(shell)).at(-1)
    if (requireDelegation && relevant === undefined) {
      problems.push(`verification command ${formatExact(command)} did not follow a completed relevant delegation`)
    }
    const requiredTier = expectedRoute.at(-1)
    if (requireDelegation && requiredTier !== undefined && relevant?.input?.agent !== requiredTier) {
      problems.push(`verification command ${formatExact(command)} did not follow the ${requiredTier} execution delegation`)
    }
    const completion = relevant === undefined ? undefined : toolEvidence.afterByIdentity.get(toolIdentity(relevant))
    if (requireDelegation && (completion === undefined || completion.status !== "completed" || sequenceOf(completion) >= sequenceOf(shell))) {
      problems.push(`verification command ${formatExact(command)} did not follow a completed relevant delegation`)
    }
    const shellCompletion = toolEvidence.afterByIdentity.get(toolIdentity(shell))
    if (shellCompletion === undefined || shellCompletion.status !== "completed") {
      problems.push(`verification command ${formatExact(command)} did not complete successfully`)
    } else {
      problems.push(...validatePrimaryShellCompletion(command, shellCompletion))
    }
    const snapshotProblem = validateVerificationSnapshot(result, shell)
    if (snapshotProblem !== undefined) {
      problems.push(snapshotProblem)
    }
  }

  if (arm !== "direct") {
    for (const [command, count] of expectedSeen) {
      if (count === 0 && expected.length > 0) problems.push(`expected exact fixture verification command was not observed: ${formatExact(command)}`)
      if (count > 1) problems.push(`exact fixture verification command was repeated: ${formatExact(command)}`)
    }
  }
  return problems
}

function validatePrimaryShellCompletion(command, completion) {
  const problems = []
  const output = completion.resultOutput ?? completion.result?.output
  const rawOutput = completion.result?.output
  const metadata = completion.resultMetadata ?? completion.result?.metadata
  const label = `verification command ${formatExact(command)}`
  if (!isRecord(output)) {
    return [`${label} result.output is missing the native shell completion shape`]
  }
  if (completion.resultOutput !== undefined && isRecord(rawOutput) && !sameJSON(completion.resultOutput, rawOutput)) {
    problems.push(`${label} recorded result.output disagreed with the event result.output`)
  }
  if (typeof output.output !== "string") problems.push(`${label} result.output.output is missing or is not a string`)
  if (typeof output.truncated !== "boolean") problems.push(`${label} result.output.truncated is missing or is not a boolean`)
  if (output.status !== "completed") problems.push(`${label} result.output.status was ${formatExact(output.status)}; expected "completed"`)
  if (!Object.prototype.hasOwnProperty.call(output, "exit")) {
    problems.push(`${label} result.output.exit is missing; expected 0`)
  } else if (output.exit !== 0) {
    problems.push(`${label} result.output.exit was ${formatExact(output.exit)}; expected 0`)
  }
  if (output.signal !== undefined) problems.push(`${label} result.output.signal was ${formatExact(output.signal)}; expected no signal`)
  if (output.timeout !== undefined && typeof output.timeout !== "boolean") problems.push(`${label} result.output.timeout is not a boolean`)
  if (output.timeout === true) problems.push(`${label} result.output.timeout was true`)
  if (metadata !== undefined) {
    if (!isRecord(metadata)) {
      problems.push(`${label} result.metadata is not an object`)
    } else {
      for (const field of ["status", "exit", "signal", "timeout"]) {
        if (Object.prototype.hasOwnProperty.call(metadata, field) && metadata[field] !== output[field]) {
          problems.push(`${label} result.metadata.${field} disagreed with result.output.${field}`)
        }
      }
    }
  }
  return problems
}

function validateVerificationSnapshot(result, shell) {
  const snapshots = result?.verificationSnapshots
  const identity = toolIdentity(shell)
  if (!Array.isArray(snapshots)) return `verification command ${formatExact(shell.input?.command)} is missing before/after snapshot evidence`
  const evidence = snapshots.find((candidate) => candidate?.identity === identity)
  if (!isRecord(evidence)) return `verification command ${formatExact(shell.input?.command)} is missing before/after snapshot evidence`
  if (!isRecord(evidence.before) || !isRecord(evidence.after)) return `verification command ${formatExact(shell.input?.command)} is missing before/after snapshot evidence`
  const beforeProblems = []
  const afterProblems = []
  const before = normalizeFingerprintManifest(evidence.before, `verification snapshot ${identity} before`, beforeProblems)
  const after = normalizeFingerprintManifest(evidence.after, `verification snapshot ${identity} after`, afterProblems)
  if (beforeProblems.length > 0 || afterProblems.length > 0 || before === undefined || after === undefined) {
    return `verification command ${formatExact(shell.input?.command)} has invalid before/after snapshot evidence: ${[...beforeProblems, ...afterProblems].join("; ")}`
  }
  const changes = diffFingerprintManifests(before, after)
  if (!Array.isArray(evidence.changedFiles) || !sameJSON(evidence.changedFiles, changes)) {
    return `verification command ${formatExact(shell.input?.command)} has inconsistent snapshot changedFiles`
  }
  if (changes.length > 0) return `verification command ${formatExact(shell.input?.command)} changed fixture files: ${changes.join(", ")}`
  return undefined
}

function matchesRoute(route, expectedRoute) {
  if (expectedRoute.length === 0) return route.length === 0
  const executionTier = expectedRoute.at(-1)
  return route.length > 0
    && route[0] === expectedRoute[0]
    && route.at(-1) === executionTier
    && route.every((tier) => tier === "fast" || tier === executionTier)
}

function matchesTierModel(observedModel, expectedConfig, observedVariant) {
  const actual = normalizeModel(observedModel, observedVariant)
  const expected = normalizeExpectedModel(expectedConfig)
  return actual !== undefined && expected !== undefined
    && actual.providerID === expected.providerID
    && actual.id === expected.id
    && actual.variant === expected.variant
}

function normalizeExpectedModel(value) {
  if (typeof value === "string") return normalizeModel(value)
  if (!isRecord(value)) return undefined
  if (typeof value.model === "string") return normalizeModel(value.model, value.variant)
  if (typeof value.providerID === "string" && typeof value.id === "string") {
    return { providerID: value.providerID, id: value.id, variant: value.variant }
  }
  return undefined
}

function normalizeModel(value, variant) {
  if (typeof value === "string") {
    const [reference, embeddedVariant] = value.split("#", 2)
    const separator = reference.indexOf("/")
    if (separator <= 0 || separator === reference.length - 1) return undefined
    return { providerID: reference.slice(0, separator), id: reference.slice(separator + 1), variant: variant ?? embeddedVariant }
  }
  if (isRecord(value) && typeof value.providerID === "string" && typeof value.id === "string") {
    return { providerID: value.providerID, id: value.id, variant: variant ?? value.variant }
  }
  return undefined
}

function toolIdentity(event) {
  return `${event.sessionID}/${event.messageID}/${event.id}/${event.tool}`
}

function sequenceOf(event) {
  return Number.isInteger(event?.seq) ? event.seq : Number.POSITIVE_INFINITY
}

function compareSequence(left, right) {
  return sequenceOf(left) - sequenceOf(right)
}

function formatExact(value) {
  return typeof value === "string" ? JSON.stringify(value) : JSON.stringify(value)
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
