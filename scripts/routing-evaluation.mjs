import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { spawn } from "node:child_process"
import net from "node:net"

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
const workspace = mkdtempSync(join(tmpdir(), "opencode-tiered-dispatch-routing-"))
const pluginDirectory = join(workspace, ".opencode", "plugins")
const setupMarker = join(workspace, "routing.setup")
const resultMarker = join(workspace, "routing.result")
const failureMarker = join(workspace, "routing.failure")
mkdirSync(pluginDirectory, { recursive: true })
writeFileSync(join(workspace, "opencode.jsonc"), '{ "$schema": "https://opencode.ai/config.json" }\n')
writeFileSync(join(pluginDirectory, "tiered-dispatch.js"), wrapperSource(entrypoint, setupMarker, resultMarker, failureMarker, options))

const port = await freePort()
const password = `routing-${Date.now()}`
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
  await waitFor(() => existsSync(setupMarker), 30_000, () => logs)
  await waitFor(
    () => existsSync(resultMarker) || existsSync(failureMarker),
    Number(process.env.TIERED_DISPATCH_EVAL_TIMEOUT_MS ?? 600_000),
    () => `${logs}\n${existsSync(failureMarker) ? readFileSync(failureMarker, "utf8") : ""}`,
  )
  if (existsSync(failureMarker)) throw new Error(`routing evaluation failed\n${readFileSync(failureMarker, "utf8")}\n${logs}`)
  const results = JSON.parse(readFileSync(resultMarker, "utf8"))
  for (const result of results) {
    if (result.tiers.join(",") !== result.expected.join(",")) {
      throw new Error(`routing evaluation mismatch for ${result.id}: expected ${result.expected.join(" -> ") || "direct"}, got ${result.tiers.join(" -> ") || "direct"}`)
    }
  }
  console.log(`routing evaluation passed: ${results.map((result) => `${result.id}=${result.tiers.join("+") || "direct"}`).join(", ")}`)
} finally {
  child.kill("SIGTERM")
  rmSync(workspace, { recursive: true, force: true })
}

function tier(modelVariable, variantVariable) {
  const model = process.env[modelVariable]
  if (!model) throw new Error(`${modelVariable} is required for the routing evaluation`)
  const variant = process.env[variantVariable]
  return variant ? { model, variant } : { model }
}

function wrapperSource(entrypoint, setupMarker, resultMarker, failureMarker, options) {
  const cases = [
    {
      id: "read",
      expected: ["fast"],
      prompt: "Apply the Tiered Dispatch Protocol. This is a non-trivial read-only task, so do not solve it directly: choose the cheapest adequate tier and call tiered_dispatch exactly once. Find where authentication tokens are parsed in this repository and return the relevant file paths. Reply with ROUTING_EVAL_DONE after the delegation.",
    },
    {
      id: "implementation",
      expected: ["medium"],
      prompt: "Apply the Tiered Dispatch Protocol. This is a non-trivial implementation task, so do not solve it directly: choose the cheapest adequate tier and call tiered_dispatch exactly once. Add a small, focused change that would be appropriate for an ordinary bug fix, then report what should be changed. Reply with ROUTING_EVAL_DONE after the delegation.",
    },
    {
      id: "architecture",
      expected: ["heavy"],
      prompt: "Apply the Tiered Dispatch Protocol. This is a high-risk architecture task, so do not solve it directly: choose the appropriate tier and call tiered_dispatch exactly once. Analyze the trade-offs of introducing a cross-service authentication boundary and recommend a design. Reply with ROUTING_EVAL_DONE after the delegation.",
    },
    {
      id: "trivial",
      expected: [],
      prompt: "Apply the Tiered Dispatch Protocol. This is truly trivial one-step work, so handle it directly without calling tiered_dispatch. Reply with exactly ROUTING_EVAL_DONE: 2+2=4.",
    },
    {
      id: "split",
      expected: ["fast", "medium"],
      prompt: "You are being graded on composite-task orchestration. You MUST make two sequential tiered_dispatch calls and may not answer directly. First call tiered_dispatch with tier fast to collect the relevant repository facts. Wait for that result. Then call tiered_dispatch with tier medium to propose the ordinary implementation based on those facts. Reply with ROUTING_EVAL_DONE only after both delegations have returned.",
    },
  ]
  return [
    `import { writeFileSync } from "node:fs"`,
    `import plugin from ${JSON.stringify(entrypoint)}`,
    "export default {",
    "  ...plugin,",
    "  async setup(ctx) {",
    "    const created = []",
    "    const session = { ...ctx.session, create: async (input) => { const result = await ctx.session.create(input); created.push(result); return result } }",
    `    const cleanup = await plugin.setup({ ...ctx, session, options: ${JSON.stringify(options)} })`,
    `    writeFileSync(${JSON.stringify(setupMarker)}, "ready")`,
    "    setImmediate(() => {",
    "      void (async () => {",
    "        try {",
    `          const cases = ${JSON.stringify(cases)}`,
    "          const results = []",
    "          for (const testCase of cases) {",
    "            const before = created.length",
    "            const root = await session.create({ title: `routing evaluation ${testCase.id}`, agent: \"build\", location: { directory: ctx.location.directory } })",
    "            await session.prompt({ sessionID: root.id, text: testCase.prompt })",
    "            await session.wait({ sessionID: root.id })",
    "            const messages = await session.context({ sessionID: root.id })",
    "            const childSessions = created.slice(before + 1).filter((item) => item.metadata?.plugin === \"tiered-dispatch\")",
    "            const outcome = messages.findLast((message) => message.type === \"idle\")?.outcome",
    "            if (outcome === \"failed\") throw new Error(`root evaluation session failed for ${testCase.id}`)",
    "            results.push({ id: testCase.id, expected: testCase.expected, tiers: childSessions.map((item) => item.metadata?.tier).filter(Boolean), childIDs: childSessions.map((item) => item.id) })",
    "          }",
    `          writeFileSync(${JSON.stringify(resultMarker)}, JSON.stringify(results))`,
    "        } catch (error) {",
    `          writeFileSync(${JSON.stringify(failureMarker)}, JSON.stringify({ name: error?.name, message: error?.message, cause: error?.cause }))`,
    "        }",
    "      })()",
    "    })",
    "    return cleanup",
    "  },",
    "}",
    "",
  ].join("\n")
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

async function waitFor(predicate, timeout, getLogs) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100))
  }
  throw new Error(`routing evaluation timed out\n${getLogs()}`)
}
