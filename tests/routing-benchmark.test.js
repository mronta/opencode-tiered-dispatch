import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { counterbalancedArmOrder } from "../scripts/routing-metrics.mjs"
import {
  parseBenchmarkArgs,
  parsePositiveRuns,
  runBenchmark,
} from "../scripts/routing-benchmark.mjs"

const SCENARIO_IDS = ["trivial", "known-scope", "discover-implement", "discover-analyze"]

function minimalArtifact(arm, { results = SCENARIO_IDS.map((id) => ({ id })), reports = SCENARIO_IDS.map((id) => ({ id, problems: [] })), errors = [] } = {}) {
  return { schemaVersion: 1, arm, results, reports, errors }
}

describe("routing benchmark arguments", () => {
  it("defaults to one repetition and accepts explicit output", () => {
    const options = parseBenchmarkArgs(["--runs", "2", "--output", "/tmp/routing-result.json"])
    expect(options).toMatchObject({ runs: 2, output: "/tmp/routing-result.json", help: false })
  })

  it("bounds each native evaluator process and requests graceful termination", () => {
    const directory = mkdtempSync(join("/tmp", "routing-benchmark-timeout-"))
    let spawnOptions
    try {
      runBenchmark({ runs: 1, output: join(directory, "benchmark.json") }, {
        spawnSync: (_command, _args, options) => {
          spawnOptions = options
          return { status: 1, signal: "SIGTERM" }
        },
      })
      expect(spawnOptions).toMatchObject({ timeout: 610_000, killSignal: "SIGTERM" })
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it("rejects zero, fractional, unsafe, and non-numeric run counts", () => {
    for (const value of ["0", "1.5", "nope", "9007199254740992"]) {
      expect(() => parsePositiveRuns(value)).toThrow(/positive integer/u)
    }
  })

  it("keeps arm ordering deterministic and counterbalanced", () => {
    const orders = [0, 1, 2, 3].map(counterbalancedArmOrder)
    expect(orders).toEqual([
      ["tiered", "direct"],
      ["direct", "tiered"],
      ["tiered", "direct"],
      ["direct", "tiered"],
    ])
  })

  it("uses a unique invocation directory so a no-write child cannot reuse stale evidence", () => {
    const directory = mkdtempSync(join("/tmp", "routing-benchmark-artifact-"))
    try {
      const output = join(directory, "benchmark.json")
      const oldRoot = `${output}.runs`
      mkdirSync(oldRoot, { recursive: true })
      const stalePath = join(oldRoot, "repetition-001-tiered.json")
      writeFileSync(stalePath, JSON.stringify({ schemaVersion: 1, arm: "tiered", results: [{ id: "stale" }], reports: [], errors: [] }))

      const result = runBenchmark({ runs: 1, output }, {
        spawnSync: () => ({ status: 1, signal: null }),
      })
      const records = result.output.runs
      expect(result.failed).toBe(true)
      expect(result.output.runID).toBeTruthy()
      expect(result.output.runDirectory).not.toBe(oldRoot)
      expect(records).toHaveLength(2)
      expect(records.every((record) => record.artifact.results === null)).toBe(true)
      expect(records.every((record) => record.errors.some((error) => /no artifact/u.test(error)))).toBe(true)
      expect(existsSync(stalePath)).toBe(true)
      expect(JSON.parse(readFileSync(output, "utf8")).pairCompleted).toBe(0)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it("reports arm attempts and completed pairs accurately for a partial failure", () => {
    const directory = mkdtempSync(join("/tmp", "routing-benchmark-counts-"))
    try {
      const output = join(directory, "benchmark.json")
      const result = runBenchmark({ runs: 1, output }, {
        spawnSync: (_command, args) => {
          const arm = args[args.indexOf("--arm") + 1]
          const artifact = args[args.indexOf("--output") + 1]
          if (arm === "direct") {
            writeFileSync(artifact, JSON.stringify(minimalArtifact(arm)))
            return { status: 0, signal: null }
          }
          return { status: 1, signal: null }
        },
      })
      expect(result.output).toMatchObject({
        attempts: 2,
        completedAttempts: 1,
        failedAttempts: 1,
        attemptsByArm: { direct: 1, tiered: 1 },
        completedByArm: { direct: 1, tiered: 0 },
        failedByArm: { direct: 0, tiered: 1 },
        pairAttempts: 1,
        pairCompleted: 0,
      })
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it("does not mark empty or malformed artifacts completed on exit zero", () => {
    const cases = [
      { name: "empty", artifact: minimalArtifact("tiered", { results: [], reports: [] }) },
      { name: "duplicate", artifact: minimalArtifact("tiered", { results: [{ id: "trivial" }, { id: "trivial" }, ...SCENARIO_IDS.slice(1).map((id) => ({ id }))] }) },
      { name: "unknown", artifact: minimalArtifact("tiered", { reports: [{ id: "surprise", problems: [] }, ...SCENARIO_IDS.slice(0, -1).map((id) => ({ id, problems: [] }))] }) },
      { name: "report problems", artifact: minimalArtifact("tiered", { reports: SCENARIO_IDS.map((id, index) => ({ id, problems: index === 0 ? ["failed objective"] : [] })) }) },
    ]
    for (const testCase of cases) {
      const directory = mkdtempSync(join("/tmp", `routing-benchmark-${testCase.name}-`))
      try {
        const output = join(directory, "benchmark.json")
        const result = runBenchmark({ runs: 1, output }, {
          spawnSync: (_command, args) => {
            const artifactPath = args[args.indexOf("--output") + 1]
            writeFileSync(artifactPath, JSON.stringify(testCase.artifact))
            return { status: 0, signal: null }
          },
        })
        const records = result.output.runs
        expect(records).toHaveLength(2)
        expect(records.every((record) => record.status === "failed")).toBe(true)
        expect(records.every((record) => record.errors.length > 0)).toBe(true)
      } finally {
        rmSync(directory, { recursive: true, force: true })
      }
    }
  })
})
