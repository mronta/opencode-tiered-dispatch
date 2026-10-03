import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { spawn } from "node:child_process"
import net from "node:net"

const root = resolve(fileURLToPath(new URL("..", import.meta.url)))
const entrypoint = pathToFileURL(join(root, "dist/index.js")).href
if (!existsSync(join(root, "dist/index.js"))) {
  throw new Error("dist/index.js is missing; run npm run build first")
}

const options = {
  tiers: {
    fast: tier("TIERED_DISPATCH_FAST_MODEL", "TIERED_DISPATCH_FAST_VARIANT"),
    medium: tier("TIERED_DISPATCH_MEDIUM_MODEL", "TIERED_DISPATCH_MEDIUM_VARIANT"),
    heavy: tier("TIERED_DISPATCH_HEAVY_MODEL", "TIERED_DISPATCH_HEAVY_VARIANT"),
  },
}
const workspace = mkdtempSync(join(tmpdir(), "opencode-tiered-dispatch-smoke-"))
const marker = join(workspace, "setup.marker")
const pluginDirectory = join(workspace, ".opencode", "plugins")
mkdirSync(pluginDirectory, { recursive: true })
writeFileSync(join(workspace, "opencode.jsonc"), '{ "$schema": "https://opencode.ai/config.json" }\n')
writeFileSync(join(pluginDirectory, "tiered-dispatch.js"), wrapperSource(entrypoint, marker, options))

const port = await freePort()
const password = `smoke-${Date.now()}`
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
  await waitFor(() => existsSync(marker), 30_000, () => logs)
  const response = await fetch(`http://127.0.0.1:${port}/api/session`, {
    method: "POST",
    headers: {
      authorization,
      "content-type": "application/json",
    },
    body: JSON.stringify({ title: "tiered dispatch smoke", agent: "build" }),
  })
  if (!response.ok) throw new Error(`session smoke request failed: ${response.status}`)
  console.log("OpenCode V2 registration/session smoke passed")
} finally {
  child.kill("SIGTERM")
  rmSync(workspace, { recursive: true, force: true })
}

function tier(modelVariable, variantVariable) {
  const model = process.env[modelVariable]
  if (!model) throw new Error(`${modelVariable} is required for the OpenCode smoke test`)
  const variant = process.env[variantVariable]
  return variant ? { model, variant } : { model }
}

function wrapperSource(entrypoint, marker, options) {
  return [
    `import { writeFileSync } from "node:fs"`,
    `import plugin from ${JSON.stringify(entrypoint)}`,
    "export default {",
    "  ...plugin,",
    "  async setup(ctx) {",
    `    const cleanup = await plugin.setup({ ...ctx, options: ${JSON.stringify(options)} })`,
    `    writeFileSync(${JSON.stringify(marker)}, "setup complete")`,
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
  throw new Error(`OpenCode smoke timed out\n${getLogs()}`)
}
