import { createHash } from "node:crypto"
import { buildRoutingObserverSource } from "./routing-observer.mjs"
import { matchesTierModel, sequenceOf, toolIdentity, validateNativeLinkage } from "./routing-linkage.mjs"
import {
  FIXTURE_MANIFEST,
  checkFixture,
  diffRoutingSnapshots,
  fixtureRelativeFiles,
  fingerprintRoutingWorkspace,
  resolveRoutingCommandDirectory,
  restoreRoutingFixture,
  seedRoutingFixture,
  snapshotRoutingCommandDirectory,
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
  snapshotRoutingCommandDirectory,
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
  if (!matchesRoute(dispatches, expectedRoute)) {
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

    problems.push(...assessHandoffEvidence(dispatches, linkage))
    problems.push(...assessPrimaryToolUse({ result, scenario, expectedRoute, tools, dispatches, toolEvidence }))
    problems.push(...assessVerificationCommands({ result, scenario, expectedRoute, dispatches, toolEvidence, arm }))
  }

  const tokenRecords = sessions.flatMap((session) => {
    if (isRecord(session?.tokens)) return [session.tokens]
    const usage = Array.isArray(session?.usage) ? session.usage : []
    return usage.length > 0 ? usage.map((entry) => entry?.tokens) : []
  })
  const tokens = tokenRecords.length === 0 ? null : aggregateObservedTokens(tokenRecords)

  const readCalls = toolEvidence.before.filter((event) => READ_TOOLS.has(event.tool))
  const primaryReads = readCalls.filter((event) => event.sessionID === rootSessionID)
  const readFingerprints = readCalls.map((event) => `${event.tool}:${JSON.stringify(event.input)}`)
  const repeatedReads = readFingerprints.length - new Set(readFingerprints).size
  const primaryToolCalls = toolEvidence.before.filter((event) => event.sessionID === rootSessionID)
  const firstDispatch = dispatches[0]
  const readsBeforeDispatch = primaryReads.filter((event) => firstDispatch === undefined || (sequenceOf(event) ?? Number.POSITIVE_INFINITY) < (sequenceOf(firstDispatch) ?? Number.POSITIVE_INFINITY)).length

  const report = {
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
  // Derive these views from the aggregate so legacy callers that append an
  // objective failure to report.problems (after assessment) still expose the
  // correct per-scenario classification.
  for (const field of ["taskProblems", "policyProblems", "evidenceProblems"]) {
    Object.defineProperty(report, field, {
      enumerable: true,
      get() {
        return classifyRoutingProblems(problems)[field]
      },
    })
  }
  return report
}

/**
 * Keep the backwards-compatible aggregate problem list while exposing the
 * three kinds of scenario outcome that the benchmark needs to keep apart.
 * Objective checks added by older evaluators only arrive in `problems`, so
 * this intentionally has a conservative fallback: an unrecognised problem
 * is evaluator policy, never an implementation/task failure.  In particular
 * an unknown verification command remains a policy violation.
 */
export function classifyRoutingProblems(problems) {
  const taskProblems = []
  const policyProblems = []
  const evidenceProblems = []
  for (const problem of Array.isArray(problems) ? problems : []) {
    const message = String(problem)
    if (isTaskProblem(message)) taskProblems.push(problem)
    else if (isEvidenceProblem(message)) evidenceProblems.push(problem)
    else policyProblems.push(problem)
  }
  return { taskProblems, policyProblems, evidenceProblems }
}

function isTaskProblem(message) {
  return /(?:answer was incorrect|answer omitted|failed objective|fixture (?:behavior|tests)|changed-limit behavior|regression test evidence)/iu.test(message)
}

function isEvidenceProblem(message) {
  return /(?:inspection(?:Error| failed)?|fixture validation evidence|fixture verification evidence|fixture verifier (?:changed|control)|immutable infrastructure changed|snapshot evidence|execution context|session (?:evidence|info|metadata)|child session|root session|tool (?:event|completion)|native delegation .*?(?:structured|unobserved|correlated|returned|session)|orphan|synchronous sequence|duplicate observed sequence|routing protocol was not observed|protocol was not observed|result set)/iu.test(message)
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

function aggregateObservedTokens(records) {
  const components = {
    input: records.map((tokens) => tokens?.input),
    output: records.map((tokens) => tokens?.output),
    reasoning: records.map((tokens) => tokens?.reasoning),
    cachedRead: records.map((tokens) => tokens?.cache?.read),
    cachedWrite: records.map((tokens) => tokens?.cache?.write),
  }
  return Object.fromEntries(Object.entries(components).map(([key, values]) => [
    key,
    values.every((value) => Number.isFinite(value))
      ? values.reduce((sum, value) => sum + value, 0)
      : null,
  ]))
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

    // A successful outcome is not enough to certify a session when the
    // observer failed to inspect it.  Keep the original diagnostic on the
    // session record (and therefore in rawTrace); this problem only makes the
    // evidence fail closed.
    if (session.inspectionError !== undefined && session.inspectionError !== null) {
      problems.push(`session ${id} has inspectionError: ${String(session.inspectionError)}`)
    }
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
    if (sequenceOf(context) === undefined) problems.push(`execution context ${String(context?.sessionID)} is missing its synchronous sequence`)
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
    const sequence = sequenceOf(event)
    if (sequence === undefined) problems.push(`tool ${String(event.tool)} is missing its synchronous sequence`)
    else if (seenSequences.has(sequence)) problems.push(`duplicate tool sequence: ${sequence}`)
    else seenSequences.add(sequence)

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
    } else if (sequenceOf(event) !== undefined && sequenceOf(start) !== undefined && sequenceOf(event) <= sequenceOf(start)) {
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
    const sequence = sequenceOf(event)
    if (sequence === undefined) continue
    if (seen.has(sequence)) problems.push(`duplicate observed sequence across context/tool events: ${sequence}`)
    else seen.add(sequence)
  }
  return problems
}

function assessNativeLinkage({ result, dispatches, toolEvidence, sessions, contexts, rootSessionID, tierModels }) {
  return validateNativeLinkage({
    dispatches,
    tools: [...toolEvidence.before, ...toolEvidence.after],
    sessions,
    contexts,
    rootSessionID,
    tierModels,
    afterByIdentity: toolEvidence.afterByIdentity,
  })
}

function assessHandoffEvidence(dispatches, linkage) {
  const problems = []
  const completions = linkage?.completions ?? new Map()
  const validatedChildren = new Map()
  for (let index = 0; index < dispatches.length; index += 1) {
    const dispatch = dispatches[index]
    const completion = completions.get(toolIdentity(dispatch))
    const returnedChildID = completedChildID(completion)
    const agent = dispatch.input?.agent
    const inputSessionID = dispatch.input?.sessionID
    const isLinkedContinuation = typeof agent === "string"
      && agent !== "fast"
      && typeof inputSessionID === "string"
      && inputSessionID.length > 0
      && returnedChildID === inputSessionID
      && linkage?.linkedSessionIDs?.has(inputSessionID) === true
      && validatedChildren.get(inputSessionID) === agent

    if (agent !== "fast" && !isLinkedContinuation) {
      const discovery = [...dispatches.slice(0, index)].reverse().find((candidate) => candidate.input?.agent === "fast")
      if (discovery !== undefined) {
        const discoveryCompletion = completions.get(toolIdentity(discovery))
        const output = discoveryCompletion?.resultOutput ?? discoveryCompletion?.result?.output
        const text = isRecord(output) && typeof output.output === "string" ? output.output : ""
        const paths = [...text.matchAll(/(?:src|test)\/[\w./-]+/g)].map((match) => match[0].replace(/\.+$/, ""))
        if (paths.length === 0) {
          problems.push(`discovery handoff for ${String(agent)} contained no structured file evidence`)
        } else if (typeof dispatch.input?.prompt !== "string" || !paths.some((path) => dispatch.input.prompt.includes(path))) {
          problems.push("execution prompt did not carry discovered file evidence")
        }
      }
    }

    // Linkage has already validated the native result and child ownership. Keep
    // the returned child id as the only continuation authority; an input
    // sessionID by itself is not evidence of context reuse.
    if (returnedChildID !== undefined && linkage?.linkedSessionIDs?.has(returnedChildID) === true) {
      validatedChildren.set(returnedChildID, agent)
    }
  }
  return problems
}

function completedChildID(completion) {
  if (completion?.status !== "completed") return undefined
  const output = completion.resultOutput ?? completion.result?.output
  if (!isRecord(output)
    || output.status !== "completed"
    || typeof output.sessionID !== "string"
    || output.sessionID.length === 0
    || typeof output.output !== "string") return undefined
  const metadata = completion.resultMetadata ?? completion.result?.metadata
  if (!isRecord(metadata) || metadata.sessionID !== output.sessionID || metadata.status !== output.status) return undefined
  return output.sessionID
}

function assessPrimaryToolUse({ result, scenario, expectedRoute, tools, dispatches, toolEvidence }) {
  const problems = []
  const rootSessionID = result?.rootSessionID
  const primaryToolCalls = toolEvidence.before.filter((event) => event.sessionID === rootSessionID)
  const firstDispatch = dispatches[0]
  const firstDispatchSequence = firstDispatch === undefined ? Number.POSITIVE_INFINITY : (sequenceOf(firstDispatch) ?? Number.POSITIVE_INFINITY)

  for (const event of primaryToolCalls) {
    if (PRIMARY_MUTATION_TOOLS.has(event.tool)) {
      problems.push(`primary used forbidden mutation tool: ${event.tool}`)
    }
  }

  const preDispatch = primaryToolCalls.filter((event) => event.tool !== "subagent" && (sequenceOf(event) ?? Number.POSITIVE_INFINITY) < firstDispatchSequence)
  if (expectedRoute.length > 0 && preDispatch.length > 0) {
    problems.push(`primary used tools before first nontrivial delegation: ${preDispatch.map((event) => event.tool).join(", ")}`)
  }
  if (expectedRoute.length === 0 && primaryToolCalls.length > 1) {
    problems.push(`trivial route used ${primaryToolCalls.length} primary tool calls (expected at most one)`)
  }

  if (dispatches.length > 0) {
    const postDispatch = primaryToolCalls.filter((event) => (sequenceOf(event) ?? Number.POSITIVE_INFINITY) > (sequenceOf(firstDispatch) ?? Number.POSITIVE_INFINITY) && !PRIMARY_POST_DELEGATION_TOOLS.has(event.tool) && event.tool !== "shell")
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
    if (commandDirectory.root === undefined) {
      problems.push(`verification command ${formatExact(command)} cannot resolve the fixture workspace`)
    }
    for (const resolutionProblem of [...new Set(commandDirectory.problems)]) {
      problems.push(`verification command ${formatExact(command)} ${resolutionProblem}`)
    }
    const resolvesToRoot = commandDirectory.root !== undefined
      && (commandDirectory.directory === commandDirectory.root
        || (commandDirectory.rootReal !== undefined
          && commandDirectory.realDirectory !== undefined
          && commandDirectory.rootReal === commandDirectory.realDirectory))
    if (commandDirectory.root !== undefined && !resolvesToRoot) {
      const outsideAlias = commandDirectory.aliases.find((alias) => alias.directory !== commandDirectory.root)
      const alias = outsideAlias?.name ?? "cwd"
      const value = outsideAlias?.value
      problems.push(`verification command ${formatExact(command)} used ${alias} ${formatExact(value)} instead of result workspace ${formatExact(workspace)}`)
    }
    const relevant = [...dispatches].filter((dispatch) => {
      const dispatchSequence = sequenceOf(dispatch)
      const shellSequence = sequenceOf(shell)
      return dispatchSequence !== undefined && shellSequence !== undefined && dispatchSequence < shellSequence
    }).at(-1)
    if (requireDelegation && relevant === undefined) {
      problems.push(`verification command ${formatExact(command)} did not follow a completed relevant delegation`)
    }
    const requiredTier = expectedRoute.at(-1)
    if (requireDelegation && requiredTier !== undefined && relevant?.input?.agent !== requiredTier) {
      problems.push(`verification command ${formatExact(command)} did not follow the ${requiredTier} execution delegation`)
    }
    const completion = relevant === undefined ? undefined : toolEvidence.afterByIdentity.get(toolIdentity(relevant))
    if (requireDelegation && (completion === undefined
      || completion.status !== "completed"
      || sequenceOf(completion) === undefined
      || sequenceOf(shell) === undefined
      || sequenceOf(completion) >= sequenceOf(shell))) {
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
  const snapshotProblems = [
    ...(Array.isArray(evidence.snapshotProblems) ? evidence.snapshotProblems : []),
    ...(Array.isArray(evidence.beforeProblems) ? evidence.beforeProblems : []),
    ...(Array.isArray(evidence.afterProblems) ? evidence.afterProblems : []),
  ]
  if (snapshotProblems.length > 0) {
    return `verification command ${formatExact(shell.input?.command)} has invalid before/after snapshot evidence: ${[...new Set(snapshotProblems)].join("; ")}`
  }
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

function matchesRoute(dispatches, expectedRoute) {
  const route = dispatches.map((event) => event.input?.agent)
  if (expectedRoute.length === 0) return route.length === 0
  const executionTier = expectedRoute.at(-1)
  if (expectedRoute.length === 1 && dispatches.filter((dispatch) => dispatch.input?.sessionID === undefined).length !== 1) return false
  return route.length > 0
    && route[0] === expectedRoute[0]
    && route.at(-1) === executionTier
    && route.every((tier) => tier === "fast" || tier === executionTier)
}

function compareSequence(left, right) {
  return (sequenceOf(left) ?? Number.POSITIVE_INFINITY) - (sequenceOf(right) ?? Number.POSITIVE_INFINITY)
}

function formatExact(value) {
  return typeof value === "string" ? JSON.stringify(value) : JSON.stringify(value)
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
