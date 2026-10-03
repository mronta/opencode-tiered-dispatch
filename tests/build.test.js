import { afterEach, describe, expect, it } from "vitest"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { build, deferSignals } from "../scripts/build.mjs"

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
