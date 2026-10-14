import { afterEach, describe, expect, it } from "vitest"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { build, deferSignals, replaceDist } from "../scripts/build.mjs"

const fixtures = []

afterEach(() => {
  for (const fixture of fixtures.splice(0)) rmSync(fixture, { recursive: true, force: true })
})

describe("transactional build", () => {
  it("retains the prior artifact when compilation fails", async () => {
    const root = fixture()
    mkdirSync(join(root, "dist"))
    writeFileSync(join(root, "dist", "index.js"), "old artifact")

    await expect(build({
      rootDirectory: root,
      compile: async ({ stageDirectory }) => {
        writeFileSync(join(stageDirectory, "partial.js"), "partial artifact")
        return 1
      },
    })).rejects.toThrow("TypeScript compilation exited with code 1")

    expect(readFileSync(join(root, "dist", "index.js"), "utf8")).toBe("old artifact")
    expect(existsSync(join(root, "dist", "partial.js"))).toBe(false)
    expect(buildArtifacts(root)).toEqual([])
  })

  it("replaces the artifact as a whole after successful compilation", async () => {
    const root = fixture()
    mkdirSync(join(root, "dist", "obsolete"), { recursive: true })
    writeFileSync(join(root, "dist", "obsolete", "old.js"), "obsolete artifact")

    await build({
      rootDirectory: root,
      compile: async ({ stageDirectory }) => {
        writeFileSync(join(stageDirectory, "index.js"), "new artifact")
        return 0
      },
    })

    expect(readFileSync(join(root, "dist", "index.js"), "utf8")).toBe("new artifact")
    expect(existsSync(join(root, "dist", "obsolete"))).toBe(false)
    expect(buildArtifacts(root)).toEqual([])
  })

  it("keeps concurrent builds isolated while replacement is lock-contended", async () => {
    const root = fixture()
    const lockPath = join(root, ".dist-replacement.lock")
    mkdirSync(join(root, "dist"))
    writeFileSync(join(root, "dist", "index.js"), "old artifact")
    writeFileSync(lockPath, `${process.pid}:test-holder`)

    let releaseCompilations
    const compilationsReleased = new Promise((resolve) => {
      releaseCompilations = resolve
    })
    let resolveAllCompilations
    const allCompilationsStarted = new Promise((resolve) => {
      resolveAllCompilations = resolve
    })
    let compilationCount = 0
    const compile = async ({ stageDirectory }) => {
      const buildNumber = ++compilationCount
      writeFileSync(join(stageDirectory, "index.js"), `artifact ${buildNumber}`)
      if (buildNumber === 2) resolveAllCompilations()
      await compilationsReleased
      return 0
    }
    const builds = [
      build({ rootDirectory: root, compile, lockPollIntervalMs: 1, lockTimeoutMs: 1_000 }),
      build({ rootDirectory: root, compile, lockPollIntervalMs: 1, lockTimeoutMs: 1_000 }),
    ]

    try {
      await allCompilationsStarted
      expect(buildArtifacts(root)).toHaveLength(3)
      rmSync(lockPath)
      releaseCompilations()
      await expect(Promise.all(builds)).resolves.toEqual([undefined, undefined])

      expect(readdirSync(join(root, "dist"))).toEqual(["index.js"])
      expect(readFileSync(join(root, "dist", "index.js"), "utf8")).toMatch(/^artifact [12]$/u)
      expect(buildArtifacts(root)).toEqual([])
    } finally {
      releaseCompilations()
      await Promise.allSettled(builds)
      rmSync(lockPath, { force: true })
    }
  })

  it("reclaims a stale replacement lock before installing", async () => {
    const root = fixture()
    const lockPath = join(root, ".dist-replacement.lock")
    const staleAt = new Date(Date.now() - 31_000)
    mkdirSync(join(root, "dist"))
    writeFileSync(join(root, "dist", "index.js"), "old artifact")
    writeFileSync(lockPath, "0:stale-holder")
    utimesSync(lockPath, staleAt, staleAt)

    await build({
      rootDirectory: root,
      lockPollIntervalMs: 1,
      lockTimeoutMs: 100,
      compile: async ({ stageDirectory }) => {
        writeFileSync(join(stageDirectory, "index.js"), "new artifact")
        return 0
      },
    })

    expect(readFileSync(join(root, "dist", "index.js"), "utf8")).toBe("new artifact")
    expect(buildArtifacts(root)).toEqual([])
  })

  it("times out without disturbing the existing artifact when replacement stays locked", async () => {
    const root = fixture()
    const lockPath = join(root, ".dist-replacement.lock")
    mkdirSync(join(root, "dist"))
    writeFileSync(join(root, "dist", "index.js"), "old artifact")
    writeFileSync(lockPath, `${process.pid}:test-holder`)

    try {
      await expect(build({
        rootDirectory: root,
        lockPollIntervalMs: 1,
        lockTimeoutMs: 5,
        compile: async ({ stageDirectory }) => {
          writeFileSync(join(stageDirectory, "index.js"), "new artifact")
          return 0
        },
      })).rejects.toThrow("Timed out waiting for .dist-replacement.lock")

      expect(readFileSync(join(root, "dist", "index.js"), "utf8")).toBe("old artifact")
      expect(buildArtifacts(root)).toEqual([".dist-replacement.lock"])
    } finally {
      rmSync(lockPath, { force: true })
    }

    expect(buildArtifacts(root)).toEqual([])
  })

  it("restores the prior artifact when replacement cannot install the stage", async () => {
    const root = fixture()
    mkdirSync(join(root, "dist"))
    writeFileSync(join(root, "dist", "index.js"), "old artifact")

    await expect(replaceDist({
      rootDirectory: root,
      stageDirectory: join(root, ".dist-stage-missing"),
      lockPollIntervalMs: 1,
      lockTimeoutMs: 100,
    })).rejects.toMatchObject({ code: "ENOENT" })

    expect(readFileSync(join(root, "dist", "index.js"), "utf8")).toBe("old artifact")
    expect(buildArtifacts(root)).toEqual([])
  })

  it("defers graceful termination until replacement cleanup can finish", () => {
    const finishSignalDeferral = deferSignals()
    try {
      expect(process.emit("SIGTERM")).toBe(true)
      expect(finishSignalDeferral()).toBe("SIGTERM")
    } finally {
      finishSignalDeferral()
    }
  })
})

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "opencode-tiered-dispatch-build-"))
  fixtures.push(root)
  return root
}

function buildArtifacts(root) {
  return readdirSync(root).filter((name) => name.startsWith(".dist-stage-")
    || name.startsWith(".dist-backup-")
    || name === ".dist-replacement.lock")
}
