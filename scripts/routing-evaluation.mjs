import { existsSync } from "node:fs"
import { join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { runOpenCodeScenario, waitForScenario } from "./opencode-harness.mjs"

const root = resolve(fileURLToPath(new URL("..", import.meta.url)))
const entrypoint = pathToFileURL(join(root, "dist/index.js")).href
if (!existsSync(join(root, "dist/index.js"))) throw new Error("dist/index.js is missing; run npm run build first")

const options = {
  tiers: {
    fast: tier("TIERED_DISPATCH_FAST_MODEL", "TIERED_DISPATCH_FAST_VARIANT"),
    medium: tier("TIERED_DISPATCH_MEDIUM_MODEL", "TIERED_DISPATCH_MEDIUM_VARIANT"),
    heavy: tier("TIERED_DISPATCH_HEAVY_MODEL", "TIERED_DISPATCH_HEAVY_VARIANT"),
  },
}

const requestedCase = process.env.TIERED_DISPATCH_ROUTING_CASE
const cases = requestedCase ? [requestedCase] : ["read", "implementation", "architecture", "trivial", "split"]
const results = []
for (const routingCase of cases) {
  await runOpenCodeScenario({
    root,
    entrypoint,
    options,
    mode: "routing",
    routingCase,
    name: `routing-${routingCase}`,
    timeoutMs: Number(process.env.TIERED_DISPATCH_EVAL_TIMEOUT_MS ?? 600_000),
  }, async ({ paths, logs, timeoutMs, readResult }) => {
    await waitForScenario(paths, timeoutMs, logs)
    const caseResults = readResult()
    if (caseResults.length !== 1) throw new Error(`routing case ${routingCase} returned ${caseResults.length} results`)
    const result = caseResults[0]
    if (result.tiers.join(",") !== result.expected.join(",")) {
      throw new Error(`routing evaluation mismatch for ${result.id}: expected ${result.expected.join(" -> ") || "direct"}, got ${result.tiers.join(" -> ") || "direct"}`)
    }
    results.push(result)
    console.log(`routing case passed: ${result.id}=${result.tiers.join("+") || "direct"}`)
  })
}
console.log(`routing evaluation passed: ${results.map((result) => `${result.id}=${result.tiers.join("+") || "direct"}`).join(", ")}`)

function tier(modelVariable, variantVariable) {
  const model = process.env[modelVariable]
  if (!model) throw new Error(`${modelVariable} is required for the routing evaluation`)
  const variant = process.env[variantVariable]
  return variant ? { model, variant } : { model }
}
