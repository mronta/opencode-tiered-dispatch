import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { basename, dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { counterbalancedArmOrder, summarizeMatchedBenchmark } from "./routing-metrics.mjs"
import { scenarios } from "./routing-eval.mjs"
import { parseNativeOptions } from "./opencode-native-smoke.mjs"

const root = resolve(fileURLToPath(new URL("..", import.meta.url)))
const nativeSmoke = join(root, "scripts", "opencode-native-smoke.mjs")
const NATIVE_CLEANUP_GRACE_MS = 10_000
const NATIVE_PROCESS_TIMEOUT_MS = parseNativeOptions([]).timeoutMs + NATIVE_CLEANUP_GRACE_MS

export function parseBenchmarkArgs(argv = []) {
  let runs = 1
  let output
  let help = false
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === "--help" || argument === "-h") {
      help = true
      continue
    }
    if (argument === "--runs" || argument === "--output") {
      const value = argv[++index]
      if (typeof value !== "string" || value.length === 0 || value.startsWith("--")) {
        throw new Error(`${argument} requires a value`)
      }
      if (argument === "--runs") runs = parsePositiveRuns(value)
      else output = resolve(value)
      continue
    }
    if (argument.startsWith("--runs=") || argument.startsWith("--output=")) {
      const separator = argument.indexOf("=")
      const name = argument.slice(0, separator)
      const value = argument.slice(separator + 1)
      if (value.length === 0) throw new Error(`${name} requires a value`)
      if (name === "--runs") runs = parsePositiveRuns(value)
      else output = resolve(value)
      continue
    }
    throw new Error(`unknown routing benchmark option: ${argument}`)
  }
  return {
    runs,
    output: output ?? defaultOutputPath(),
    help,
  }
}

export function parsePositiveRuns(value) {
  if (!/^\d+$/u.test(String(value))) throw new Error(`--runs must be a positive integer, got ${value}`)
  const runs = Number(value)
  if (!Number.isSafeInteger(runs) || runs <= 0) throw new Error(`--runs must be a positive integer, got ${value}`)
  return runs
}

export function benchmarkUsage() {
  return [
    "Usage: npm run benchmark:routing -- [--runs N] [--output PATH]",
    "",
    "Runs both tiered and direct controls in fresh native processes. The package script builds once before this runner starts.",
    "Default --runs is 1 (a smoke comparison); use at least 10 repetitions for meaningful tail quantiles.",
  ].join("\n")
}

export function runBenchmark(options, dependencies = {}) {
  const spawnProcess = dependencies.spawnSync ?? spawnSync
  const { runDirectory, runID } = createInvocationRunDirectory(options.output)
  const records = []

  for (let repetition = 0; repetition < options.runs; repetition += 1) {
    const order = counterbalancedArmOrder(repetition)
    for (const arm of order) {
      const artifactPath = join(runDirectory, `repetition-${String(repetition + 1).padStart(3, "0")}-${arm}.json`)
      const processErrors = []
      let child = { status: null, signal: null }
      try {
        child = spawnProcess(process.execPath, [
          nativeSmoke,
          "--routing-eval",
          "--arm",
          arm,
          "--output",
          artifactPath,
        ], {
          cwd: root,
          env: { ...process.env },
          stdio: "inherit",
          timeout: NATIVE_PROCESS_TIMEOUT_MS,
          killSignal: "SIGTERM",
        })
      } catch (error) {
        processErrors.push(error?.message ?? String(error))
      }
      if (child.error !== undefined) {
        processErrors.push(child.error.code === "ETIMEDOUT"
          ? `native evaluator timed out after ${NATIVE_PROCESS_TIMEOUT_MS}ms`
          : child.error.message ?? String(child.error))
      }
      if (child.status !== 0) processErrors.push(`native evaluator exited with ${child.status ?? `signal ${child.signal}`}`)
      const artifact = readArtifact(artifactPath)
      const artifactProblems = artifactCompletionProblems(artifact, arm)
      const mergedErrors = [
        ...(Array.isArray(artifact?.errors) ? artifact.errors : artifact?.errors === undefined ? [] : [String(artifact.errors)]),
        ...processErrors,
        ...artifactProblems,
      ]
      records.push({
        runID,
        repetition,
        arm,
        order,
        artifactPath,
        exitCode: child.status,
        signal: child.signal ?? null,
        status: child.status === 0 && mergedErrors.length === 0 ? "completed" : "failed",
        artifact: artifact ?? {
          schemaVersion: 1,
          arm,
          results: null,
          reports: [],
          errors: mergedErrors.length > 0 ? mergedErrors : ["native evaluator produced no artifact"],
        },
        errors: mergedErrors,
      })
    }
  }

  const summaryInput = records.map((record) => ({
    ...(record.artifact ?? {}),
    arm: record.arm,
    repetition: record.repetition,
    errors: record.errors,
  }))
  const summary = summarizeMatchedBenchmark(summaryInput, { scenarioIDs: scenarios.map((scenario) => scenario.id) })
  const failedRuns = records.filter((record) => record.status !== "completed")
  const completedRuns = records.filter((record) => record.status === "completed")
  const attemptsByArm = countByArm(records)
  const completedByArm = countByArm(completedRuns)
  const failedByArm = countByArm(failedRuns)
  const pairAttempts = pairedRepetitionCount(records, "attempted")
  const pairCompleted = pairedRepetitionCount(records, "completed")
  const output = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    runID,
    runDirectory,
    runsRequested: options.runs,
    attempts: records.length,
    completedAttempts: completedRuns.length,
    failedAttempts: failedRuns.length,
    attemptsByArm,
    completedByArm,
    failedByArm,
    pairAttempts,
    pairCompleted,
    arms: ["direct", "tiered"],
    buildOnce: true,
    ordering: "counterbalanced: tiered,direct then direct,tiered; one fresh process per arm; no parallel provider calls",
    runs: records,
    summary,
    failures: failedRuns.map((record) => ({
      repetition: record.repetition,
      arm: record.arm,
      artifactPath: record.artifactPath,
      errors: record.errors,
    })),
    qualityGate: {
      processFailures: failedRuns.length,
      pairCompleted,
      pairsRequired: options.runs,
      noImprovementClaim: true,
      note: "Ratios are descriptive matched measurements, not an improvement claim.",
    },
  }
  mkdirSync(dirname(options.output), { recursive: true })
  writeFileSync(options.output, JSON.stringify(output, null, 2) + "\n")
  return { output, failed: failedRuns.length > 0 }
}

export function createInvocationRunDirectory(output) {
  const runRoot = `${output}.runs`
  mkdirSync(runRoot, { recursive: true })
  const runDirectory = mkdtempSync(join(runRoot, `run-${Date.now()}-${process.pid}-`))
  return { runDirectory, runID: basename(runDirectory) }
}

export function artifactOwnershipProblems(artifact, expectedArm) {
  if (artifact === undefined) return ["native evaluator produced no artifact"]
  const problems = []
  if (artifact.arm !== expectedArm) problems.push(`artifact arm mismatch: expected ${expectedArm}, got ${String(artifact.arm)}`)
  if (artifact.schemaVersion !== undefined && artifact.schemaVersion !== 1) {
    problems.push(`unsupported native artifact schema: ${String(artifact.schemaVersion)}`)
  }
  return problems
}

/**
 * A zero exit status only proves that the native runner process stopped
 * cleanly.  Completion is an evidence claim about the artifact: both arms
 * must contain exactly the selected scenario set and every report must expose
 * an explicit, empty problems array.
 */
export function artifactCompletionProblems(artifact, expectedArm, expectedScenarios = scenarios) {
  if (artifact === undefined) return ["native evaluator produced no artifact"]
  const problems = artifactOwnershipProblems(artifact, expectedArm)
  if (!Array.isArray(artifact.errors)) problems.push("artifact errors is missing or is not an array")
  problems.push(...exactArtifactIDProblems("results", artifact.results, expectedScenarios))
  problems.push(...exactArtifactIDProblems("reports", artifact.reports, expectedScenarios))

  if (Array.isArray(artifact.reports)) {
    for (const report of artifact.reports) {
      const id = report?.id
      if (!isRecord(report) || !Array.isArray(report.problems)) {
        problems.push(`artifact report ${String(id)} is missing its problems array`)
      } else if (report.problems.length > 0) {
        problems.push(`artifact report ${String(id)} contains problems: ${report.problems.map(String).join("; ")}`)
      }
    }
  }
  return problems
}

function exactArtifactIDProblems(label, values, expectedScenarios) {
  if (!Array.isArray(values)) return [`artifact ${label} is missing or is not an array`]
  const expectedIDs = expectedScenarios.map((scenario) => scenario.id)
  const expectedSet = new Set(expectedIDs)
  const counts = new Map()
  const problems = []
  for (const value of values) {
    const id = value?.id
    counts.set(id, (counts.get(id) ?? 0) + 1)
    if (!expectedSet.has(id)) problems.push(`unexpected artifact ${label} id: ${String(id)}`)
  }
  for (const id of expectedIDs) {
    const count = counts.get(id) ?? 0
    if (count === 0) problems.push(`missing artifact ${label} id: ${id}`)
    if (count > 1) problems.push(`duplicate artifact ${label} id: ${id}`)
  }
  return problems
}

function countByArm(records) {
  return Object.fromEntries(["direct", "tiered"].map((arm) => [arm, records.filter((record) => record.arm === arm).length]))
}

function pairedRepetitionCount(records, mode) {
  const byRepetition = new Map()
  for (const record of records) {
    const arms = byRepetition.get(record.repetition) ?? new Map()
    arms.set(record.arm, record)
    byRepetition.set(record.repetition, arms)
  }
  return [...byRepetition.values()].filter((arms) => {
    if (!arms.has("direct") || !arms.has("tiered")) return false
    return mode === "completed"
      ? arms.get("direct").status === "completed" && arms.get("tiered").status === "completed"
      : true
  }).length
}

function defaultOutputPath() {
  return join("/tmp", "opencode", `routing-benchmark-${Date.now()}-${process.pid}.json`)
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function readArtifact(filename) {
  if (!existsSync(filename)) return undefined
  try {
    return JSON.parse(readFileSync(filename, "utf8"))
  } catch (error) {
    return { errors: [`could not parse native artifact ${basename(filename)}: ${error.message}`] }
  }
}

function main() {
  let options
  try {
    options = parseBenchmarkArgs(process.argv.slice(2))
  } catch (error) {
    console.error(error.message)
    console.error(benchmarkUsage())
    process.exitCode = 2
    return
  }
  if (options.help) {
    console.log(benchmarkUsage())
    return
  }
  const result = runBenchmark(options)
  console.log(`Routing benchmark artifact: ${options.output}`)
  if (result.failed) process.exitCode = 1
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
