import { createHash } from "node:crypto"
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, writeFileSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { tmpdir } from "node:os"
import { dirname, join, relative, resolve } from "node:path"

/**
 * The fixture is deliberately small and boring.  Keeping its manifest here
 * means that the observer can restore the same starting point without
 * copying files from the previous scenario.
 */
export const FIXTURE_MANIFEST = Object.freeze({
  "package.json": JSON.stringify({ type: "module", scripts: { test: "node --test test/*.test.js" } }),
  "src/banner.js": "export function banner(name) { return name }\n",
  "test/banner.test.js": "import { test } from 'node:test'\nimport assert from 'node:assert/strict'\nimport { banner } from '../src/banner.js'\ntest('banner', () => assert.equal(banner('Ada'), 'Ada'))\n",
  "src/settings.js": "export const nameLimit = 12\n",
  "src/names/normalize.js": "export function normalizeName(value) { return value.trim() }\n",
  "src/names/validate.js": "import { nameLimit } from '../settings.js'\nexport function validateName(name) { return { ok: true, name, limit: nameLimit } }\n",
  "src/controller.js": "import { normalizeName } from './names/normalize.js'\nimport { validateName } from './names/validate.js'\nexport function saveName(value) { return validateName(normalizeName(value)) }\n",
  "test/names.test.js": "import { test } from 'node:test'\nimport assert from 'node:assert/strict'\nimport { saveName } from '../src/controller.js'\ntest('normalizes names', () => assert.deepEqual(saveName(' Ada '), { ok: true, name: 'Ada', limit: 12 }))\n",
  "src/auth/login.js": "import { verifyTicket } from './ticket.js'\nimport { sessionFor } from './session.js'\nexport function login(ticket) { return sessionFor(verifyTicket(ticket)) }\n",
  "src/auth/ticket.js": "// Tickets arrive from the browser; the issuer field is not authenticated.\nexport function verifyTicket(ticket) { return JSON.parse(Buffer.from(ticket, 'base64url').toString()) }\n",
  "src/auth/session.js": "// No expiry or replay store. Caller-supplied subject becomes session identity.\nexport function sessionFor(claims) { return { user: claims.sub, issuer: claims.iss } }\n",
})

const INFRASTRUCTURE_NAMES = new Set(["opencode.jsonc", ".opencode"])

export function seedRoutingFixture(workspace) {
  for (const [path, content] of Object.entries(FIXTURE_MANIFEST)) {
    const filename = join(workspace, path)
    mkdirSync(dirname(filename), { recursive: true })
    writeFileSync(filename, content)
  }
}

/**
 * Snapshot files, directories, and symlinks using workspace-relative keys.
 * Including empty directories makes unexpected provider additions visible to
 * the same reset and final-scope checks as files.
 */
export function snapshotRoutingWorkspace(workspace) {
  const root = resolve(workspace)
  const files = {}

  function visit(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const filename = join(directory, entry.name)
      const key = relative(root, filename)
      if (entry.isDirectory()) {
        files[key] = { type: "directory" }
        visit(filename)
      } else if (entry.isSymbolicLink()) {
        files[key] = { type: "symlink", target: readlinkSync(filename) }
      } else if (entry.isFile()) {
        files[key] = { type: "file", hash: hashFile(filename) }
      }
    }
  }

  visit(root)
  return files
}

/**
 * Return a compact, serializable manifest for observations.  Fixture results
 * must prove what was present without copying source bytes (or leaking the
 * evaluator's absolute workspace path) into benchmark artifacts.
 */
export function fingerprintRoutingWorkspace(workspace) {
  const snapshot = snapshotRoutingWorkspace(workspace)
  return Object.fromEntries(Object.entries(snapshot).sort(([left], [right]) => left.localeCompare(right)).map(([path, entry]) => {
    if (entry.type === "file") return [path, `sha256:${entry.hash}`]
    if (entry.type === "symlink") return [path, `symlink-sha256:${hashText(entry.target)}`]
    return [path, "directory"]
  }))
}

export function snapshotInfrastructure(workspace) {
  const snapshot = snapshotRoutingWorkspace(workspace)
  return Object.fromEntries(Object.entries(snapshot).filter(([path]) => {
    const [topLevel] = path.split("/")
    return INFRASTRUCTURE_NAMES.has(topLevel)
  }))
}

export function diffRoutingSnapshots(before, after) {
  return [...new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])]
    .filter((path) => JSON.stringify(before?.[path]) !== JSON.stringify(after?.[path]))
    .sort()
}

/**
 * Restore the fixture before a scenario.  Infrastructure is never rewritten;
 * callers can therefore fail closed if a provider touched the verifier or
 * plugin configuration instead of restoring it underneath a live child.
 */
export function restoreRoutingFixture(workspace, infrastructureBaseline) {
  const currentInfrastructure = snapshotInfrastructure(workspace)
  const infrastructureChanges = diffRoutingSnapshots(infrastructureBaseline, currentInfrastructure)
  if (infrastructureChanges.length > 0) {
    throw new Error(`routing infrastructure changed before reset: ${infrastructureChanges.join(", ")}`)
  }

  for (const entry of readdirSync(workspace, { withFileTypes: true })) {
    if (INFRASTRUCTURE_NAMES.has(entry.name)) continue
    rmSync(join(workspace, entry.name), { recursive: true, force: true })
  }
  seedRoutingFixture(workspace)
}

export function fixtureRelativeFiles() {
  return Object.keys(FIXTURE_MANIFEST)
}

/**
 * Resolve the two names used by native ShellTool versions for a command's
 * working directory.  The evaluator and the observer must make this decision
 * identically: a relative cwd is relative to the fixture root, an omitted cwd
 * is the fixture root, and cwd/workdir may only both be present when they
 * resolve to the same directory.
 */
export function resolveRoutingCommandDirectory(input, workspace) {
  const root = typeof workspace === "string" ? resolve(workspace) : undefined
  const problems = []
  const aliases = []

  for (const name of ["cwd", "workdir"]) {
    if (input?.[name] === undefined) continue
    const value = input[name]
    if (typeof value !== "string" || value.length === 0) {
      problems.push(`${name} must be a non-empty string`)
      continue
    }
    if (root === undefined) {
      problems.push("fixture workspace is missing while resolving command directory")
      continue
    }
    aliases.push({ name, value, directory: resolve(root, value) })
  }

  const directory = aliases[0]?.directory ?? root
  if (aliases.length > 1 && aliases[0].directory !== aliases[1].directory) {
    problems.push(`cwd and workdir resolve to different directories: ${aliases[0].directory} and ${aliases[1].directory}`)
  }
  return { root, directory, aliases, problems }
}

/**
 * Verify the implementation through a process outside the fixture.  The
 * changed-limit run replaces only the settings module in Node's loader; it
 * never writes the fixture and consequently cannot be confused with a
 * provider edit.  Both runs assert the complete `{ok, name, limit}` shape.
 */
export function checkFixture(workspace, scenarioID, nodeBinary = process.execPath, options = {}) {
  if (scenarioID !== "known-scope" && scenarioID !== "discover-implement") return []

  const ownedControl = options.verifierDirectory === undefined
  const verifierDirectory = options.verifierDirectory ?? mkdtempSync(join(tmpdir(), "opencode-routing-verifier-"))
  const loaderPath = join(verifierDirectory, "routing-limit-loader.mjs")
  const problems = []

  try {
    if (scenarioID === "known-scope") {
      const banner = spawnSync(nodeBinary, [
        "--input-type=module",
        "-e",
        "import assert from 'node:assert/strict'; import { banner } from './src/banner.js'; assert.equal(banner('Ada'), 'Hello, Ada!')",
      ], processOptions(workspace))
      problems.push(...formatCheckFailure("fixture behavior", banner))
    } else {
      const configuredLimit = readConfiguredLimit(workspace, nodeBinary)
      if (!Number.isInteger(configuredLimit) || configuredLimit <= 0) {
        problems.push(`fixture behavior could not read a positive configured nameLimit: ${configuredLimit ?? "missing"}`)
      }
      const baseline = runBehaviorCheck({ workspace, nodeBinary })
      problems.push(...formatCheckFailure("fixture behavior", baseline, { expectedLimit: configuredLimit }))

      const changedLimit = changedLimitFor(configuredLimit)
      writeFileSync(loaderPath, changedLimitLoader(changedLimit))
      const changed = runBehaviorCheck({ workspace, nodeBinary, loaderPath })
      problems.push(...formatCheckFailure(`changed-limit behavior (limit ${changedLimit})`, changed, { expectedLimit: changedLimit }))
    }

    const test = scenarioID === "known-scope"
      ? spawnSync(nodeBinary, ["--test", "test/banner.test.js"], processOptions(workspace))
      // The verifier owns this invocation.  Do not let an inherited
      // npm_execpath (for example, an npx shim) replace the command that
      // establishes fixture evidence.  The primary's exact `npm test`
      // command remains a separate routing-policy observation.
      : spawnSync(nodeBinary, ["--test", "test/*.test.js"], processOptions(workspace))
    problems.push(...formatCheckFailure("fixture tests", test))
  } finally {
    rmSync(loaderPath, { force: true })
    if (ownedControl) rmSync(verifierDirectory, { recursive: true, force: true })
  }

  return problems
}

function runBehaviorCheck({ workspace, nodeBinary, loaderPath }) {
  const source = `
import assert from "node:assert/strict"
import { nameLimit } from "./src/settings.js"
import { saveName } from "./src/controller.js"

assert.equal(Number.isInteger(nameLimit) && nameLimit > 0, true, "nameLimit must be a positive integer")
const limit = nameLimit
const atLimit = "a".repeat(limit)
const overLimit = "b".repeat(limit + 1)
const valid = limit >= 3 ? "Ada" : "A"
console.log("__ROUTING_FIXTURE_LIMIT__" + limit)
assert.deepEqual(saveName("   "), { ok: false, name: "", limit })
assert.deepEqual(saveName("  " + overLimit + "  "), { ok: false, name: overLimit, limit })
assert.deepEqual(saveName("  " + atLimit + "  "), { ok: true, name: atLimit, limit })
assert.deepEqual(saveName("  " + valid + "  "), { ok: true, name: valid, limit })
`
  const args = []
  if (loaderPath !== undefined) args.push("--experimental-loader", loaderPath)
  args.push("--input-type=module", "-e", source)
  return spawnSync(nodeBinary, args, processOptions(workspace))
}

function readConfiguredLimit(workspace, nodeBinary) {
  const result = spawnSync(nodeBinary, [
    "--input-type=module",
    "-e",
    "import { nameLimit } from './src/settings.js'; process.stdout.write(String(nameLimit))",
  ], processOptions(workspace))
  if (result.status !== 0) return undefined
  const value = Number(String(result.stdout).trim())
  return Number.isInteger(value) ? value : undefined
}

function changedLimitFor(configuredLimit) {
  if (!Number.isInteger(configuredLimit) || configuredLimit <= 0) return 1
  return configuredLimit === 1 ? 2 : configuredLimit - 1
}

function changedLimitLoader(limit) {
  return `
const limit = ${JSON.stringify(limit)}
export async function resolve(specifier, context, nextResolve) {
  const resolved = await nextResolve(specifier, context)
  if (resolved.url.endsWith("/src/settings.js")) {
    return { ...resolved, url: resolved.url + "?routing_fixture_limit=" + limit }
  }
  return resolved
}
export async function load(url, context, nextLoad) {
  if (url.includes("/src/settings.js?routing_fixture_limit=")) {
    return { format: "module", shortCircuit: true, source: "export const nameLimit = " + limit + "\\n" }
  }
  return nextLoad(url, context)
}
`
}

function processOptions(workspace) {
  return { cwd: workspace, encoding: "utf8", timeout: 30_000 }
}

function hashFile(filename) {
  return hashText(readFileSync(filename))
}

function hashText(value) {
  return createHash("sha256").update(String(value)).digest("hex")
}

function formatCheckFailure(label, result, { expectedLimit } = {}) {
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`
  if (Number.isInteger(expectedLimit) && !output.includes(`__ROUTING_FIXTURE_LIMIT__${expectedLimit}`)) {
    return [`${label} did not load expected configured limit ${expectedLimit}: ${formatProcessDetail(result)}`]
  }
  if (result.status === 0) return []
  return [`${label} failed: ${formatProcessDetail(result)}`]
}

function formatProcessDetail(result) {
  if (result.error?.message !== undefined) return result.error.message
  return [result.stderr, result.stdout].filter(Boolean).join("\n") || `process exited with ${result.status ?? "unknown status"}`
}
