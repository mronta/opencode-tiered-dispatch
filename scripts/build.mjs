import { randomUUID } from "node:crypto"
import {
  closeSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs"
import { spawn } from "node:child_process"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const ROOT_DIRECTORY = resolve(fileURLToPath(new URL("..", import.meta.url)))
const REPLACEMENT_LOCK_NAME = ".dist-replacement.lock"
const LOCK_POLL_INTERVAL_MS = 25
const LOCK_TIMEOUT_MS = 30_000
const STALE_LOCK_AGE_MS = 30_000
const FORWARDED_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"]

export class CompilationError extends Error {
  constructor(status, signal) {
    const detail = signal === null || signal === undefined
      ? `exited with code ${status ?? "unknown"}`
      : `was terminated by ${signal}`
    super(`TypeScript compilation ${detail}`)
    this.name = "CompilationError"
    this.status = status
    this.signal = signal
  }
}

/**
 * Compile into a sibling of dist, then install the complete result as dist.
 * The compiler can be replaced in tests with a callback receiving the same
 * context as compileWithTypeScript.
 */
export async function build({
  rootDirectory = ROOT_DIRECTORY,
  compile = compileWithTypeScript,
  lockPollIntervalMs = LOCK_POLL_INTERVAL_MS,
  lockTimeoutMs = LOCK_TIMEOUT_MS,
} = {}) {
  const root = resolve(rootDirectory)
  const stageDirectory = mkdtempSync(join(root, ".dist-stage-"))
  let installed = false
  let pendingSignal

  try {
    const result = await compile({
      rootDirectory: root,
      stageDirectory,
      tsconfigPath: join(root, "tsconfig.build.json"),
    })
    assertCompilationSucceeded(result)

    pendingSignal = await replaceDist({
      rootDirectory: root,
      stageDirectory,
      lockPollIntervalMs,
      lockTimeoutMs,
    })
    installed = true
  } finally {
    // Once installed, stageDirectory no longer exists. This exact path is
    // always owned by this build, so cleanup cannot remove user files.
    if (!installed || pathExists(stageDirectory)) {
      rmSync(stageDirectory, { recursive: true, force: true })
    }
  }

  if (pendingSignal !== undefined) process.kill(process.pid, pendingSignal)
}

export function compileWithTypeScript({ rootDirectory, stageDirectory, tsconfigPath }) {
  const tscPath = resolve(rootDirectory, "node_modules/typescript/bin/tsc")

  return new Promise((resolveCompilation, rejectCompilation) => {
    const child = spawn(
      process.execPath,
      [tscPath, "--project", tsconfigPath, "--outDir", stageDirectory],
      { cwd: rootDirectory, stdio: "inherit" },
    )
    let settled = false

    const signalHandlers = new Map()
    for (const signal of FORWARDED_SIGNALS) {
      const handler = () => {
        if (child.exitCode === null && !child.killed) child.kill(signal)
      }
      signalHandlers.set(signal, handler)
      process.once(signal, handler)
    }

    const cleanupSignalHandlers = () => {
      for (const [signal, handler] of signalHandlers) process.removeListener(signal, handler)
    }
    const settle = (callback, value) => {
      if (settled) return
      settled = true
      cleanupSignalHandlers()
      callback(value)
    }

    child.once("error", (error) => settle(rejectCompilation, error))
    child.once("exit", (status, signal) => {
      if (status === 0 && signal === null) {
        settle(resolveCompilation)
      } else {
        settle(rejectCompilation, new CompilationError(status, signal))
      }
    })
  })
}

export async function replaceDist({
  rootDirectory,
  stageDirectory,
  lockPollIntervalMs = LOCK_POLL_INTERVAL_MS,
  lockTimeoutMs = LOCK_TIMEOUT_MS,
}) {
  const root = resolve(rootDirectory)
  const releaseLock = await acquireReplacementLock(root, lockPollIntervalMs, lockTimeoutMs)
  const finishSignalDeferral = deferSignals()
  const distDirectory = join(root, "dist")
  let backupDirectory
  let backupMoved = false
  let installed = false

  let pendingSignal
  try {
    if (pathExists(distDirectory)) {
      backupDirectory = createUniquePath(root, ".dist-backup-")
      try {
        renameSync(distDirectory, backupDirectory)
        backupMoved = true
      } catch (error) {
        rmSync(backupDirectory, { recursive: true, force: true })
        backupDirectory = undefined
        throw error
      }
    }

    try {
      renameSync(stageDirectory, distDirectory)
      installed = true
    } catch (error) {
      if (restoreBackup({ distDirectory, backupDirectory })) backupDirectory = undefined
      throw error
    }

    if (backupDirectory !== undefined) {
      rmSync(backupDirectory, { recursive: true, force: true })
      backupDirectory = undefined
    }
  } finally {
    try {
      // A failed rename restores the old artifact. If restoration itself was
      // interrupted, leave that exact backup in place rather than deleting it.
      if (!installed && backupDirectory !== undefined && backupMoved) {
        try {
          if (restoreBackup({ distDirectory, backupDirectory })) backupDirectory = undefined
        } catch {
          // The original error is more useful to the caller and the backup
          // remains available for recovery.
        }
      } else if (!installed && backupDirectory !== undefined) {
        rmSync(backupDirectory, { recursive: true, force: true })
        backupDirectory = undefined
      }
    } finally {
      pendingSignal = finishSignalDeferral()
      releaseLock()
    }
  }

  return pendingSignal
}

function assertCompilationSucceeded(result) {
  if (result === undefined || result === null || result === 0) return

  if (typeof result === "object") {
    const status = result.status ?? result.code
    const signal = result.signal
    if (status === 0 && (signal === undefined || signal === null)) return
    throw new CompilationError(status, signal)
  }

  if (typeof result === "number") throw new CompilationError(result, null)
  throw new Error("The build compiler returned an unsupported result")
}

function createUniquePath(root, prefix) {
  const temporaryDirectory = mkdtempSync(join(root, prefix))
  rmSync(temporaryDirectory, { recursive: true, force: true })
  return temporaryDirectory
}

function restoreBackup({ distDirectory, backupDirectory }) {
  if (backupDirectory === undefined || !pathExists(backupDirectory)) return true
  if (pathExists(distDirectory)) return false
  renameSync(backupDirectory, distDirectory)
  return true
}

async function acquireReplacementLock(root, pollIntervalMs, timeoutMs) {
  const lockPath = join(root, REPLACEMENT_LOCK_NAME)
  const token = `${process.pid}:${randomUUID()}`
  const startedAt = Date.now()

  while (true) {
    try {
      let descriptor
      try {
        descriptor = openSync(lockPath, "wx")
        writeFileSync(descriptor, token)
      } catch (error) {
        if (descriptor !== undefined) {
          try {
            closeSync(descriptor)
          } finally {
            rmSync(lockPath, { force: true })
          }
        }
        throw error
      }
      closeSync(descriptor)
      descriptor = undefined
      return () => releaseReplacementLock(lockPath, token)
    } catch (error) {
      if (error?.code !== "EEXIST") throw error
      if (staleLock(lockPath)) {
        rmSync(lockPath, { force: true })
        continue
      }
      if (Date.now() - startedAt >= timeoutMs) {
        throw new Error(`Timed out waiting for ${REPLACEMENT_LOCK_NAME}`)
      }
      await wait(pollIntervalMs)
    }
  }
}

function releaseReplacementLock(lockPath, token) {
  try {
    if (readFileSync(lockPath, "utf8") === token) unlinkSync(lockPath)
  } catch (error) {
    if (error?.code !== "ENOENT") throw error
  }
}

function staleLock(lockPath) {
  let contents
  try {
    contents = readFileSync(lockPath, "utf8").trim()
  } catch (error) {
    return error?.code === "ENOENT"
  }

  const pid = Number(contents.split(":", 1)[0])
  if (Number.isInteger(pid) && pid > 0) {
    try {
      process.kill(pid, 0)
      return false
    } catch (error) {
      return error?.code === "ESRCH"
    }
  }

  try {
    return Date.now() - statSync(lockPath).mtimeMs >= STALE_LOCK_AGE_MS
  } catch (error) {
    return error?.code === "ENOENT"
  }
}

function wait(milliseconds) {
  return new Promise((resolveWait) => setTimeout(resolveWait, milliseconds))
}

export function deferSignals() {
  let pendingSignal
  const signalHandlers = new Map()
  for (const signal of FORWARDED_SIGNALS) {
    const handler = () => {
      pendingSignal ??= signal
    }
    signalHandlers.set(signal, handler)
    process.on(signal, handler)
  }

  return () => {
    for (const [signal, handler] of signalHandlers) process.removeListener(signal, handler)
    return pendingSignal
  }
}

function pathExists(path) {
  try {
    lstatSync(path)
    return true
  } catch (error) {
    if (error?.code === "ENOENT") return false
    throw error
  }
}

function mainModule() {
  return process.argv[1] !== undefined
    && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
}

if (mainModule()) {
  try {
    await build()
  } catch (error) {
    if (error?.signal !== undefined && error.signal !== null) {
      process.kill(process.pid, error.signal)
    } else {
      console.error(error instanceof Error ? error.message : error)
      process.exitCode = error?.status ?? 1
    }
  }
}
