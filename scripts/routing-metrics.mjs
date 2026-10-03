import { getEncoding } from "js-tiktoken"

const READ_TOOLS = new Set(["read", "glob", "grep", "webfetch", "websearch"])
const TOKEN_KEYS = Object.freeze(["input", "output", "reasoning", "cacheRead", "cacheWrite"])
const TOKENIZER_NAME = "o200k_base"

let tokenizer

/**
 * Return a linear-interpolated quantile over finite numeric observations.
 * Missing observations are ignored by design; callers retain their explicit
 * sample counts and unknown values alongside the returned quantile.
 */
export function quantile(values, probability) {
  if (!Array.isArray(values)) throw new TypeError("quantile values must be an array")
  if (!Number.isFinite(probability) || probability < 0 || probability > 1) {
    throw new RangeError("quantile probability must be between 0 and 1")
  }
  const ordered = values.filter(Number.isFinite).sort((left, right) => left - right)
  if (ordered.length === 0) return null
  if (ordered.length === 1) return ordered[0]
  const index = (ordered.length - 1) * probability
  const lower = Math.floor(index)
  const upper = Math.ceil(index)
  if (lower === upper) return ordered[lower]
  return ordered[lower] + (ordered[upper] - ordered[lower]) * (index - lower)
}

export function counterbalancedArmOrder(repetition) {
  if (!Number.isInteger(repetition) || repetition < 0) {
    throw new RangeError("repetition must be a non-negative integer")
  }
  return repetition % 2 === 0 ? ["tiered", "direct"] : ["direct", "tiered"]
}

/**
 * Summarize one native observer result without changing or validating the
 * trace.  Validation remains in routing-eval; this module only measures the
 * evidence that was recorded.
 */
export function summarizeRoutingTrace(trace) {
  const source = trace && typeof trace === "object" ? trace : {}
  const tools = Array.isArray(source.tools) ? source.tools : []
  const contexts = Array.isArray(source.contexts) ? source.contexts : []
  const sessions = Array.isArray(source.sessions) ? source.sessions : []
  const rootSessionID = typeof source.rootSessionID === "string" ? source.rootSessionID : undefined
  const before = tools.filter((event) => event?.phase === "before")
  const afterByIdentity = new Map(
    tools
      .filter((event) => event?.phase === "after")
      .map((event) => [toolIdentity(event), event]),
  )
  const dispatches = before
    .filter((event) => event?.tool === "subagent" && event.sessionID === rootSessionID)
    .sort(compareSequence)
  const rootSessions = sessions.filter((session) => session?.sessionID === rootSessionID)
  const childSessions = sessions.filter((session) => session?.sessionID !== rootSessionID)

  const rootUsage = summarizeSessionGroup(rootSessions)
  const tierUsage = {}
  for (const session of childSessions) {
    const tier = typeof session?.agent === "string" ? session.agent : "unknown"
    const group = tierUsage[tier] ?? []
    group.push(session)
    tierUsage[tier] = group
  }
  const tiers = Object.fromEntries(Object.entries(tierUsage).map(([tier, group]) => [tier, summarizeSessionGroup(group)]))
  const totalUsage = summarizeSessionGroup([...rootSessions, ...childSessions])
  const attribution = summarizeUsageAttribution(sessions)

  const readEvents = before.filter((event) => READ_TOOLS.has(event?.tool))
  const primaryReads = readEvents.filter((event) => event.sessionID === rootSessionID)
  const childReads = readEvents.filter((event) => event.sessionID !== rootSessionID)
  const readFingerprints = readEvents.map(readFingerprint)
  const uniqueReads = new Set(readFingerprints)
  const firstDispatch = dispatches[0]
  const readsBeforeDelegation = primaryReads.filter((event) => firstDispatch === undefined || compareSequence(event, firstDispatch) < 0).length
  const readCountsByTool = countBy(readEvents, (event) => event.tool)
  const repeatedReadsByTool = {}
  for (const [key, count] of countValues(readFingerprints)) {
    if (count > 1) {
      const separator = key.indexOf(":")
      const tool = separator < 0 ? key : key.slice(0, separator)
      repeatedReadsByTool[tool] = (repeatedReadsByTool[tool] ?? 0) + count - 1
    }
  }

  const dispatchDurations = dispatches.map((dispatch) => {
    const completion = afterByIdentity.get(toolIdentity(dispatch))
    const start = eventTime(dispatch)
    const end = eventTime(completion)
    return {
      agent: dispatch.input?.agent ?? null,
      sessionID: dispatch.sessionID ?? null,
      childSessionID: structuredChildSessionID(completion),
      sequence: Number.isInteger(dispatch.seq) ? dispatch.seq : null,
      durationMs: start !== null && end !== null && end >= start ? end - start : null,
    }
  })
  const firstDispatchAt = eventTime(firstDispatch)
  const executionStartedAt = finite(source.executionStartedAt ?? source.executionStartAt)
  const timeToFirstDelegationMs = firstDispatchAt !== null && executionStartedAt !== null && firstDispatchAt >= executionStartedAt
    ? firstDispatchAt - executionStartedAt
    : null

  const handoffs = []
  for (let index = 0; index < dispatches.length; index += 1) {
    const dispatch = dispatches[index]
    if (dispatch.input?.agent === "fast") continue
    const discovery = [...dispatches.slice(0, index)].reverse().find((candidate) => candidate.input?.agent === "fast")
    if (discovery === undefined) continue
    const discoveryCompletion = afterByIdentity.get(toolIdentity(discovery))
    const evidence = structuredOutput(discoveryCompletion)
    const prompt = typeof dispatch.input?.prompt === "string" ? dispatch.input.prompt : null
    const evidenceText = typeof evidence?.output === "string" ? evidence.output : null
    handoffs.push({
      from: "fast",
      to: dispatch.input?.agent ?? null,
      fromSessionID: structuredChildSessionID(discoveryCompletion),
      promptChars: prompt === null ? null : prompt.length,
      promptTokens: prompt === null ? null : proxyTokenCount(prompt),
      evidenceChars: evidenceText === null ? null : evidenceText.length,
      evidenceTokens: evidenceText === null ? null : proxyTokenCount(evidenceText),
      tokenizer: TOKENIZER_NAME,
    })
  }

  const modelCallCounts = {
    root: modelCallCount(rootSessions),
    children: modelCallCount(childSessions),
  }

  return {
    id: source.id ?? null,
    rootSessionID: rootSessionID ?? null,
    executionMs: finite(source.executionElapsedMs),
    verifierMs: finite(source.verifierElapsedMs),
    harnessMs: finite(source.harnessOverheadMs),
    totalMs: finite(source.elapsedMs),
    timeToFirstDelegationMs,
    dispatchDurations,
    handoffs,
    rootContextCount: contexts.filter((context) => context?.sessionID === rootSessionID).length,
    modelCallCounts,
    rootModelCallCount: modelCallCounts.root,
    childModelCallCount: modelCallCounts.children,
    childCalls: dispatches.length,
    childSessionCount: childSessions.length,
    usage: {
      root: rootUsage,
      tiers,
      total: totalUsage,
      byModel: attribution.byModel,
      byRequest: attribution.byRequest,
    },
    // `cost` is the schema's numeric Money.USD value.  Keep the alias next to
    // the explicit USD name so JSON consumers do not infer a different unit.
    costUSD: totalUsage.costUSD,
    cost: totalUsage.costUSD,
    tokens: totalUsage.tokens,
    reads: {
      total: readEvents.length,
      primary: primaryReads.length,
      child: childReads.length,
      beforeFirstDelegation: readsBeforeDelegation,
      repeated: readEvents.length - uniqueReads.size,
      byTool: readCountsByTool,
      repeatedByTool: repeatedReadsByTool,
    },
  }
}

/**
 * Build matched summaries from native-smoke artifacts.  Each artifact is one
 * fresh process and one arm.  Failed process artifacts remain samples: their
 * measured duration/cost is not silently removed from the quantiles.
 */
export function summarizeMatchedBenchmark(runArtifacts, options = {}) {
  if (!Array.isArray(runArtifacts)) throw new TypeError("benchmark artifacts must be an array")
  const scenarioIDs = options.scenarioIDs ?? discoverScenarioIDs(runArtifacts)
  const samples = []

  for (const artifact of runArtifacts) {
    const arm = artifact?.arm ?? "unknown"
    const repetition = Number.isInteger(artifact?.repetition) ? artifact.repetition : null
    const runErrors = collectErrors(artifact)
    const results = Array.isArray(artifact?.results) ? artifact.results : []
    const reports = Array.isArray(artifact?.reports) ? artifact.reports : []
    for (const scenarioID of scenarioIDs) {
      const result = results.find((candidate) => candidate?.id === scenarioID)
      const report = reports.find((candidate) => candidate?.id === scenarioID)
      const metrics = result === undefined
        ? null
        : { ...summarizeRoutingTrace(result), startupMs: finite(artifact?.startupMs) }
      const reportProblems = Array.isArray(report?.problems) ? report.problems : []
      const errors = [...runErrors, ...reportProblems]
      const success = result !== undefined && runErrors.length === 0 && report !== undefined && reportProblems.length === 0
      samples.push({
        arm,
        repetition,
        scenario: scenarioID,
        status: success ? "succeeded" : "failed",
        success,
        errors,
        metrics,
        report: report ?? null,
        result: result ?? null,
      })
    }
  }

  const summaryByKey = new Map()
  const pairingByScenario = new Map()
  for (const scenarioID of scenarioIDs) {
    const scenarioSamples = samples.filter((sample) => sample.scenario === scenarioID)
    const pairing = pairSuccessfulSamples(scenarioSamples)
    pairingByScenario.set(scenarioID, pairing)
    for (const arm of ["direct", "tiered"]) {
      const armSamples = scenarioSamples.filter((sample) => sample.arm === arm)
      summaryByKey.set(`${scenarioID}/${arm}`, summarizeSamples(scenarioID, arm, armSamples, pairing))
    }
  }
  const scenarioSummaries = scenarioIDs.map((scenario) => ({
    scenario,
    arms: {
      direct: summaryByKey.get(`${scenario}/direct`),
      tiered: summaryByKey.get(`${scenario}/tiered`),
    },
  }))
  const comparisons = scenarioIDs.map((scenario) => compareScenario(
    scenario,
    summaryByKey.get(`${scenario}/direct`),
    summaryByKey.get(`${scenario}/tiered`),
    pairingByScenario.get(scenario),
  ))

  return {
    scenarioIDs,
    samples,
    scenarioSummaries,
    comparisons,
    qualityGate: {
      bothArmsPresent: comparisons.every((comparison) => comparison.qualityGate.bothArmsPresent),
      allComparisonsHaveSamples: comparisons.every((comparison) => comparison.qualityGate.matchedSuccessfulPairs > 0),
      note: "Ratios are descriptive only; they do not establish an improvement claim.",
    },
  }
}

function summarizeSamples(scenario, arm, samples, pairing) {
  const successes = samples.filter((sample) => sample.success).length
  const failures = samples.length - successes
  return {
    scenario,
    arm,
    n: samples.length,
    successes,
    failures,
    quantiles: {
      startupMs: pairedMetricQuantiles(pairing, arm, "startupMs"),
      executionMs: pairedMetricQuantiles(pairing, arm, "executionMs"),
      verifierMs: pairedMetricQuantiles(pairing, arm, "verifierMs"),
      harnessMs: pairedMetricQuantiles(pairing, arm, "harnessMs"),
      totalMs: pairedMetricQuantiles(pairing, arm, "totalMs"),
      costUSD: pairedMetricQuantiles(pairing, arm, "costUSD"),
    },
    performance: {
      matchedSuccessfulPairs: pairing.successfulPairs.length,
      note: "Performance quantiles use only successful direct/tiered pairs from the same repetition with a valid metric.",
    },
    usage: summarizeUsage(samples),
    errors: samples.flatMap((sample) => sample.errors.map((message) => ({ repetition: sample.repetition, message }))),
  }
}

function compareScenario(scenario, direct, tiered, pairing) {
  const directSamples = direct?.n ?? 0
  const tieredSamples = tiered?.n ?? 0
  const directSuccesses = direct?.successes ?? 0
  const tieredSuccesses = tiered?.successes ?? 0
  const matchedAttempts = pairing.rawMatchedRepetitions
  const matchedSuccessfulPairs = pairing.successfulPairs.length
  const bothArmsPresent = directSamples > 0 && tieredSamples > 0
  const ratios = {}
  const metricPairs = {}
  for (const metric of ["executionMs", "totalMs", "costUSD"]) {
    const values = pairedMetricValues(pairing, metric)
    metricPairs[metric] = values.direct.length
    const directValue = quantile(values.direct, 0.5)
    const tieredValue = quantile(values.tiered, 0.5)
    const denominatorValid = bothArmsPresent && values.direct.length > 0 && Number.isFinite(directValue) && directValue > 0
    ratios[metric] = {
      tieredOverDirectP50: denominatorValid && Number.isFinite(tieredValue) ? tieredValue / directValue : null,
      denominator: "direct p50",
      denominatorValid,
    }
  }
  return {
    scenario,
    sampleCounts: {
      direct: directSamples,
      tiered: tieredSamples,
      directSuccesses,
      tieredSuccesses,
      matchedAttempts,
      matchedSuccessfulPairs,
      matched: matchedSuccessfulPairs,
      metricPairs,
    },
    qualityGate: {
      bothArmsPresent,
      matchedAttempts,
      matchedSuccessfulPairs,
      metricPairs,
      ratiosRequireBothArmsAndPositiveDirectP50: true,
    },
    ratios,
  }
}

function summarizeUsage(samples) {
  const root = samples.map((sample) => sample.metrics?.usage?.root)
  const total = samples.map((sample) => sample.metrics?.usage?.total)
  const tierNames = [...new Set(samples.flatMap((sample) => Object.keys(sample.metrics?.usage?.tiers ?? {})))].sort()
  return {
    root: summarizeUsageGroups(root),
    tiers: Object.fromEntries(tierNames.map((tier) => [
      tier,
      summarizeUsageGroups(samples.map((sample) => sample.metrics?.usage?.tiers?.[tier])),
    ])),
    total: summarizeUsageGroups(total),
    byModel: summarizeAttributionSamples(samples, "byModel"),
    byRequest: summarizeAttributionSamples(samples, "byRequest"),
  }
}

function summarizeUsageGroups(groups) {
  return {
    tokens: Object.fromEntries(TOKEN_KEYS.map((key) => [key, sampleTotal(groups.map((group) => group?.tokens?.[key]))])),
    costUSD: sampleTotal(groups.map((group) => group?.costUSD)),
  }
}

function summarizeAttributionSamples(samples, category) {
  const keys = [...new Set(samples.flatMap((sample) => Object.keys(sample.metrics?.usage?.[category] ?? {})))].sort()
  return Object.fromEntries(keys.map((key) => {
    const observations = samples
      .map((sample) => ({ repetition: sample.repetition, value: sample.metrics?.usage?.[category]?.[key] }))
      .filter((entry) => entry.value !== undefined)
    const values = observations.map((entry) => entry.value)
    const model = values.find((value) => value.model !== null)?.model ?? null
    const requestID = values.find((value) => value.requestID !== null)?.requestID ?? null
    return [key, {
      identity: key,
      model,
      requestID,
      observations: observations.length,
      unavailableSamples: samples.length - observations.length,
      calls: observations.reduce((sum, entry) => sum + (Number.isFinite(entry.value.calls) ? entry.value.calls : 0), 0),
      tokens: Object.fromEntries(TOKEN_KEYS.map((token) => [token, sampleTotal(observations.map((entry) => entry.value.tokens?.[token]))])),
      costUSD: sampleTotal(observations.map((entry) => entry.value.costUSD)),
      repetitions: observations.map((entry) => entry.repetition),
    }]
  }))
}

function sampleTotal(values) {
  const observed = values.filter(Number.isFinite)
  return {
    total: observed.length === values.length && values.length > 0 ? observed.reduce((sum, value) => sum + value, 0) : null,
    samples: observed.length,
    unknown: values.length - observed.length,
  }
}

function pairSuccessfulSamples(samples) {
  const byRepetition = new Map()
  for (const sample of samples) {
    const arms = byRepetition.get(sample.repetition) ?? { direct: [], tiered: [] }
    if (sample.arm === "direct" || sample.arm === "tiered") arms[sample.arm].push(sample)
    byRepetition.set(sample.repetition, arms)
  }
  const rawMatchedRepetitions = [...byRepetition.values()].filter((arms) => arms.direct.length > 0 && arms.tiered.length > 0).length
  const successfulPairs = []
  for (const [repetition, arms] of byRepetition) {
    if (arms.direct.length !== 1 || arms.tiered.length !== 1) continue
    if (!arms.direct[0].success || !arms.tiered[0].success) continue
    successfulPairs.push({ repetition, direct: arms.direct[0], tiered: arms.tiered[0] })
  }
  return { rawMatchedRepetitions, successfulPairs }
}

function pairedMetricValues(pairing, metric) {
  const direct = []
  const tiered = []
  for (const pair of pairing.successfulPairs) {
    const directValue = pair.direct.metrics?.[metric]
    const tieredValue = pair.tiered.metrics?.[metric]
    if (!Number.isFinite(directValue) || !Number.isFinite(tieredValue)) continue
    direct.push(directValue)
    tiered.push(tieredValue)
  }
  return { direct, tiered }
}

function pairedMetricQuantiles(pairing, arm, metric) {
  const values = pairedMetricValues(pairing, metric)[arm]
  return {
    p50: quantile(values, 0.5),
    p95: quantile(values, 0.95),
    samples: values.filter(Number.isFinite).length,
    unknown: pairing.successfulPairs.length - values.filter(Number.isFinite).length,
    pairedSuccessful: pairing.successfulPairs.length,
  }
}

function summarizeSessionGroup(sessions) {
  const tokenRecords = sessions.map((session) => sessionTokens(session))
  const tokens = aggregateTokens(tokenRecords)
  const costs = sessions.map((session) => sessionCost(session))
  const costUSD = aggregateNumbers(costs)
  return {
    sessions: sessions.length,
    modelCalls: modelCallCount(sessions),
    tokens,
    costUSD,
  }
}

function summarizeUsageAttribution(sessions) {
  const records = []
  for (const session of sessions) {
    const executionModel = actualModel(session?.model)
    const usage = Array.isArray(session?.usage) && session.usage.length > 0
      ? session.usage
      : [{
        messageID: null,
        requestID: null,
        model: executionModel,
        modelProvenance: executionModel === null ? "unknown" : "execution-context",
        tokens: session?.tokens,
        cost: session?.cost,
      }]
    for (const entry of usage) {
      const entryModel = actualModel(entry?.model)
      const model = entryModel ?? executionModel
      records.push({
        requestID: typeof entry?.messageID === "string" && entry.messageID.length > 0
          ? entry.messageID
          : typeof entry?.requestID === "string" && entry.requestID.length > 0 ? entry.requestID : null,
        model,
        modelProvenance: entry?.modelProvenance
          ?? (entryModel !== null ? "message" : model === null ? "unknown" : "execution-context"),
        tokens: entry?.tokens,
        cost: entry?.cost,
      })
    }
  }
  return {
    byModel: groupAttribution(records, (record) => modelKey(record.model), (record) => ({
      model: record.model,
      requestID: null,
      modelProvenance: record.modelProvenance,
    })),
    byRequest: groupAttribution(records, (record) => record.requestID ?? "unknown", (record) => ({
      model: record.model,
      requestID: record.requestID,
      modelProvenance: record.modelProvenance,
    })),
  }
}

function groupAttribution(records, keyOf, identityOf) {
  const groups = new Map()
  for (const record of records) {
    const key = keyOf(record)
    const group = groups.get(key) ?? {
      identity: key,
      model: null,
      requestID: null,
      modelProvenance: null,
      calls: 0,
      records: [],
    }
    const identity = identityOf(record)
    if (group.model === null) group.model = identity.model
    else if (identity.model !== null && modelKey(group.model) !== modelKey(identity.model)) group.model = null
    if (group.requestID === null) group.requestID = identity.requestID
    else if (identity.requestID !== null && group.requestID !== identity.requestID) group.requestID = null
    if (group.modelProvenance === null) group.modelProvenance = identity.modelProvenance
    else if (identity.modelProvenance !== null && group.modelProvenance !== identity.modelProvenance) group.modelProvenance = "mixed"
    group.calls += 1
    group.records.push(record)
    groups.set(key, group)
  }
  return Object.fromEntries([...groups].map(([key, group]) => [key, {
    identity: group.identity,
    model: group.model,
    requestID: group.requestID,
    modelProvenance: group.modelProvenance ?? "unknown",
    calls: group.calls,
    tokens: aggregateTokens(group.records.map((record) => normalizeTokens(record.tokens))),
    costUSD: aggregateNumbers(group.records.map((record) => finite(record.cost))),
  }]))
}

function actualModel(value) {
  if (isRecord(value) && typeof value.providerID === "string" && typeof value.id === "string") {
    return {
      providerID: value.providerID,
      id: value.id,
      ...(typeof value.variant === "string" ? { variant: value.variant } : {}),
    }
  }
  if (typeof value === "string") {
    const [reference, embeddedVariant] = value.split("#", 2)
    const separator = reference.indexOf("/")
    if (separator > 0 && separator < reference.length - 1) {
      return {
        providerID: reference.slice(0, separator),
        id: reference.slice(separator + 1),
        ...(embeddedVariant === undefined ? {} : { variant: embeddedVariant }),
      }
    }
  }
  return null
}

function modelKey(model) {
  if (model === null) return "unknown"
  return `${model.providerID}/${model.id}${model.variant === undefined ? "" : `#${model.variant}`}`
}

function sessionTokens(session) {
  if (isRecord(session?.tokens)) return normalizeTokens(session.tokens)
  const usage = Array.isArray(session?.usage) ? session.usage : []
  if (usage.length === 0) return normalizeTokens(undefined)
  return aggregateTokens(usage.map((entry) => normalizeTokens(entry?.tokens)))
}

function sessionCost(session) {
  if (Number.isFinite(session?.cost)) return session.cost
  const usage = Array.isArray(session?.usage) ? session.usage : []
  if (usage.length === 0 || usage.some((entry) => !Number.isFinite(entry?.cost))) return null
  return usage.reduce((sum, entry) => sum + entry.cost, 0)
}

function normalizeTokens(tokens) {
  return {
    input: finite(tokens?.input),
    output: finite(tokens?.output),
    reasoning: finite(tokens?.reasoning),
    cacheRead: finite(tokens?.cache?.read),
    cacheWrite: finite(tokens?.cache?.write),
  }
}

function aggregateTokens(records) {
  if (records.length === 0) return Object.fromEntries(TOKEN_KEYS.map((key) => [key, null]))
  return Object.fromEntries(TOKEN_KEYS.map((key) => {
    const values = records.map((record) => record?.[key])
    return [key, values.every(Number.isFinite) ? values.reduce((sum, value) => sum + value, 0) : null]
  }))
}

function aggregateNumbers(values) {
  return values.length > 0 && values.every(Number.isFinite)
    ? values.reduce((sum, value) => sum + value, 0)
    : null
}

function modelCallCount(sessions) {
  return sessions.reduce((sum, session) => {
    if (Array.isArray(session?.usage) && session.usage.length > 0) return sum + session.usage.length
    return sum + (isRecord(session?.tokens) ? 1 : 0)
  }, 0)
}

function structuredOutput(event) {
  const output = event?.resultOutput ?? event?.result?.output
  return isRecord(output) ? output : null
}

function structuredChildSessionID(event) {
  const output = structuredOutput(event)
  return typeof output?.sessionID === "string" ? output.sessionID : null
}

function proxyTokenCount(text) {
  try {
    tokenizer ??= getEncoding(TOKENIZER_NAME)
    return tokenizer.encode(text).length
  } catch {
    return null
  }
}

function readFingerprint(event) {
  let input
  try { input = JSON.stringify(event?.input) } catch { input = String(event?.input) }
  return `${event?.tool ?? "unknown"}:${input}`
}

function countBy(values, keyOf) {
  const counts = {}
  for (const value of values) {
    const key = keyOf(value)
    counts[key] = (counts[key] ?? 0) + 1
  }
  return counts
}

function countValues(values) {
  const counts = new Map()
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1)
  return counts
}

function toolIdentity(event) {
  return `${event?.sessionID}/${event?.messageID}/${event?.id}/${event?.tool}`
}

function sequenceOf(event) {
  return Number.isInteger(event?.seq) ? event.seq : Number.POSITIVE_INFINITY
}

function compareSequence(left, right) {
  return sequenceOf(left) - sequenceOf(right)
}

function eventTime(event) {
  return finite(event?.observedAt ?? event?.time ?? event?.timestamp)
}

function finite(value) {
  return Number.isFinite(value) ? value : null
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function collectErrors(artifact) {
  const errors = []
  if (Array.isArray(artifact?.errors)) errors.push(...artifact.errors.map(errorMessage))
  else if (artifact?.errors !== undefined) errors.push(errorMessage(artifact.errors))
  if (artifact?.failure !== undefined && artifact.failure !== null) errors.push(errorMessage(artifact.failure))
  return errors.filter(Boolean)
}

function errorMessage(error) {
  if (typeof error === "string") return error
  if (error?.message !== undefined) return String(error.message)
  try { return JSON.stringify(error) } catch { return String(error) }
}

function discoverScenarioIDs(artifacts) {
  const ids = []
  const seen = new Set()
  for (const artifact of artifacts) {
    for (const result of Array.isArray(artifact?.results) ? artifact.results : []) {
      if (typeof result?.id === "string" && !seen.has(result.id)) {
        seen.add(result.id)
        ids.push(result.id)
      }
    }
  }
  return ids
}
