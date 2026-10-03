import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { spawn } from "node:child_process"
import net from "node:net"

const root = resolve(fileURLToPath(new URL("..", import.meta.url)))
const workspace = mkdtempSync(join(tmpdir(), "opencode-tiered-dispatch-native-"))
const control = mkdtempSync(join(tmpdir(), "opencode-tiered-dispatch-native-control-"))
const paths = {
  marker: join(control, "setup.marker"),
  result: join(control, "scenario.result"),
  failure: join(control, "scenario.failure"),
}

const tiers = {
  fast: tier("TIERED_DISPATCH_FAST_MODEL", "TIERED_DISPATCH_FAST_VARIANT"),
  medium: tier("TIERED_DISPATCH_MEDIUM_MODEL", "TIERED_DISPATCH_MEDIUM_VARIANT"),
  heavy: tier("TIERED_DISPATCH_HEAVY_MODEL", "TIERED_DISPATCH_HEAVY_VARIANT"),
}
const rootModel = modelRef(tiers.medium)
const options = {
  enabled: true,
  tiers,
}

mkdirSync(join(workspace, ".opencode", "plugins"), { recursive: true })
writeFileSync(join(workspace, "opencode.jsonc"), JSON.stringify({
  $schema: "https://opencode.ai/config.json",
  model: modelString(tiers.medium),
  agents: nativeAgents(tiers),
  plugins: [{ package: root, options }],
}, null, 2) + "\n")
writeFileSync(join(workspace, ".opencode", "plugins", "native-smoke-observer.js"), observerSource(paths, rootModel, tiers))

const port = await freePort()
const password = `native-smoke-${Date.now()}`
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
  await waitFor(() => existsSync(paths.marker) || existsSync(paths.failure), 180_000, () => logs)
  if (existsSync(paths.failure)) throw new Error(readFileSync(paths.failure, "utf8"))

  await waitFor(() => existsSync(paths.result), 600_000, () => logs)
  const result = JSON.parse(readFileSync(paths.result, "utf8"))
  const agentResponse = await fetch(`http://127.0.0.1:${port}/api/agent`, { headers: { authorization } })
  if (!agentResponse.ok) throw new Error(`could not read native agent catalog: HTTP ${agentResponse.status}`)
  const agentPayload = await agentResponse.json()
  verify(result, agentPayload.data ?? agentPayload)
  console.log(`OpenCode native-agent smoke passed: ${Object.keys(result.tiers).join(", ")}`)
} finally {
  await stopProcess(child)
  rmSync(workspace, { recursive: true, force: true })
  rmSync(control, { recursive: true, force: true })
}

function tier(modelVariable, variantVariable) {
  const model = process.env[modelVariable]
  if (!model) throw new Error(`${modelVariable} is required for the native-agent smoke test`)
  const variant = process.env[variantVariable]
  return variant ? { model, variant } : { model }
}

function modelRef(config) {
  const separator = config.model.indexOf("/")
  return {
    providerID: config.model.slice(0, separator),
    id: config.model.slice(separator + 1),
    ...(config.variant === undefined ? {} : { variant: config.variant }),
  }
}

function modelString(config) {
  return config.variant === undefined ? config.model : `${config.model}#${config.variant}`
}

function nativeAgents(configured) {
  return {
    fast: {
      mode: "subagent",
      description: "Focused read-only exploration and research",
      model: modelString(configured.fast),
      system: "Act as a focused, read-only investigator. Search only as far as needed. Return concrete findings with file paths, line references, and a concise conclusion. Do not edit files, run mutating commands, or delegate further.",
      permissions: fastPermissions(),
    },
    medium: {
      mode: "subagent",
      description: "Implementation, refactoring, tests, and ordinary fixes",
      model: modelString(configured.medium),
      system: "Act as an implementation specialist. Match existing project patterns, make the requested changes, and run targeted verification. Report files changed, key decisions, and verification results. Do not delegate further.",
      permissions: implementationPermissions(),
    },
    heavy: {
      mode: "subagent",
      description: "Architecture, security, difficult debugging, and high-risk reasoning",
      model: modelString(configured.heavy),
      system: "Act as a senior architecture and difficult-debugging specialist. Analyze evidence carefully, state trade-offs, and give a concrete recommendation or requested implementation. Do not delegate further.",
      permissions: implementationPermissions(),
    },
  }
}

function fastPermissions() {
  return [
    { action: "*", resource: "*", effect: "deny" },
    { action: "grep", resource: "*", effect: "allow" },
    { action: "glob", resource: "*", effect: "allow" },
    { action: "webfetch", resource: "*", effect: "allow" },
    { action: "websearch", resource: "*", effect: "allow" },
    { action: "read", resource: "*", effect: "allow" },
    { action: "read", resource: "*.env", effect: "ask" },
    { action: "read", resource: "*.env.*", effect: "ask" },
    { action: "read", resource: "*.env.example", effect: "allow" },
    { action: "subagent", resource: "*", effect: "deny" },
  ]
}

function implementationPermissions() {
  return [
    { action: "*", resource: "*", effect: "allow" },
    { action: "external_directory", resource: "*", effect: "ask" },
    { action: "read", resource: "*.env", effect: "ask" },
    { action: "read", resource: "*.env.*", effect: "ask" },
    { action: "read", resource: "*.env.example", effect: "allow" },
    { action: "question", resource: "*", effect: "deny" },
    { action: "subagent", resource: "*", effect: "deny" },
  ]
}

function observerSource(resultPaths, selectedRootModel, configuredTiers) {
  return [
    `import { writeFileSync } from "node:fs"`,
    `const markerPath = ${JSON.stringify(resultPaths.marker)}`,
    `const resultPath = ${JSON.stringify(resultPaths.result)}`,
    `const failurePath = ${JSON.stringify(resultPaths.failure)}`,
    `const rootModel = ${JSON.stringify(selectedRootModel)}`,
    `const expectedTiers = ${JSON.stringify(configuredTiers)}`,
    `const tiers = ${JSON.stringify(["fast", "medium", "heavy"])}`,
    "",
    "function snapshot(event) {",
    "  return {",
    "    sessionID: event.sessionID,",
    "    agent: event.agent,",
    "    model: event.model,",
    "    hasProtocol: event.system.some((part) => String(part?.text ?? \"\").includes(\"Tiered Dispatch Protocol\")),",
    "    toolNames: Object.keys(event.tools ?? {}),",
    "  }",
    "}",
    "",
    "function messageText(messages) {",
    "  return messages.filter((message) => message.type === \"assistant\").flatMap((message) => message.content ?? []).filter((part) => part.type === \"text\").map((part) => part.text).join(\"\\n\").trim()",
    "}",
    "",
    "export default {",
    "  id: \"tiered-native-smoke-observer\",",
    "  async setup(ctx) {",
    "    const events = []",
    "    await ctx.session.hook(\"context\", (event) => {",
    "      setImmediate(() => events.push(snapshot(event)))",
    "    })",
    "    writeFileSync(markerPath, \"setup complete\")",
    "    setImmediate(() => {",
    "      void (async () => {",
    "        try {",
    "          const results = {}",
    "          for (const tier of tiers) {",
    "            const root = await ctx.session.create({ title: `[native smoke] ${tier}`, agent: \"build\", model: rootModel, location: { directory: ctx.location.directory } })",
    "            await ctx.session.prompt({ sessionID: root.id, text: `Use the native subagent tool exactly once. Select agent ${tier}, set a short description, and ask it to return exactly NATIVE_${tier.toUpperCase()}_OK without using tools. After it returns, reply exactly NATIVE_ROOT_${tier.toUpperCase()}_OK. Do not call any other tools.` })",
    "            await ctx.session.wait({ sessionID: root.id })",
    "            results[tier] = root.id",
    "          }",
    "          await new Promise((resolve) => setTimeout(resolve, 100))",
    "          const outputs = {}",
    "          for (const tier of tiers) {",
    "            const child = [...events].reverse().find((event) => event.agent === tier)",
    "            const childMessages = child ? await ctx.session.context({ sessionID: child.sessionID }) : []",
    "            const rootMessages = await ctx.session.context({ sessionID: results[tier] })",
    "            outputs[tier] = { childSessionID: child?.sessionID, childText: messageText(childMessages), rootText: messageText(rootMessages) }",
    "          }",
    "          writeFileSync(resultPath, JSON.stringify({ expected: expectedTiers, tiers: results, outputs, events }))",
    "        } catch (error) {",
    "          writeFileSync(failurePath, JSON.stringify({ message: error?.message ?? String(error), stack: error?.stack, events }))",
    "        }",
    "      })()",
    "    })",
    "  },",
    "}",
    "",
  ].join("\n")
}

function verify(result, agents) {
  for (const tier of ["fast", "medium", "heavy"]) {
    const events = result.events.filter((event) => event.agent === tier)
    if (events.length === 0) throw new Error(`native ${tier} agent was never invoked: ${JSON.stringify(result)}`)
    if (events.length !== 1 || new Set(events.map((event) => event.sessionID)).size !== 1) {
      throw new Error(`native ${tier} was invoked more than once: ${JSON.stringify(events)}`)
    }
    const child = events.at(-1)
    if (child.hasProtocol) throw new Error(`native ${tier} child received the primary routing protocol`)
    if (!child.model?.providerID || !child.model?.id) throw new Error(`native ${tier} child has no resolved model`)
    if (child.toolNames.includes("subagent")) throw new Error(`native ${tier} child can recurse`)
    const expected = result.expected[tier]
    const expectedSeparator = expected.model.indexOf("/")
    if (
      child.model.providerID !== expected.model.slice(0, expectedSeparator)
      || child.model.id !== expected.model.slice(expectedSeparator + 1)
      || normalizedVariant(child.model.variant, expected.variant) !== (expected.variant ?? undefined)
    ) {
      throw new Error(`native ${tier} used the wrong model: ${JSON.stringify({ expected, actual: child.model })}`)
    }
    if (result.outputs[tier]?.childText !== `NATIVE_${tier.toUpperCase()}_OK`) {
      throw new Error(`native ${tier} returned the wrong child result: ${JSON.stringify(result.outputs[tier])}`)
    }
    if (result.outputs[tier]?.rootText !== `NATIVE_ROOT_${tier.toUpperCase()}_OK`) {
      throw new Error(`native ${tier} returned the wrong primary result: ${JSON.stringify(result.outputs[tier])}`)
    }

    const agent = agents.find((candidate) => candidate.id === tier)
    if (!agent || agent.mode !== "subagent") throw new Error(`native ${tier} is not a subagent agent`)
    if (
      agent.model?.providerID !== expected.model.slice(0, expected.model.indexOf("/"))
      || agent.model?.id !== expected.model.slice(expected.model.indexOf("/") + 1)
      || normalizedVariant(agent.model?.variant, expected.variant) !== (expected.variant ?? undefined)
    ) {
      throw new Error(`native ${tier} has the wrong configured model: ${JSON.stringify(agent)}`)
    }
    const permissions = agent.permissions ?? []
    const subagentRule = [...permissions].reverse().find(
      (rule) => rule.resource === "*" && (rule.action === "subagent" || rule.action === "*"),
    )
    if (subagentRule?.effect !== "deny") throw new Error(`native ${tier} can recurse: ${JSON.stringify(agent)}`)
    const subagentDenyIndex = permissions.findLastIndex(
      (rule) => rule.resource === "*"
        && rule.effect === "deny"
        && (rule.action === "subagent" || rule.action === "*"),
    )
    if (permissions.slice(subagentDenyIndex + 1).some(
      (rule) => rule.effect !== "deny" && (rule.action === "subagent" || rule.action === "*"),
    )) {
      throw new Error(`native ${tier} has a recursion bypass: ${JSON.stringify(agent)}`)
    }
    if (tier === "fast") {
      const denyAllIndex = permissions.findLastIndex(
        (rule) => rule.action === "*" && rule.resource === "*" && rule.effect === "deny",
      )
      if (denyAllIndex < 0 || permissions.slice(denyAllIndex + 1).some(
        (rule) => rule.effect !== "deny" && !["grep", "glob", "webfetch", "websearch", "read"].includes(rule.action),
      )) {
        throw new Error(`native fast is not read-only: ${JSON.stringify(agent)}`)
      }
    }
  }
  const primary = result.events.find((event) => event.agent === "build" && event.hasProtocol)
  if (!primary) throw new Error(`primary routing protocol was not observed: ${JSON.stringify(result.events)}`)
  if (!primary.toolNames.includes("subagent")) throw new Error("primary session did not expose the native subagent tool")
}

function normalizedVariant(actual, expected) {
  return expected === undefined && actual === "default" ? undefined : (actual ?? undefined)
}

async function stopProcess(process) {
  if (process.exitCode !== null || process.signalCode !== null) return
  await new Promise((resolve) => {
    let finished = false
    const finish = () => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      resolve()
    }
    const timer = setTimeout(() => {
      process.kill("SIGKILL")
      finish()
    }, 5_000)
    process.once("exit", finish)
    process.kill("SIGTERM")
  })
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
  throw new Error(`OpenCode native-agent smoke timed out\n${getLogs()}`)
}
