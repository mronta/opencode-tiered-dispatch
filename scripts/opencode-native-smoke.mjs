import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { spawn, spawnSync } from "node:child_process"
import net from "node:net"
import {
  assessDirect,
  assessRouting,
  diffRoutingSnapshots,
  routingObserverSource,
  scenarios,
  seedRoutingFixture,
  snapshotRoutingWorkspace,
  validateScenarioResultSet,
} from "./routing-eval.mjs"

const root = resolve(fileURLToPath(new URL("..", import.meta.url)))
let runtimeModelSelection
async function runNativeSmoke(argv = process.argv.slice(2)) {
  // CLI-only runtime dependencies are loaded after argument parsing/import of
  // this module.  The pure parser and evidence helpers are also used by the
  // pre-build test suite, where dist/ intentionally does not exist yet.
  const [{ modelSelection }, { REQUIRED_TIER_MODELS }] = await Promise.all([
    import("../dist/options.js"),
    import("../dist/tiers.js"),
  ])
  runtimeModelSelection = modelSelection
  const nativeOptions = parseNativeOptions(argv)
  const routingEval = nativeOptions.routingEval
  const arm = nativeOptions.arm
  const outputPath = nativeOptions.output
  const selectedScenarios = selectScenarios(nativeOptions.scenario)
  const workspace = mkdtempSync(join(tmpdir(), "opencode-tiered-dispatch-native-"))
  const control = mkdtempSync(join(tmpdir(), "opencode-tiered-dispatch-native-control-"))
  const paths = {
    marker: join(control, "setup.marker"),
    result: join(control, "scenario.result"),
    failure: join(control, "scenario.failure"),
    progress: join(control, "scenario.progress.jsonl"),
    controlDirectory: control,
  }

  const requiredTierModels = REQUIRED_TIER_MODELS
  const providerErrorModel = "openai/__tiered_dispatch_missing_model__"
  const rootModel = runtimeModelSelection(requiredTierModels.medium.model, requiredTierModels.medium.variant)
  const hostVersion = detectHostVersion()
  let startupMs = null
  let observedResults
  let observedReports = []
  let observerFailure
  let preserveTemporaryEvidence = false

  mkdirSync(join(workspace, ".opencode", "plugins"), { recursive: true })
  const pluginEntry = {
    package: root,
    ...(routingEval && arm === "direct" ? { options: { enabled: false } } : {}),
  }
  writeFileSync(join(workspace, "opencode.jsonc"), JSON.stringify({
    $schema: "https://opencode.ai/config.json",
    ...(routingEval ? {} : { agents: nativeAgents(providerErrorModel) }),
    ...(routingEval && arm === "direct" ? {
      agents: {
        build: {
          permissions: [
            { action: "*", resource: "*", effect: "allow" },
            { action: "subagent", resource: "*", effect: "deny" },
          ],
        },
      },
    } : {}),
    plugins: [pluginEntry],
  }, null, 2) + "\n")
  if (routingEval) seedRoutingFixture(workspace)
  writeFileSync(join(workspace, ".opencode", "plugins", "native-smoke-observer.js"), routingEval
    ? routingObserverSource(paths, rootModel, { nodeBinary: process.execPath, arm, hideRootSubagent: arm === "direct", scenarios: selectedScenarios })
    : observerSource(paths, rootModel, requiredTierModels, providerErrorModel))

  const port = await freePort()
  const password = `native-smoke-${Date.now()}`
  const launchStartedAt = Date.now()
  const child = spawn(
    process.env.OPENCODE_BIN ?? "opencode",
    ["serve", "--hostname", "127.0.0.1", "--port", String(port), "--log-level", "debug"],
    {
      cwd: workspace,
      env: { ...process.env, OPENCODE_PASSWORD: password },
      stdio: ["ignore", "pipe", "pipe"],
    },
  )
  let logs = ""
  child.stdout.on("data", (chunk) => { logs += String(chunk) })
  child.stderr.on("data", (chunk) => { logs += String(chunk) })

  try {
    const authorization = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`
    await waitFor(async () => {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/api/agent`, { headers: { authorization } })
        return response.ok
      } catch {
        return false
      }
    }, 30_000, () => logs)
    await waitFor(() => existsSync(paths.marker) || existsSync(paths.failure), 180_000, () => logs)
    startupMs = Date.now() - launchStartedAt
    if (existsSync(paths.failure)) {
      observerFailure = readJson(paths.failure)
      throw new Error(formatFailure(readFileSync(paths.failure, "utf8"), logs))
    }
    const initialAgentResponse = await fetch(`http://127.0.0.1:${port}/api/agent`, { headers: { authorization } })
    if (!initialAgentResponse.ok) throw new Error(`could not read initial native agent catalog: HTTP ${initialAgentResponse.status}`)
    if (!routingEval || arm === "tiered") {
      verifyMaterializedAgents((await initialAgentResponse.json()).data ?? [], requiredTierModels)
    }

    await waitFor(() => existsSync(paths.result) || existsSync(paths.failure), nativeOptions.timeoutMs, () => logs, { nativeTimeout: true })
    if (existsSync(paths.failure)) {
      observerFailure = readJson(paths.failure)
      throw new Error(formatFailure(readFileSync(paths.failure, "utf8"), logs))
    }
    const result = JSON.parse(readFileSync(paths.result, "utf8"))
    observedResults = result
    const agentResponse = await fetch(`http://127.0.0.1:${port}/api/agent`, { headers: { authorization } })
    if (!agentResponse.ok) throw new Error(`could not read native agent catalog: HTTP ${agentResponse.status}`)
    const agentPayload = await agentResponse.json()
    try {
      if (routingEval) {
        const beforeEvaluator = snapshotRoutingWorkspace(workspace)
        let evaluatorError
        try {
          observedReports = verifyRoutingEvaluation(result, arm, requiredTierModels, rootModel, selectedScenarios)
        } catch (error) {
          evaluatorError = error
          if (error?.reports !== undefined) observedReports = error.reports
        }
        const afterEvaluator = snapshotRoutingWorkspace(workspace)
        const evaluatorChanges = diffRoutingSnapshots(beforeEvaluator, afterEvaluator)
        if (evaluatorChanges.length > 0) throw new Error(`evaluator checks changed workspace files: ${evaluatorChanges.join(", ")}`)
        if (evaluatorError !== undefined) throw evaluatorError
      }
      else verify(result, agentPayload.data ?? agentPayload, workspace, providerErrorModel)
    } catch (error) {
      throw new Error(`${error?.message ?? String(error)}\nOpenCode logs:\n${logs}`)
    }
    writeArtifact(outputPath, makeArtifact({
      arm,
      rootModel,
      tierModels: requiredTierModels,
      hostVersion,
      startupMs,
      timeoutMs: nativeOptions.timeoutMs,
      scenarioIDs: selectedScenarios.map((scenario) => scenario.id),
      reports: observedReports,
      results: observedResults,
      errors: [],
    }))
    console.log(routingEval ? "OpenCode spontaneous-routing evaluation passed" : `OpenCode native-agent smoke passed: ${Object.keys(result.tiers).join(", ")}`)
  } catch (error) {
    // Capture the causal state before SIGTERM can wake the blocked root.  A
    // post-shutdown snapshot is retained separately and never replaces it.
    const progressAtTimeout = readProgressJournal(paths.progress)
    const failureAtTimeout = observerFailure ?? (existsSync(paths.failure) ? readJson(paths.failure) : undefined)
    await stopProcess(child)
    const progressAfterShutdown = readProgressJournal(paths.progress)
    const failureAfterShutdown = existsSync(paths.failure) ? readJson(paths.failure) : undefined
    const progress = progressAtTimeout ?? progressAfterShutdown
    const failure = failureAtTimeout ?? failureAfterShutdown
    const completedResults = progressAtTimeout?.completedResults ?? progressAfterShutdown?.completedResults ?? []
    const resultForArtifact = observedResults ?? (completedResults.length > 0 ? completedResults : failure?.results ?? null)
    const failureRecord = enrichFailure(error, failure, progress, nativeOptions.timeoutMs)
    const diagnosticError = progress === undefined || !isNativeTimeout(error)
      ? error
      : new Error(`${error?.message ?? String(error)}\n${formatProgressSummary(progress)}\nHypothesis: ${failureRecord.hypothesis}`)
    if (isNativeTimeout(error)) {
      console.error(`OpenCode native-agent smoke timeout: ${formatProgressSummary(progress)}`)
      console.error(`Hypothesis: ${failureRecord.hypothesis}`)
    }
    try {
      writeArtifact(outputPath, makeArtifact({
        arm,
        rootModel,
        tierModels: requiredTierModels,
        hostVersion,
        startupMs,
        timeoutMs: nativeOptions.timeoutMs,
        scenarioIDs: selectedScenarios.map((scenario) => scenario.id),
        reports: observedReports,
        results: resultForArtifact,
        errors: [diagnosticError?.message ?? String(diagnosticError)],
        failure: failureRecord,
        progress: progressAtTimeout,
        postShutdownProgress: progressAfterShutdown,
        postShutdownFailure: failureAfterShutdown,
      }))
    } catch (artifactError) {
      preserveTemporaryEvidence = true
      const retained = retainDiagnosticEvidence({ outputPath, control, workspace })
      const retainedPath = retained.path ?? `${control} (workspace: ${workspace})`
      const retentionError = retained.error === undefined ? "" : `\nEvidence copy also failed: ${retained.error.message ?? String(retained.error)}`
      const artifactFailure = new Error(`${diagnosticError?.message ?? String(diagnosticError)}\nCould not write diagnostic artifact: ${artifactError?.message ?? String(artifactError)}\nRetained evaluator evidence: ${retainedPath}${retentionError}`)
      artifactFailure.cause = artifactError
      console.error(artifactFailure.message)
      throw artifactFailure
    }
    throw diagnosticError
  } finally {
    await stopProcess(child)
    if (!preserveTemporaryEvidence) {
      rmSync(workspace, { recursive: true, force: true })
      rmSync(control, { recursive: true, force: true })
    } else {
      console.error(`Preserved evaluator workspace: ${workspace}`)
      console.error(`Preserved evaluator control directory: ${control}`)
    }
  }
}

function formatFailure(failure, logs) {
  return `${failure}\nOpenCode logs:\n${logs}`
}

export function parseNativeOptions(argv) {
  let routingEval = false
  let arm = "tiered"
  let output
  let timeoutMs = 600_000
  let scenario
  let armSpecified = false
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === "--routing-eval") {
      routingEval = true
      continue
    }
    if (argument === "--arm" || argument === "--output" || argument === "--timeout-ms" || argument === "--scenario") {
      const value = argv[++index]
      if (typeof value !== "string" || value.length === 0 || value.startsWith("--")) {
        throw new Error(`${argument} requires a value`)
      }
      if (argument === "--arm") {
        arm = value
        armSpecified = true
      } else if (argument === "--output") {
        output = resolve(value)
      } else if (argument === "--timeout-ms") {
        timeoutMs = parsePositiveTimeout(value)
      } else {
        scenario = value
      }
      continue
    }
    if (argument.startsWith("--arm=") || argument.startsWith("--output=") || argument.startsWith("--timeout-ms=") || argument.startsWith("--scenario=")) {
      const separator = argument.indexOf("=")
      const name = argument.slice(0, separator)
      const value = argument.slice(separator + 1)
      if (value.length === 0) throw new Error(`${name} requires a value`)
      if (name === "--arm") {
        arm = value
        armSpecified = true
      } else if (name === "--output") {
        output = resolve(value)
      } else if (name === "--timeout-ms") {
        timeoutMs = parsePositiveTimeout(value)
      } else {
        scenario = value
      }
      continue
    }
    throw new Error(`unknown native smoke option: ${argument}`)
  }
  if (arm !== "direct" && arm !== "tiered") throw new Error(`--arm must be direct or tiered, got ${arm}`)
  if (armSpecified && !routingEval) throw new Error("--arm requires --routing-eval")
  if (scenario !== undefined && !routingEval) throw new Error("--scenario requires --routing-eval")
  if (scenario !== undefined) selectScenarios(scenario)
  if (routingEval && output === undefined) {
    output = join(tmpdir(), "opencode", `routing-eval-${Date.now()}-${process.pid}.json`)
  }
  return { routingEval, arm, output, timeoutMs, scenario }
}

export function parsePositiveTimeout(value) {
  if (!/^\d+$/u.test(String(value))) throw new Error(`--timeout-ms must be a positive integer, got ${value}`)
  const timeoutMs = Number(value)
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error(`--timeout-ms must be a positive integer, got ${value}`)
  return timeoutMs
}

export function selectScenarios(scenarioID) {
  if (scenarioID === undefined) return scenarios
  const selected = scenarios.filter((scenario) => scenario.id === scenarioID)
  if (selected.length === 0) {
    throw new Error(`--scenario must name an existing routing scenario: ${scenarioID} (expected one of ${scenarios.map((scenario) => scenario.id).join(", ")})`)
  }
  return selected
}

function detectHostVersion() {
  const configured = process.env.OPENCODE_VERSION
  if (typeof configured === "string" && configured.trim() !== "") return configured.trim()
  try {
    const command = process.env.OPENCODE_BIN ?? "opencode"
    const result = spawnSync(command, ["--version"], { encoding: "utf8", timeout: 5_000 })
    if (result.status !== 0) return null
    const version = String(result.stdout ?? "").trim().split(/\r?\n/u)[0]
    return version === "" ? null : version
  } catch {
    return null
  }
}

function readJson(filename) {
  try {
    return JSON.parse(readFileSync(filename, "utf8"))
  } catch {
    return undefined
  }
}

export function parseProgressJournal(text, { maxEvents = 80 } = {}) {
  const completed = new Map()
  const events = []
  const parseErrors = []
  let latestCheckpoint
  let activeContext
  let activeTool
  let lastEvent
  let lineCount = 0
  for (const line of String(text ?? "").split(/\r?\n/u)) {
    if (line.trim() === "") continue
    lineCount += 1
    let entry
    try {
      entry = JSON.parse(line)
    } catch (error) {
      parseErrors.push(`line ${lineCount}: ${error.message}`)
      continue
    }
    if (entry?.type === "checkpoint") latestCheckpoint = entry
    if (entry?.type === "context") activeContext = entry
    if (entry?.type === "tool") activeTool = entry
    if (entry?.type === "scenario-complete" && typeof entry.scenarioID === "string" && entry.result !== undefined) {
      completed.set(entry.scenarioID, entry.result)
    }
    if (entry?.type === "context" || entry?.type === "tool") {
      lastEvent = entry
      events.push(entry)
      if (events.length > maxEvents) events.shift()
    }
  }
  const latest = latestCheckpoint ?? lastEvent
  const phase = latest?.failedFromPhase ?? latest?.phase ?? null
  const scenarioID = latest?.failedFromScenarioID ?? latest?.scenarioID ?? null
  const rootSessionID = latest?.failedFromRootSessionID ?? latest?.rootSessionID ?? null
  const partialEvents = scenarioID === null
    ? []
    : events.filter((entry) => entry.scenarioID === scenarioID)
  return {
    schemaVersion: 1,
    latest: latest === undefined ? null : latest,
    phase,
    scenarioID,
    rootSessionID,
    activeContext: activeContext ?? null,
    activeTool: activeTool ?? null,
    lastEvent: lastEvent ?? null,
    events,
    partial: scenarioID === null ? null : {
      scenarioID,
      rootSessionID,
      contexts: partialEvents.filter((entry) => entry.type === "context"),
      tools: partialEvents.filter((entry) => entry.type === "tool"),
    },
    completedScenarioIDs: [...completed.keys()],
    completedResults: [...completed.values()],
    lineCount,
    parseErrors,
  }
}

export function readProgressJournal(filename, options = {}) {
  if (!existsSync(filename)) return undefined
  try {
    return parseProgressJournal(readFileSync(filename, "utf8"), options)
  } catch (error) {
    return {
      schemaVersion: 1,
      latest: null,
      phase: null,
      scenarioID: null,
      rootSessionID: null,
      activeContext: null,
      activeTool: null,
      lastEvent: null,
      events: [],
      partial: null,
      completedScenarioIDs: [],
      completedResults: [],
      lineCount: 0,
      parseErrors: [`could not read progress journal: ${error.message}`],
    }
  }
}

export function focusedTimeoutHypothesis(progress) {
  if (progress === undefined) {
    return "No observer progress journal was available; the timeout is not enough evidence to classify provider/model compliance or a fixture deadlock."
  }
  const phase = progress.phase ?? "unknown"
  const scenario = progress.scenarioID === null ? "no active scenario" : `scenario ${String(progress.scenarioID)}`
  return `The observer reached ${phase} for ${scenario}; the timeout establishes that no terminal artifact arrived before the configured deadline, but does not by itself establish provider/model noncompliance. Inspect the retained session, context, and tool facts before assigning cause.`
}

export function formatProgressSummary(progress) {
  if (progress === undefined) return "Latest observer progress: unavailable"
  const latest = progress.latest ?? {}
  const eventSummary = (progress.events ?? []).slice(-4).map((event) => {
    const identity = [event.sessionID, event.messageID, event.id, event.tool].filter((part) => part !== undefined).join("/")
    return `${event.type}:${event.phase ?? ""}:${identity}:${event.status ?? ""}`
  }).join(" | ") || "none"
  return `Latest observer progress: phase=${String(progress.phase)} scenario=${String(progress.scenarioID)} root=${String(progress.rootSessionID)} checkpointAt=${String(latest.observedAt ?? "unknown")} activeContext=${String(progress.activeContext?.sessionID ?? "none")} activeTool=${String(progress.activeTool?.tool ?? "none")} lastEvents=${eventSummary}`
}

export function enrichFailure(error, observerFailure, progress, timeoutMs) {
  const timeout = isNativeTimeout(error)
  return {
    ...(observerFailure ?? {}),
    kind: timeout ? "timeout" : (observerFailure?.kind ?? "native-smoke-failure"),
    message: observerFailure?.message ?? error?.message ?? String(error),
    runnerMessage: error?.message ?? String(error),
    timeoutMs: timeout ? timeoutMs : null,
    phase: progress?.phase ?? observerFailure?.phase ?? null,
    scenarioID: progress?.scenarioID ?? observerFailure?.scenarioID ?? null,
    rootSessionID: progress?.rootSessionID ?? observerFailure?.rootSessionID ?? null,
    hypothesis: timeout ? focusedTimeoutHypothesis(progress) : undefined,
  }
}

function isNativeTimeout(error) {
  return error?.code === "NATIVE_SMOKE_TIMEOUT"
}

export function makeArtifact({ arm: artifactArm, rootModel: artifactRootModel, tierModels, hostVersion: version, startupMs: startup, timeoutMs, scenarioIDs, reports, results, errors, failure, progress, postShutdownProgress, postShutdownFailure }) {
  const resultList = Array.isArray(results) ? results : null
  return {
    schemaVersion: 1,
    arm: artifactArm,
    rootModel: artifactRootModel,
    tierModels,
    hostVersion: version ?? null,
    startupMs: startup,
    timeoutMs: timeoutMs ?? null,
    scenarioIDs: Array.isArray(scenarioIDs) ? scenarioIDs : null,
    controlDifference: artifactArm === "direct"
      ? "plugin options enabled:false; build subagent denied and hidden by the benchmark observer; direct runs do not permit child delegations"
      : "tiered plugin enabled; native tier agents and primary routing protocol are under evaluation",
    reports: Array.isArray(reports) ? reports : [],
    results: resultList,
    rawTrace: resultList?.map((result) => result?.rawTrace ?? result) ?? null,
    errors: Array.isArray(errors) ? errors : [String(errors)],
    failure: failure ?? null,
    progress: progress ?? null,
    postShutdownProgress: postShutdownProgress ?? null,
    postShutdownFailure: postShutdownFailure ?? null,
  }
}

function writeArtifact(filename, artifact) {
  if (filename === undefined) return
  mkdirSync(dirname(filename), { recursive: true })
  writeFileSync(filename, JSON.stringify(artifact, null, 2) + "\n")
}

function retainDiagnosticEvidence({ outputPath, control, workspace }) {
  const base = outputPath === undefined
    ? join(tmpdir(), `opencode-native-evidence-${Date.now()}-${process.pid}`)
    : `${outputPath}.evidence-${Date.now()}-${process.pid}`
  const temporary = `${base}.tmp`
  try {
    rmSync(temporary, { recursive: true, force: true })
    mkdirSync(dirname(temporary), { recursive: true })
    mkdirSync(temporary, { recursive: true })
    cpSync(control, join(temporary, "control"), { recursive: true })
    cpSync(workspace, join(temporary, "workspace"), { recursive: true })
    writeFileSync(join(temporary, "retention.json"), JSON.stringify({ control, workspace, outputPath: outputPath ?? null }, null, 2) + "\n")
    renameSync(temporary, base)
    return { path: base }
  } catch (error) {
    return { error }
  }
}

function verifyRoutingEvaluation(results, evaluationArm = "tiered", tierModels, selectedRootModel = undefined, expectedScenarios = scenarios) {
  const setProblems = validateScenarioResultSet(results, expectedScenarios)
  if (setProblems.length > 0) throw new Error(`invalid routing scenario result set: ${setProblems.join("; ")}`)
  const resultByID = new Map(results.map((result) => [result.id, result]))
  const reports = expectedScenarios.map((scenario) => evaluationArm === "direct"
    ? assessDirect(resultByID.get(scenario.id), { rootModel: selectedRootModel })
    : assessRouting(resultByID.get(scenario.id), scenario.route, tierModels, { rootModel: selectedRootModel }))
  for (const report of reports) report.arm = evaluationArm
  const reportByID = new Map(reports.map(report => [report.id, report]))
  const trivial = resultByID.get("trivial")
  const trivialRoot = trivial?.sessions.find(session => session.sessionID === trivial.rootSessionID)
  if (trivial !== undefined && trivialRoot?.text.trim() !== "4") {
    reportByID.get("trivial").problems.push("trivial answer was incorrect")
  }
  const analysis = resultByID.get("discover-analyze")
  if (analysis !== undefined) {
    const answer = analysis.sessions.find(session => session.sessionID === analysis.rootSessionID)?.text ?? ""
    if (!/replay/i.test(answer) || !/forg|unauthenticated|signature/i.test(answer) || !/src\/auth\//.test(answer)) {
      reportByID.get("discover-analyze").problems.push("security answer omitted replay, identity forgery or file evidence")
    }
    if (analysis.changedFiles.length > 0) {
      reportByID.get("discover-analyze").problems.push("analysis modified fixture files despite no-edit request")
    }
  }
  console.log(JSON.stringify(reports, null, 2))
  if (reports.some(report => report.problems.length > 0)) {
    const error = new Error("spontaneous-routing evaluation failed; see observed routes above")
    error.reports = reports
    throw error
  }
  return reports
}

function verifyMaterializedAgents(agents, expectedTiers) {
  for (const [tier, expected] of Object.entries(expectedTiers)) {
    const agent = verifyTierAgent(agents, tier, expected, "materialized")
    verifyMaterializedAgentFields(agent, tier)
  }
  verifyPlanPermissions(agents)
}

function nativeAgents(providerErrorModel) {
  return {
    "provider-error": {
      mode: "subagent",
      description: "Native provider-error smoke agent",
      model: providerErrorModel,
      system: "Return the requested result if possible. Do not delegate further.",
    },
  }
}

function matchesExpectedModel(actual, expected) {
  if (!actual) return false
  if (runtimeModelSelection === undefined) return false
  const configured = runtimeModelSelection(expected.model, expected.variant)
  return actual.providerID === configured.providerID
    && actual.id === configured.id
    && normalizedVariant(actual.variant, expected.variant) === (expected.variant ?? undefined)
}

function verifyTierAgent(agents, tier, expected, phase) {
  const agent = agents.find((candidate) => candidate.id === tier)
  if (!agent || agent.mode !== "subagent") {
    throw new Error(`native ${tier} was not ${phase} as a subagent: ${JSON.stringify(agent)}`)
  }
  if (!matchesExpectedModel(agent.model, expected)) {
    throw new Error(`native ${tier} was ${phase} with the wrong model: ${JSON.stringify(agent)}`)
  }
  return agent
}

function verifyMaterializedAgentFields(agent, tier) {
  if (agent.name !== tier) {
    throw new Error(`native ${tier} was materialized with the wrong name: ${JSON.stringify(agent)}`)
  }
  if (agent.hidden !== false) {
    throw new Error(`native ${tier} was not materialized as visible: ${JSON.stringify(agent)}`)
  }
  if (Object.prototype.hasOwnProperty.call(agent, "steps")) {
    throw new Error(`native ${tier} retained a steps limit: ${JSON.stringify(agent)}`)
  }
  if (JSON.stringify(agent.request) !== JSON.stringify({ settings: {}, headers: {}, body: {} })) {
    throw new Error(`native ${tier} retained request settings: ${JSON.stringify(agent)}`)
  }
}

function verifyPlanPermissions(agents) {
  const plan = agents.find((candidate) => candidate.id === "plan")
  if (!plan) return
  for (const tier of ["medium", "heavy"]) {
    const rule = [...(plan.permissions ?? [])].reverse().find(
      (candidate) => candidate.action === "subagent" && candidate.resource === tier,
    )
    if (rule?.effect !== "deny") {
      throw new Error(`native plan can invoke ${tier}: ${JSON.stringify(plan)}`)
    }
  }
}

function observerSource(resultPaths, selectedRootModel, configuredTiers, configuredProviderErrorModel) {
  const directModels = Object.fromEntries(
    Object.entries(configuredTiers).map(([tier, config]) => [tier, runtimeModelSelection(config.model, config.variant)]),
  )
  return [
    `import { appendFileSync, writeFileSync } from "node:fs"`,
    `const markerPath = ${JSON.stringify(resultPaths.marker)}`,
    `const resultPath = ${JSON.stringify(resultPaths.result)}`,
    `const failurePath = ${JSON.stringify(resultPaths.failure)}`,
    `const progressPath = ${JSON.stringify(resultPaths.progress ?? `${resultPaths.result}.progress.jsonl`)}`,
    `const rootModel = ${JSON.stringify(selectedRootModel)}`,
    `const directModels = ${JSON.stringify(directModels)}`,
    `const expectedTiers = ${JSON.stringify(configuredTiers)}`,
    `const providerErrorModel = ${JSON.stringify(configuredProviderErrorModel)}`,
    `const tiers = ${JSON.stringify(["fast", "medium", "heavy"])}`,
    "",
    "function snapshot(event) {",
    "  return {",
    "    sessionID: event.sessionID,",
    "    agent: event.agent,",
    "    model: event.model,",
    "    hasProtocol: event.system.some((part) => String(part?.text ?? \"\").includes(\"Tiered Dispatch Protocol\")),",
    "    toolNames: Object.keys(event.tools ?? {}),",
    "  }",
    "}",
    "",
    "function messageText(messages) {",
    "  return messages.filter((message) => message.type === \"assistant\").flatMap((message) => message.content ?? []).filter((part) => part.type === \"text\").map((part) => part.text).join(\"\\n\").trim()",
    "}",
    "",
    "function compactText(value, limit = 512) {",
    "  if (value === undefined || value === null) return undefined",
    "  const text = typeof value === \"string\" ? value : (JSON.stringify(value) ?? String(value))",
    "  return text.length <= limit ? text : text.slice(0, limit) + \"…\"",
    "}",
    "",
    "function compactTool(event, phase, progressState) {",
    "  const input = event.input ?? {}",
    "  const compactInput = event.tool === \"subagent\"",
    "    ? { agent: input.agent, sessionID: input.sessionID, prompt: compactText(input.prompt) }",
    "    : event.tool === \"shell\"",
    "      ? { command: compactText(input.command), cwd: compactText(input.cwd), workdir: compactText(input.workdir) }",
    "      : { keys: Object.keys(input).slice(0, 32) }",
    "  const output = event.result?.output",
    "  return {",
    "    type: \"tool\", phase, observedAt: Date.now(), scenarioID: progressState.scenarioID, rootSessionID: progressState.rootSessionID,",
    "    sessionID: event.sessionID, messageID: event.messageID, id: event.id, tool: event.tool, agent: event.agent,",
    "    input: compactInput, status: event.status,",
    "    result: phase === \"after\" ? { sessionID: output?.sessionID, status: output?.status, metadata: event.result?.metadata === undefined ? undefined : { sessionID: event.result.metadata?.sessionID, status: event.result.metadata?.status }, output: compactText(output?.output), exit: output?.exit, signal: output?.signal, timeout: output?.timeout } : undefined,",
    "  }",
    "}",
    "",
    "function writeProgress(entry) {",
    "  try { appendFileSync(progressPath, JSON.stringify({ schemaVersion: 1, ...entry }) + \"\\n\") }",
    "  catch (error) { process.stderr.write(\"native smoke progress journal unavailable: \" + (error?.message ?? String(error)) + \"\\n\") }",
    "}",
    "",
    "async function requestWithTimeout(operation, timeout, message) {",
    "  let timer",
    "  try {",
    "    return await Promise.race([Promise.resolve().then(operation), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), Math.max(1, timeout)) })])",
    "  } finally { clearTimeout(timer) }",
    "}",
    "",
    "async function sessionContext(ctx, sessionID, timeout = 5_000) {",
    "  return requestWithTimeout(() => ctx.session.context({ sessionID }), timeout, \"session context inspection timed out\")",
    "}",
    "",
    "async function createSession(ctx, title, agent, model, activeSessions) {",
    "  const session = await ctx.session.create({ title, agent, model, location: { directory: ctx.location.directory } })",
    "  activeSessions?.add(session.id)",
    "  return session",
    "}",
    "",
    "export default {",
    "  id: \"tiered-native-smoke-observer\",",
    "  async setup(ctx) {",
    "    const events = []",
    "    const registrations = []",
    "    const activeSessions = new Set()",
    "    let progressState = { phase: \"setup\", scenarioID: null, rootSessionID: null, observedAt: Date.now() }",
    "    let stopping = false",
    "    let continuation",
    "    function checkpoint(phase, fields = {}) {",
    "      progressState = { ...progressState, ...fields, phase, observedAt: Date.now() }",
    "      writeProgress({ type: \"checkpoint\", ...progressState })",
    "    }",
    "    function ensureActive(stage) {",
    "      if (stopping) throw new Error(\"native smoke cleanup was requested during \" + stage)",
    "    }",
    "    registrations.push(await ctx.session.hook(\"context\", (event) => {",
    "      setImmediate(() => {",
    "        const observed = snapshot(event)",
    "        events.push(observed)",
    "        writeProgress({ type: \"context\", observedAt: Date.now(), scenarioID: progressState.scenarioID, rootSessionID: progressState.rootSessionID, ...observed })",
    "      })",
    "    }))",
    "    for (const phase of [\"before\", \"after\"]) {",
    "      registrations.push(await ctx.tool.hook(\"execute.\" + phase, (event) => writeProgress(compactTool(event, phase, progressState))))",
    "    }",
    "    checkpoint(\"ready\")",
    "    writeFileSync(markerPath, \"setup complete\")",
    "    continuation = new Promise((resolveContinuation) => setImmediate(() => {",
    "      if (stopping) { resolveContinuation(); return }",
    "      void (async () => {",
    "        try {",
    "          const directPrompts = {",
    "            fast: \"Return exactly NATIVE_FAST_OK without using tools.\",",
    "            medium: \"Use the patch tool exactly once to create native-smoke-medium.txt containing exactly MEDIUM_EDIT_OK, then return exactly NATIVE_MEDIUM_OK. Do not use other tools.\",",
    "            heavy: \"Use the shell tool exactly once to run printf HEAVY_SHELL_OK > native-smoke-heavy.txt, then return exactly NATIVE_HEAVY_OK. Do not use other tools.\",",
    "          }",
    "          const results = {}",
    "          for (const tier of tiers) {",
    "            ensureActive(\"direct session start\")",
    "            checkpoint(\"direct-session-create\", { scenarioID: tier, rootSessionID: null })",
    "            const session = await createSession(ctx, `[native smoke] direct ${tier}`, tier, directModels[tier], activeSessions)",
    "            checkpoint(\"prompt\", { scenarioID: tier, rootSessionID: session.id })",
    "            await ctx.session.prompt({ sessionID: session.id, text: directPrompts[tier] })",
    "            checkpoint(\"wait\", { scenarioID: tier, rootSessionID: session.id })",
    "            await ctx.session.wait({ sessionID: session.id })",
    "            ensureActive(\"direct session wait\")",
    "            results[tier] = session.id",
    "            checkpoint(\"direct-complete\", { scenarioID: tier, rootSessionID: session.id })",
    "            writeProgress({ type: \"scenario-complete\", observedAt: Date.now(), scenarioID: tier, rootSessionID: session.id, result: { id: tier, rootSessionID: session.id } })",
    "          }",
    "          await new Promise((resolve) => setTimeout(resolve, 100))",
    "          const outputs = {}",
    "          for (const tier of tiers) {",
    "            const tierEvent = [...events].reverse().find((event) => event.agent === tier && event.sessionID === results[tier])",
    "            const messages = tierEvent ? await sessionContext(ctx, tierEvent.sessionID) : []",
    "            outputs[tier] = { sessionID: tierEvent?.sessionID, text: messageText(messages) }",
    "          }",
    "          const routingStart = events.length",
    "          checkpoint(\"routing-session-create\", { scenarioID: \"routing\", rootSessionID: null })",
    "          const routingRoot = await createSession(ctx, \"[native smoke] primary routing\", \"build\", rootModel, activeSessions)",
    "          checkpoint(\"routing-prompt\", { scenarioID: \"routing\", rootSessionID: routingRoot.id })",
    "          await ctx.session.prompt({ sessionID: routingRoot.id, text: \"Use the native subagent tool exactly once. Select agent medium and ask it to return exactly NATIVE_ROUTE_MEDIUM_OK without using tools. After it returns, reply exactly NATIVE_ROUTE_OK. Do not call any other tools.\" })",
    "          checkpoint(\"routing-wait\", { scenarioID: \"routing\", rootSessionID: routingRoot.id })",
    "          await ctx.session.wait({ sessionID: routingRoot.id })",
    "          ensureActive(\"routing session wait\")",
    "          const routingChild = await waitForAgentEvent(events, routingStart, \"medium\")",
    "          const routingRootMessages = await sessionContext(ctx, routingRoot.id)",
    "          const routingChildMessages = await sessionContext(ctx, routingChild.sessionID)",
    "          const routing = { rootSessionID: routingRoot.id, childSessionID: routingChild.sessionID, rootText: messageText(routingRootMessages), childText: messageText(routingChildMessages) }",
    "          checkpoint(\"native-tool-checks\", { scenarioID: \"routing\", rootSessionID: routingRoot.id })",
    "          await exerciseNativeTools(ctx, events)",
    "          const tierEvents = events.filter((event) => tiers.includes(event.agent) && results[event.agent] === event.sessionID)",
    "          const routingEvents = events.slice(routingStart)",
    "          checkpoint(\"native-lifecycle\", { scenarioID: \"lifecycle\", rootSessionID: null })",
    "          const lifecycle = await exerciseNativeLifecycle(ctx, events, activeSessions)",
    "          ensureActive(\"native lifecycle\")",
    "          checkpoint(\"complete\", { scenarioID: null, rootSessionID: null })",
    "          writeFileSync(resultPath, JSON.stringify({ expected: expectedTiers, expectedProviderErrorModel: providerErrorModel, tiers: results, outputs, routing, lifecycle, tierEvents, routingEvents, events }))",
    "        } catch (error) {",
    "          const failedFrom = { ...progressState }",
    "          checkpoint(\"failure\", { failedFromPhase: failedFrom.phase, failedFromScenarioID: failedFrom.scenarioID, failedFromRootSessionID: failedFrom.rootSessionID, error: error?.message ?? String(error) })",
    "          writeFileSync(failurePath, JSON.stringify({ message: error?.message ?? String(error), stack: error?.stack, phase: failedFrom.phase, scenarioID: failedFrom.scenarioID, rootSessionID: failedFrom.rootSessionID, events }))",
    "        } finally {",
    "          resolveContinuation()",
    "        }",
    "      })()",
    "    }))",
    "    return async () => {",
    "      stopping = true",
    "      for (const sessionID of activeSessions) {",
    "        try { await requestWithTimeout(() => ctx.session.interrupt({ sessionID, resume: false }), 5_000, \"session interrupt timed out during observer cleanup\") } catch {}",
    "      }",
    "      if (continuation) { try { await Promise.race([continuation, new Promise((resolve) => setTimeout(resolve, 5_000))]) } catch {} }",
    "      for (const registration of [...registrations].reverse()) { try { await requestWithTimeout(() => registration.dispose(), 5_000, \"observer registration disposal timed out\") } catch {} }",
    "    }",
    "  },",
    "}",
    "",
    "async function exerciseNativeTools(ctx, events) {",
    "  const checks = {",
    "    medium: \"Tool-access test: your response is invalid unless you call the patch tool now. Apply this exact patch before saying anything: *** Begin Patch\\n*** Add File: native-smoke-medium.txt\\n+MEDIUM_EDIT_OK\\n*** End Patch. After the patch succeeds, reply exactly TOOL_CHECK_MEDIUM_OK.\",",
    "    heavy: \"Tool-access test: your response is invalid unless you call the shell tool now. Run exactly this command before saying anything: printf HEAVY_SHELL_OK > native-smoke-heavy.txt. After the command succeeds, reply exactly TOOL_CHECK_HEAVY_OK.\",",
    "  }",
    "  for (const [agent, text] of Object.entries(checks)) {",
    "    const child = [...events].reverse().find((event) => event.agent === agent)",
    "    if (!child) throw new Error(`native smoke did not observe ${agent} child for tool check`)",
    "    await ctx.session.prompt({ sessionID: child.sessionID, text })",
    "    await ctx.session.wait({ sessionID: child.sessionID })",
    "  }",
    "}",
    "",
    "async function exerciseNativeLifecycle(ctx, events, activeSessions) {",
    "  const cancellationStart = events.length",
    "  const cancellationRoot = await createSession(ctx, \"[native smoke] cancellation\", \"build\", rootModel, activeSessions)",
    "  let cancellationError",
    "  const cancellationPrompt = ctx.session.prompt({ sessionID: cancellationRoot.id, text: \"Use the native subagent tool exactly once. Select agent fast and ask it to spend a long time producing a detailed research answer. Do not answer until the child returns.\" }).catch((error) => { cancellationError = String(error) })",
    "  const cancellationChild = await waitForAgentEvent(events, cancellationStart, \"fast\")",
    "  const cancellationInterrupt = await withTimeout(ctx.session.interrupt({ sessionID: cancellationRoot.id, resume: false }), 30_000)",
    "  await withTimeout(cancellationPrompt, 30_000)",
    "  const cancellationRootInfo = await waitForOutcome(ctx, cancellationRoot.id, \"interrupted\", 30_000)",
    "  const cancellationChildInfo = await waitForOutcome(ctx, cancellationChild.sessionID, \"interrupted\", 30_000)",
    "  const providerStart = events.length",
    "  const providerRoot = await createSession(ctx, \"[native smoke] provider error\", \"build\", rootModel, activeSessions)",
    "  let providerPromptError",
    "  const providerPrompt = ctx.session.prompt({ sessionID: providerRoot.id, text: \"Use the native subagent tool exactly once. Select agent provider-error and ask it to return exactly PROVIDER_ERROR_SHOULD_NOT_SUCCEED. Do not select another agent or retry with another model.\" }).catch((error) => { providerPromptError = String(error) })",
    "  await withTimeout(providerPrompt, 30_000)",
    "  const providerRootInfo = await waitForCompletion(ctx, providerRoot.id, 30_000)",
    "  const fallbackEvents = events.slice(providerStart).filter((event) => [\"fast\", \"medium\", \"heavy\"].includes(event.agent))",
    "  const providerMessages = await sessionContext(ctx, providerRoot.id)",
    "  const providerToolErrors = failedSubagentErrors(providerMessages)",
    "  return {",
    "    cancellation: { rootSessionID: cancellationRoot.id, childSessionID: cancellationChild.sessionID, interrupt: cancellationInterrupt, rootOutcome: cancellationRootInfo.outcome, childOutcome: cancellationChildInfo.outcome, error: cancellationError },",
    "    providerFailure: { rootSessionID: providerRoot.id, rootOutcome: providerRootInfo.outcome, error: providerPromptError ?? messageErrors(providerMessages), toolErrors: providerToolErrors, fallbackEvents },",
    "  }",
    "}",
    "",
    "async function waitForAgentEvent(events, start, agent) {",
    "  return poll(() => events.slice(start).find((candidate) => candidate.agent === agent), Boolean, 30_000, `native smoke did not observe agent ${agent}`)",
    "}",
    "",
    "async function waitForOutcome(ctx, sessionID, expected, timeout) {",
    "  return poll(() => ctx.session.get({ sessionID }), (session) => session.outcome === expected, timeout, `session ${sessionID} did not reach outcome ${expected}`)",
    "}",
    "",
    "async function waitForCompletion(ctx, sessionID, timeout) {",
    "  return poll(() => ctx.session.get({ sessionID }), (session) => Boolean(session.outcome), timeout, `session ${sessionID} did not complete`)",
    "}",
    "",
    "async function poll(read, matches, timeout, failureMessage) {",
    "  const deadline = Date.now() + timeout",
    "  let latest",
    "  while (Date.now() < deadline) {",
    "    const remaining = Math.max(1, deadline - Date.now())",
    "    const readResult = Promise.resolve().then(read).catch(() => undefined)",
    "    latest = await Promise.race([readResult, new Promise((resolve) => setTimeout(() => resolve(undefined), remaining))])",
    "    if (latest !== undefined && matches(latest)) return latest",
    "    if (Date.now() >= deadline) break",
    "    await new Promise((resolve) => setTimeout(resolve, 100))",
    "  }",
    "  throw new Error(`${failureMessage}: ${JSON.stringify(latest)}`)",
    "}",
    "",
    "async function withTimeout(promise, timeout) {",
    "  return Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error(\"native smoke operation timed out\")), timeout))])",
    "}",
    "",
    "function messageErrors(messages) {",
    "  return messages.flatMap((message) => [message.error, message.retry?.error, ...(message.content ?? []).flatMap((part) => [part.error, part.state?.error])]).filter(Boolean).map((error) => String(error.message ?? error)).join(\"\\n\")",
    "}",
    "",
    "function failedSubagentErrors(messages) {",
    "  return messages.flatMap((message) => (message.content ?? []).filter((part) => part.type === \"tool\" && part.name === \"subagent\" && part.state?.status === \"error\").map((part) => part.state.error)).filter(Boolean)",
    "}",
  ].join("\n")
}

function verify(result, agents, workspace, configuredProviderErrorModel) {
  const fileChecks = {
    medium: { path: join(workspace, "native-smoke-medium.txt"), content: "MEDIUM_EDIT_OK\n", action: "edit" },
    heavy: { path: join(workspace, "native-smoke-heavy.txt"), content: "HEAVY_SHELL_OK", action: "run a shell command" },
  }
  for (const tier of ["fast", "medium", "heavy"]) {
    const events = result.tierEvents.filter((event) => event.agent === tier)
    if (events.length === 0) throw new Error(`native ${tier} agent was never invoked: ${JSON.stringify(result)}`)
    if (new Set(events.map((event) => event.sessionID)).size !== 1) {
      throw new Error(`native ${tier} was invoked more than once: ${JSON.stringify(events)}`)
    }
    const tierEvent = events.at(-1)
    if (tierEvent.hasProtocol) throw new Error(`native ${tier} tier session received the primary routing protocol`)
    if (!tierEvent.model?.providerID || !tierEvent.model?.id) throw new Error(`native ${tier} tier session has no resolved model`)
    if (tierEvent.toolNames.includes("subagent")) throw new Error(`native ${tier} tier session can recurse`)
    const expected = result.expected[tier]
    if (!matchesExpectedModel(tierEvent.model, expected)) {
      throw new Error(`native ${tier} used the wrong model: ${JSON.stringify({ expected, actual: tierEvent.model })}`)
    }
    if (result.outputs[tier]?.text !== `NATIVE_${tier.toUpperCase()}_OK`) {
      throw new Error(`native ${tier} returned the wrong child result: ${JSON.stringify(result.outputs[tier])}`)
    }
    const fileCheck = fileChecks[tier]
    if (fileCheck && (!existsSync(fileCheck.path) || readFileSync(fileCheck.path, "utf8") !== fileCheck.content)) {
      throw new Error(`native ${tier} could not ${fileCheck.action}: ${JSON.stringify(result.outputs[tier])}`)
    }
    const agent = verifyTierAgent(agents, tier, expected, "configured")
    const permissions = agent.permissions ?? []
    const subagentRule = [...permissions].reverse().find(
      (rule) => rule.resource === "*" && (rule.action === "subagent" || rule.action === "*"),
    )
    if (subagentRule?.effect !== "deny") throw new Error(`native ${tier} can recurse: ${JSON.stringify(agent)}`)
    const subagentDenyIndex = permissions.findLastIndex(
      (rule) => rule.resource === "*"
        && rule.effect === "deny"
        && (rule.action === "subagent" || rule.action === "*"),
    )
    if (permissions.slice(subagentDenyIndex + 1).some(
      (rule) => rule.effect !== "deny" && (rule.action === "subagent" || rule.action === "*"),
    )) {
      throw new Error(`native ${tier} has a recursion bypass: ${JSON.stringify(agent)}`)
    }
    if (tier === "fast") {
      const denyAllIndex = permissions.findLastIndex(
        (rule) => rule.action === "*" && rule.resource === "*" && rule.effect === "deny",
      )
      if (denyAllIndex < 0 || permissions.slice(denyAllIndex + 1).some(
        (rule) => rule.effect !== "deny" && !["grep", "glob", "webfetch", "websearch", "read"].includes(rule.action),
      )) {
        throw new Error(`native fast is not read-only: ${JSON.stringify(agent)}`)
      }
    } else {
      for (const action of ["edit", "write", "shell"]) {
        const rule = [...permissions].reverse().find(
          (candidate) => candidate.resource === "*" && (candidate.action === action || candidate.action === "*"),
        )
        if (rule?.effect !== "allow") {
          throw new Error(`native ${tier} cannot perform ${action}: ${JSON.stringify(agent)}`)
        }
      }
    }
  }
  const primary = result.events.find((event) => event.agent === "build" && event.hasProtocol)
  if (!primary) throw new Error(`primary routing protocol was not observed: ${JSON.stringify(result.events)}`)
  if (!primary.toolNames.includes("subagent")) throw new Error("primary session did not expose the native subagent tool")
  const routingChild = result.routingEvents?.find((event) => event.agent === "medium")
  if (!routingChild || routingChild.hasProtocol || routingChild.toolNames.includes("subagent")) {
    throw new Error(`primary routing did not produce a valid medium child: ${JSON.stringify(result.routing)}`)
  }
  if (result.routing?.childText !== "NATIVE_ROUTE_MEDIUM_OK" || result.routing?.rootText !== "NATIVE_ROUTE_OK") {
    throw new Error(`primary routing returned the wrong result: ${JSON.stringify(result.routing)}`)
  }
  if (
    result.lifecycle?.cancellation?.interrupt?.interrupted !== true
    || result.lifecycle?.cancellation?.rootOutcome !== "interrupted"
    || result.lifecycle?.cancellation?.childOutcome !== "interrupted"
  ) {
    throw new Error(`native cancellation was not preserved: ${JSON.stringify(result.lifecycle)}`)
  }
  const providerAgent = agents.find((candidate) => candidate.id === "provider-error")
  const providerFailure = result.lifecycle?.providerFailure
  if (
    result.expectedProviderErrorModel !== configuredProviderErrorModel
    || !["succeeded", "failed"].includes(providerFailure?.rootOutcome)
    || providerAgent?.mode !== "subagent"
    || !matchesExpectedModel(providerAgent?.model, { model: configuredProviderErrorModel })
    || !providerFailure.error
    || !providerFailure.error.includes(configuredProviderErrorModel)
    || !Array.isArray(providerFailure.toolErrors)
    || providerFailure.toolErrors.length === 0
    || !providerFailure.toolErrors.some((error) => String(error?.message ?? error).includes(configuredProviderErrorModel))
    || providerFailure.fallbackEvents?.length !== 0
  ) {
    throw new Error(`native provider failure was not surfaced: ${JSON.stringify(result.lifecycle)}`)
  }
}

function normalizedVariant(actual, expected) {
  return expected === undefined && actual === "default" ? undefined : (actual ?? undefined)
}

async function stopProcess(process) {
  if (process.exitCode !== null || process.signalCode !== null) return
  await new Promise((resolve) => {
    let finished = false
    const finish = () => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      resolve()
    }
    const timer = setTimeout(() => {
      process.kill("SIGKILL")
      finish()
    }, 5_000)
    process.once("exit", finish)
    process.kill("SIGTERM")
  })
}

async function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = net.createServer()
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("could not allocate a TCP port")))
        return
      }
      server.close(() => resolvePort(address.port))
    })
  })
}

async function waitFor(predicate, timeout, getLogs, { nativeTimeout = false } = {}) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100))
  }
  const error = new Error(`OpenCode native-agent smoke timed out\n${getLogs()}`)
  if (nativeTimeout) error.code = "NATIVE_SMOKE_TIMEOUT"
  throw error
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await runNativeSmoke()
  } catch (error) {
    console.error(error?.stack ?? error)
    process.exitCode = 1
  }
}
