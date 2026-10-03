import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { spawn } from "node:child_process"
import net from "node:net"

export async function runOpenCodeScenario({ root, entrypoint, options, reloadOptions, mode, routingCase, name = "smoke", timeoutMs = 180_000 }, verify) {
  const workspace = mkdtempSync(join(tmpdir(), `opencode-tiered-dispatch-${name}-`))
  const controlDirectory = mkdtempSync(join(tmpdir(), `opencode-tiered-dispatch-${name}-control-`))
  const paths = {
    marker: join(controlDirectory, "setup.marker"),
    result: join(controlDirectory, "scenario.result"),
    failure: join(controlDirectory, "scenario.failure"),
    trace: join(controlDirectory, "scenario.trace"),
    requestTrace: join(controlDirectory, "model.requests"),
    fastWriteTarget: join(workspace, "fast-must-not-write.txt"),
    mediumWriteTarget: join(workspace, "medium-write.txt"),
    heavyWriteTarget: join(workspace, "heavy-write.txt"),
  }
  const pluginDirectory = join(workspace, ".opencode", "plugins")
  mkdirSync(pluginDirectory, { recursive: true })
  seedFixture(workspace)
  writeFileSync(join(workspace, "opencode.jsonc"), '{ "$schema": "https://opencode.ai/config.json" }\n')
  const runner = pathToFileURL(join(root, "scripts/opencode-plugin-runner.mjs")).href
  writeFileSync(
    join(pluginDirectory, "tiered-dispatch.js"),
    [
      `import plugin from ${JSON.stringify(entrypoint)}`,
      `import { createScenarioPlugin } from ${JSON.stringify(runner)}`,
      `export default createScenarioPlugin(plugin, ${JSON.stringify({ options, reloadOptions, mode, routingCase, paths })})`,
      "",
    ].join("\n"),
  )

  const port = await freePort()
  const password = `${name}-${Date.now()}`
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
    await waitFor(() => existsSync(paths.marker), 30_000, () => logs)
    await verify({
      workspace,
      paths,
      port,
      authorization,
      logs: () => logs,
      timeoutMs,
      readResult: () => JSON.parse(readFileSync(paths.result, "utf8")),
    })
  } finally {
    child.kill("SIGTERM")
    rmSync(workspace, { recursive: true, force: true })
    rmSync(controlDirectory, { recursive: true, force: true })
  }
}

function seedFixture(workspace) {
  mkdirSync(join(workspace, "src"), { recursive: true })
  mkdirSync(join(workspace, "test"), { recursive: true })
  writeFileSync(join(workspace, "README.md"), "# Tiered Dispatch Smoke Fixture\n\nA tiny authentication fixture used by the routing evaluation.\n")
  writeFileSync(join(workspace, "src/auth.ts"), [
    "export function parseAuthorization(value: string | undefined) {",
    "  if (!value?.startsWith(\"Bearer \")) return undefined",
    "  const token = value.slice(7).trim()",
    "  return token || undefined",
    "}",
    "",
  ].join("\n"))
  writeFileSync(join(workspace, "src/config.ts"), [
    "export const authConfig = { issuer: \"https://issuer.example\", audience: \"smoke\" }",
    "",
  ].join("\n"))
}

export async function waitForScenario(paths, timeoutMs, getLogs) {
  await waitFor(
    () => existsSync(paths.result) || existsSync(paths.failure),
    timeoutMs,
    () => `${getLogs()}\ntrace: ${existsSync(paths.trace) ? readFileSync(paths.trace, "utf8") : "missing"}`,
  )
  if (existsSync(paths.failure)) {
    throw new Error(`OpenCode scenario failed\n${readFileSync(paths.failure, "utf8")}\n${getLogs()}`)
  }
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
  throw new Error(`OpenCode scenario timed out\n${getLogs()}`)
}
