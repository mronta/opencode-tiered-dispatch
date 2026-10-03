import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { spawn, spawnSync } from "node:child_process"
import net from "node:net"

const root = resolve(fileURLToPath(new URL("..", import.meta.url)))
const delegate = process.argv.includes("--delegate")
const permissions = process.argv.includes("--permissions")
const runDelegation = delegate || permissions
const packed = process.argv.includes("--packed")
if (!existsSync(join(root, "dist/index.js"))) {
  throw new Error("dist/index.js is missing; run npm run build first")
}

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

const options = {
  tiers: {
    fast: tier("TIERED_DISPATCH_FAST_MODEL", "TIERED_DISPATCH_FAST_VARIANT"),
    medium: tier("TIERED_DISPATCH_MEDIUM_MODEL", "TIERED_DISPATCH_MEDIUM_VARIANT"),
    heavy: tier("TIERED_DISPATCH_HEAVY_MODEL", "TIERED_DISPATCH_HEAVY_VARIANT"),
  },
}
const workspace = mkdtempSync(join(tmpdir(), "opencode-tiered-dispatch-smoke-"))
const marker = join(workspace, "setup.marker")
const resultMarker = join(workspace, "delegation.result")
const failureMarker = join(workspace, "delegation.failure")
const traceMarker = join(workspace, "delegation.trace")
const fastWriteTarget = join(workspace, "fast-must-not-write.txt")
const mediumWriteTarget = join(workspace, "medium-write.txt")
const heavyWriteTarget = join(workspace, "heavy-write.txt")
const pluginDirectory = join(workspace, ".opencode", "plugins")
mkdirSync(pluginDirectory, { recursive: true })
writeFileSync(join(workspace, "opencode.jsonc"), '{ "$schema": "https://opencode.ai/config.json" }\n')
writeFileSync(
  join(pluginDirectory, "tiered-dispatch.js"),
  wrapperSource(entrypoint, marker, resultMarker, failureMarker, traceMarker, options, runDelegation, permissions, fastWriteTarget, mediumWriteTarget, heavyWriteTarget),
)

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
  if (runDelegation) {
    await waitFor(
      () => existsSync(resultMarker) || existsSync(failureMarker),
      Number(process.env.TIERED_DISPATCH_DELEGATE_TIMEOUT_MS ?? 180_000),
      () => `${logs}\ntrace: ${existsSync(traceMarker) ? readFileSync(traceMarker, "utf8") : "missing"}`,
    )
    if (existsSync(failureMarker)) {
      throw new Error(`OpenCode delegation smoke failed\n${readFileSync(failureMarker, "utf8")}\n${logs}`)
    }
    const delegation = JSON.parse(readFileSync(resultMarker, "utf8"))
    if (delegation.output?.tier !== "fast") throw new Error("delegation smoke selected the wrong tier")
    if (!delegation.output?.sessionID || !delegation.output?.text?.trim()) {
      throw new Error("delegation smoke returned incomplete output")
    }
    console.log(`OpenCode V2${permissions ? " permission and" : ""} delegation smoke passed: ${delegation.output.sessionID}`)
  }
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
  if (packageInstall) rmSync(packageInstall, { recursive: true, force: true })
}

function tier(modelVariable, variantVariable) {
  const model = process.env[modelVariable]
  if (!model) throw new Error(`${modelVariable} is required for the OpenCode smoke test`)
  const variant = process.env[variantVariable]
  return variant ? { model, variant } : { model }
}

function wrapperSource(entrypoint, marker, resultMarker, failureMarker, traceMarker, options, runDelegation, permissions, fastWriteTarget, mediumWriteTarget, heavyWriteTarget) {
  return [
    `import { existsSync, readFileSync, writeFileSync } from "node:fs"`,
    `import plugin from ${JSON.stringify(entrypoint)}`,
    "export default {",
    "  ...plugin,",
    "  async setup(ctx) {",
    "    let dispatchTool",
    "    const contextEvents = []",
    "    const tool = { ...ctx.tool, transform: (callback) => ctx.tool.transform((editor) => callback({ ...editor, add: (tool) => { dispatchTool = tool; editor.add(tool) } })) }",
    "    const session = { ...ctx.session, hook: (name, callback, ...rest) => ctx.session.hook(name, (event) => { const result = callback(event); if (name === \"context\") contextEvents.push({ agent: event.agent, hasDispatch: Boolean(event.tools?.tiered_dispatch), system: Array.isArray(event.system) ? event.system.map((part) => part?.text ?? \"\").join(\"\\n\") : \"\" }); return result }, ...rest) }",
    `    const cleanup = await plugin.setup({ ...ctx, tool, session, options: ${JSON.stringify(options)} })`,
    ...(runDelegation ? [
      "    dispatchTool ??= (await ctx.tool.list()).find((tool) => tool.id === \"tiered_dispatch\" || tool.name === \"tiered_dispatch\")",
    ] : []),
    `    writeFileSync(${JSON.stringify(marker)}, "setup complete")`,
    ...(runDelegation ? [
      "    setImmediate(() => {",
      "      void (async () => {",
      "        try {",
      `          writeFileSync(${JSON.stringify(traceMarker)}, "tool=" + (dispatchTool ? "found" : "missing"))`,
      "          if (!dispatchTool) throw new Error(\"dispatch tool was not captured\")",
      `          writeFileSync(${JSON.stringify(traceMarker)}, "creating root")`,
      "          const root = await session.create({ title: \"tiered dispatch smoke root\", agent: \"build\", location: { directory: ctx.location.directory } })",
      `          writeFileSync(${JSON.stringify(traceMarker)}, "root=" + root.id + " keys=" + Object.keys(dispatchTool).join(","))`,
      `          writeFileSync(${JSON.stringify(traceMarker)}, "calling execute")`,
      "          const result = await dispatchTool.execute(",
      "            { tier: \"fast\", description: \"Delegation smoke\", prompt: \"Return exactly DELEGATION_SMOKE_OK and do not use tools.\" },",
      `            { sessionID: root.id, agent: \"build\", signal: new AbortController().signal, progress: async (update) => writeFileSync(${JSON.stringify(traceMarker)}, \"progress=\" + JSON.stringify(update)) },`,
      "          )",
      "          const child = await session.get({ sessionID: result.output.sessionID })",
      "          const childMessages = await session.context({ sessionID: result.output.sessionID })",
      `          const expectedModel = ${JSON.stringify(options.tiers.fast.model)}`,
      `          const expectedVariant = ${JSON.stringify(options.tiers.fast.variant ?? null)}`,
      "          if (result.output.tier !== \"fast\") throw new Error(\"delegation returned the wrong tier\")",
      "          if (result.output.model !== expectedModel + (expectedVariant ? \":\" + expectedVariant : \"\")) throw new Error(\"delegation returned the wrong model\")",
      "          if (child.agent !== \"explore\") throw new Error(\"child used the wrong agent\")",
      "          if (child.model?.providerID + \"/\" + child.model?.id !== expectedModel || (child.model?.variant ?? null) !== expectedVariant) throw new Error(\"child used the wrong model or variant\")",
      "          if (child.location?.directory !== ctx.location.directory) throw new Error(\"child used the wrong location\")",
      "          if (child.metadata?.plugin !== \"tiered-dispatch\" || child.metadata?.parentSessionID !== root.id) throw new Error(\"child metadata is incomplete\")",
      "          if (!Array.isArray(childMessages) || !childMessages.some((message) => message.type === \"assistant\")) throw new Error(\"child context has no assistant message\")",
      "          if (child.permissions?.some((rule) => rule.effect === \"allow\" && [\"edit\", \"write\", \"shell\", \"bash\"].includes(rule.action))) throw new Error(\"fast child retained mutation access\")",
      "          const childContextEvent = contextEvents.find((event) => event.agent === \"explore\")",
      "          if (!childContextEvent || childContextEvent.hasDispatch || childContextEvent.system.includes(\"Tiered Dispatch Protocol\")) throw new Error(\"child received routing context\")",
      ...(permissions ? [
        `          const fastPermissionResult = await dispatchTool.execute({ tier: "fast", description: "Read-only permission smoke", prompt: ${JSON.stringify(`Use an available tool to attempt to create ${fastWriteTarget} with exactly FAST_WRITE_MUST_FAIL. If permission denies the operation, report that denial.`)} }, { sessionID: root.id, agent: "build", signal: new AbortController().signal, progress: async () => undefined })`,
        `          if (existsSync(${JSON.stringify(fastWriteTarget)})) throw new Error("fast delegation modified a file")`,
        `          const mediumPermissionResult = await dispatchTool.execute({ tier: "medium", description: "Write permission smoke", prompt: ${JSON.stringify(`Use an editing tool to create ${mediumWriteTarget} with exactly MEDIUM_WRITE_OK. Do not merely describe the change.`)} }, { sessionID: root.id, agent: "build", signal: new AbortController().signal, progress: async () => undefined })`,
        `          if (!existsSync(${JSON.stringify(mediumWriteTarget)}) || readFileSync(${JSON.stringify(mediumWriteTarget)}, "utf8").trim() !== "MEDIUM_WRITE_OK") throw new Error("medium delegation could not perform the expected edit")`,
        `          const heavyPermissionResult = await dispatchTool.execute({ tier: "heavy", description: "Heavy write permission smoke", prompt: ${JSON.stringify(`Use an editing tool to create ${heavyWriteTarget} with exactly HEAVY_WRITE_OK. Do not merely describe the change.`)} }, { sessionID: root.id, agent: "build", signal: new AbortController().signal, progress: async () => undefined })`,
        `          if (!existsSync(${JSON.stringify(heavyWriteTarget)}) || readFileSync(${JSON.stringify(heavyWriteTarget)}, "utf8").trim() !== "HEAVY_WRITE_OK") throw new Error("heavy delegation could not perform the expected edit")`,
      ] : []),
      `          writeFileSync(${JSON.stringify(traceMarker)}, "executed")`,
      `          writeFileSync(${JSON.stringify(resultMarker)}, JSON.stringify({ output: result.output, child: { id: child.id, agent: child.agent, model: child.model, location: child.location, metadata: child.metadata, permissions: child.permissions }, contextTypes: childMessages.map((message) => message.type), contextEvents, permissions: ${permissions ? "{ fastCreated: existsSync(" + JSON.stringify(fastWriteTarget) + "), mediumCreated: existsSync(" + JSON.stringify(mediumWriteTarget) + "), heavyCreated: existsSync(" + JSON.stringify(heavyWriteTarget) + ") }" : "undefined"} }))`,
      "        } catch (error) {",
      `          writeFileSync(${JSON.stringify(failureMarker)}, JSON.stringify({ name: error?.name, message: error?.message, cause: error?.cause }))`,
      "        }",
      "      })()",
      "    })",
    ] : []),
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

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] })
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed with exit code ${result.status}`)
  return result.stdout
}
