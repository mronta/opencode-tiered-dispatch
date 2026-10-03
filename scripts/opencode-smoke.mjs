import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { spawnSync } from "node:child_process"
import { runOpenCodeScenario, waitForScenario } from "./opencode-harness.mjs"

const root = resolve(fileURLToPath(new URL("..", import.meta.url)))
const packed = process.argv.includes("--packed")
const disabled = process.argv.includes("--disabled")
const permissions = process.argv.includes("--permissions")
const tiers = process.argv.includes("--tiers")
const cancel = process.argv.includes("--cancel")
const unload = process.argv.includes("--unload")
const reload = process.argv.includes("--reload")
const providerError = process.argv.includes("--provider-error")
const delegate = process.argv.includes("--delegate") || permissions || tiers || cancel || unload || reload || providerError

if (!existsSync(join(root, "dist/index.js"))) throw new Error("dist/index.js is missing; run npm run build first")

let packageInstall
let entrypoint
if (packed) {
  packageInstall = mkdtempSync(join(tmpdir(), "opencode-tiered-dispatch-packed-"))
  const packedOutput = run("npm", ["pack", "--json", "--pack-destination", packageInstall], root)
  const packedInfo = JSON.parse(packedOutput).at(0)
  if (!packedInfo?.filename) throw new Error("npm pack did not report a tarball")
  run("npm", ["install", "--ignore-scripts", "--prefix", packageInstall, join(packageInstall, packedInfo.filename)], root)
  entrypoint = pathToFileURL(join(packageInstall, "node_modules", "opencode-tiered-dispatch", "dist/index.js")).href
} else {
  entrypoint = pathToFileURL(join(root, "dist/index.js")).href
}

const options = disabled ? { enabled: false } : {
  tiers: {
    fast: tier("TIERED_DISPATCH_FAST_MODEL", "TIERED_DISPATCH_FAST_VARIANT"),
    medium: tier("TIERED_DISPATCH_MEDIUM_MODEL", "TIERED_DISPATCH_MEDIUM_VARIANT"),
    heavy: tier("TIERED_DISPATCH_HEAVY_MODEL", "TIERED_DISPATCH_HEAVY_VARIANT"),
  },
}
const reloadOptions = disabled ? undefined : {
  ...options,
  logging: true,
  tiers: {
    ...options.tiers,
    fast: {
      ...options.tiers.fast,
      model: options.tiers.medium.model,
      ...(options.tiers.medium.variant === undefined ? {} : { variant: options.tiers.medium.variant }),
      instructions: "Reloaded configuration marker",
    },
  },
}
const mode = disabled
  ? "disabled"
  : permissions
    ? "permissions"
    : tiers
      ? "tiers"
      : cancel
        ? "cancel"
        : unload
          ? "unload"
          : reload
            ? "reload"
            : providerError
              ? "provider-error"
              : delegate
                ? "delegate"
                : "registration"

try {
  await runOpenCodeScenario({
    root,
    entrypoint,
    options,
    reloadOptions,
    mode,
    name: `smoke-${mode}${packed ? "-packed" : ""}`,
    timeoutMs: Number(process.env.TIERED_DISPATCH_DELEGATE_TIMEOUT_MS ?? 180_000),
  }, async ({ paths, logs, timeoutMs, readResult }) => {
    await waitForScenario(paths, timeoutMs, logs)
    const result = readResult()
    if (mode === "registration") {
      if (!result.registered || !result.toolNames.includes("tiered_dispatch") || !result.hooks.includes("context")) {
        throw new Error(`OpenCode registration smoke returned an incomplete registration: ${JSON.stringify(result)}`)
      }
      console.log("OpenCode V2 registration smoke passed")
      return
    }
    if (mode === "disabled") {
      if (result.registered || result.toolNames.includes("tiered_dispatch") || result.hooks.includes("context")) {
        throw new Error(`disabled plugin registered behavior: ${JSON.stringify(result)}`)
      }
      console.log("OpenCode V2 disabled-plugin smoke passed")
      return
    }
    if (mode === "delegate") {
      if (result.output?.tier !== "fast" || !result.output?.sessionID || !result.output?.text?.trim()) {
        throw new Error("delegation smoke returned incomplete output")
      }
      console.log(`OpenCode V2${packed ? " packed" : ""} delegation smoke passed: ${result.output.sessionID}`)
      return
    }
    if (mode === "tiers") {
      if (result.tiers?.length !== 3 || result.tiers.some((item) => !item.output?.text?.trim())) throw new Error("tier smoke returned incomplete results")
      console.log(`OpenCode V2 tier smoke passed: ${result.tiers.map((item) => item.output.tier).join(", ")}`)
      return
    }
    if (mode === "permissions") {
      if (existsSync(paths.fastWriteTarget) || !existsSync(paths.mediumWriteTarget) || !existsSync(paths.heavyWriteTarget)) {
        throw new Error("permission smoke produced the wrong file set")
      }
      console.log("OpenCode V2 permission smoke passed: fast blocked, medium/heavy wrote")
      return
    }
    if (mode === "cancel") {
      if (result.childOutcome !== "interrupted") throw new Error(`cancellation smoke returned ${JSON.stringify(result)}`)
      console.log("OpenCode V2 cancellation smoke passed")
      return
    }
    if (mode === "unload") {
      if (result.childOutcome !== "interrupted") throw new Error(`unload smoke returned ${JSON.stringify(result)}`)
      console.log("OpenCode V2 active-unload smoke passed")
      return
    }
    if (mode === "reload") {
      const expected = formatModel(reloadOptions.tiers.fast.model, reloadOptions.tiers.fast.variant)
      if (result.toolCount !== 1 || result.reloaded?.model !== expected) throw new Error(`reload smoke returned ${JSON.stringify(result)}`)
      console.log(`OpenCode V2 reload/config smoke passed: ${result.reloaded.sessionID}`)
      return
    }
    if (mode === "provider-error") {
      if (result.childOutcome !== "failed" || !result.requests?.length) throw new Error(`provider error smoke returned ${JSON.stringify(result)}`)
      console.log("OpenCode V2 provider-error smoke passed without fallback")
    }
  })
} finally {
  if (packageInstall) rmSync(packageInstall, { recursive: true, force: true })
}

function tier(modelVariable, variantVariable) {
  const model = process.env[modelVariable]
  if (!model) throw new Error(`${modelVariable} is required for the OpenCode smoke test`)
  const variant = process.env[variantVariable]
  return variant ? { model, variant } : { model }
}

function formatModel(model, variant) {
  return variant ? `${model}:${variant}` : model
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] })
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed with exit code ${result.status}`)
  return result.stdout
}
