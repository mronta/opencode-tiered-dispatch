import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { spawn } from "node:child_process"
import net from "node:net"
import { assessRouting, routingObserverSource, scenarios, seedRoutingFixture } from "./routing-eval.mjs"

const root = resolve(fileURLToPath(new URL("..", import.meta.url)))
const routingEval = process.argv.includes("--routing-eval")
const workspace = mkdtempSync(join(tmpdir(), "opencode-tiered-dispatch-native-"))
const control = mkdtempSync(join(tmpdir(), "opencode-tiered-dispatch-native-control-"))
const paths = {
  marker: join(control, "setup.marker"),
  result: join(control, "scenario.result"),
  failure: join(control, "scenario.failure"),
}

const tiers = {
  fast: { model: "openai/gpt-6-luna" },
  medium: { model: "openai/gpt-5.6-luna", variant: "max" },
  heavy: { model: "openai/gpt-5.6-sol", variant: "medium" },
}
const providerErrorModel = "openai/__tiered_dispatch_missing_model__"
const rootModel = modelRef(tiers.medium)

mkdirSync(join(workspace, ".opencode", "plugins"), { recursive: true })
writeFileSync(join(workspace, "opencode.jsonc"), JSON.stringify({
  $schema: "https://opencode.ai/config.json",
  ...(routingEval ? {} : { agents: nativeAgents(providerErrorModel) }),
  plugins: [{ package: root }],
}, null, 2) + "\n")
if (routingEval) seedRoutingFixture(workspace)
writeFileSync(join(workspace, ".opencode", "plugins", "native-smoke-observer.js"), routingEval
  ? routingObserverSource(paths, rootModel)
  : observerSource(paths, rootModel, tiers, providerErrorModel))

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
  if (existsSync(paths.failure)) throw new Error(formatFailure(readFileSync(paths.failure, "utf8"), logs))
  const initialAgentResponse = await fetch(`http://127.0.0.1:${port}/api/agent`, { headers: { authorization } })
  if (!initialAgentResponse.ok) throw new Error(`could not read initial native agent catalog: HTTP ${initialAgentResponse.status}`)
  verifyMaterializedAgents((await initialAgentResponse.json()).data ?? [], tiers)

  await waitFor(() => existsSync(paths.result) || existsSync(paths.failure), 600_000, () => logs)
  if (existsSync(paths.failure)) throw new Error(formatFailure(readFileSync(paths.failure, "utf8"), logs))
  const result = JSON.parse(readFileSync(paths.result, "utf8"))
  const agentResponse = await fetch(`http://127.0.0.1:${port}/api/agent`, { headers: { authorization } })
  if (!agentResponse.ok) throw new Error(`could not read native agent catalog: HTTP ${agentResponse.status}`)
  const agentPayload = await agentResponse.json()
  try {
    if (routingEval) verifyRoutingEvaluation(result)
    else verify(result, agentPayload.data ?? agentPayload, workspace, providerErrorModel)
  } catch (error) {
    throw new Error(`${error?.message ?? String(error)}\nOpenCode logs:\n${logs}`)
  }
  console.log(routingEval ? "OpenCode spontaneous-routing evaluation passed" : `OpenCode native-agent smoke passed: ${Object.keys(result.tiers).join(", ")}`)
} finally {
  await stopProcess(child)
  rmSync(workspace, { recursive: true, force: true })
  rmSync(control, { recursive: true, force: true })
}

function formatFailure(failure, logs) {
  return `${failure}\nOpenCode logs:\n${logs}`
}

function verifyRoutingEvaluation(results) {
  const reports = scenarios.map(scenario => {
    const result = results.find(candidate => candidate.id === scenario.id)
    if (!result) throw new Error(`routing evaluation missing scenario ${scenario.id}`)
    return assessRouting(result, scenario.route)
  })
  const reportByID = new Map(reports.map(report => [report.id, report]))
  const trivial = results.find(result => result.id === "trivial")
  if (trivial.sessions.find(session => session.sessionID === trivial.rootSessionID)?.text.trim() !== "4") {
    reportByID.get("trivial").problems.push("trivial answer was incorrect")
  }
  const analysis = results.find(result => result.id === "discover-analyze")
  const answer = analysis.sessions.find(session => session.sessionID === analysis.rootSessionID)?.text ?? ""
  if (!/replay/i.test(answer) || !/forg|unauthenticated|signature/i.test(answer) || !/src\/auth\//.test(answer)) {
    reportByID.get("discover-analyze").problems.push("security answer omitted replay, identity forgery or file evidence")
  }
  if (analysis.changedFiles.length > 0) {
    reportByID.get("discover-analyze").problems.push("analysis modified fixture files despite no-edit request")
  }
  console.log(JSON.stringify(reports, null, 2))
  if (reports.some(report => report.problems.length > 0)) {
    throw new Error("spontaneous-routing evaluation failed; see observed routes above")
  }
}

function verifyMaterializedAgents(agents, expectedTiers) {
  for (const [tier, expected] of Object.entries(expectedTiers)) {
    verifyTierAgent(agents, tier, expected, "materialized")
  }
}

function modelRef(config) {
  const separator = config.model.indexOf("/")
  return {
    providerID: config.model.slice(0, separator),
    id: config.model.slice(separator + 1),
    ...(config.variant === undefined ? {} : { variant: config.variant }),
  }
}

function nativeAgents(providerErrorModel) {
  return {
    "provider-error": {
      mode: "subagent",
      description: "Native provider-error smoke agent",
      model: providerErrorModel,
      system: "Return the requested result if possible. Do not delegate further.",
    },
  }
}

function matchesExpectedModel(actual, expected) {
  if (!actual) return false
  const configured = modelRef(expected)
  return actual.providerID === configured.providerID
    && actual.id === configured.id
    && normalizedVariant(actual.variant, expected.variant) === (expected.variant ?? undefined)
}

function verifyTierAgent(agents, tier, expected, phase) {
  const agent = agents.find((candidate) => candidate.id === tier)
  if (!agent || agent.mode !== "subagent") {
    throw new Error(`native ${tier} was not ${phase} as a subagent: ${JSON.stringify(agent)}`)
  }
  if (!matchesExpectedModel(agent.model, expected)) {
    throw new Error(`native ${tier} was ${phase} with the wrong model: ${JSON.stringify(agent)}`)
  }
  return agent
}

function observerSource(resultPaths, selectedRootModel, configuredTiers, configuredProviderErrorModel) {
  const directModels = Object.fromEntries(
    Object.entries(configuredTiers).map(([tier, config]) => [tier, modelRef(config)]),
  )
  return [
    `import { writeFileSync } from "node:fs"`,
    `const markerPath = ${JSON.stringify(resultPaths.marker)}`,
    `const resultPath = ${JSON.stringify(resultPaths.result)}`,
    `const failurePath = ${JSON.stringify(resultPaths.failure)}`,
    `const rootModel = ${JSON.stringify(selectedRootModel)}`,
    `const directModels = ${JSON.stringify(directModels)}`,
    `const expectedTiers = ${JSON.stringify(configuredTiers)}`,
    `const providerErrorModel = ${JSON.stringify(configuredProviderErrorModel)}`,
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
    "async function createSession(ctx, title, agent, model) {",
    "  return ctx.session.create({ title, agent, model, location: { directory: ctx.location.directory } })",
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
    "          const directPrompts = {",
    "            fast: \"Return exactly NATIVE_FAST_OK without using tools.\",",
    "            medium: \"Use the patch tool exactly once to create native-smoke-medium.txt containing exactly MEDIUM_EDIT_OK, then return exactly NATIVE_MEDIUM_OK. Do not use other tools.\",",
    "            heavy: \"Use the shell tool exactly once to run printf HEAVY_SHELL_OK > native-smoke-heavy.txt, then return exactly NATIVE_HEAVY_OK. Do not use other tools.\",",
    "          }",
    "          const results = {}",
    "          for (const tier of tiers) {",
    "            const session = await createSession(ctx, `[native smoke] direct ${tier}`, tier, directModels[tier])",
    "            await ctx.session.prompt({ sessionID: session.id, text: directPrompts[tier] })",
    "            await ctx.session.wait({ sessionID: session.id })",
    "            results[tier] = session.id",
    "          }",
    "          await new Promise((resolve) => setTimeout(resolve, 100))",
    "          const outputs = {}",
    "          for (const tier of tiers) {",
    "            const tierEvent = [...events].reverse().find((event) => event.agent === tier && event.sessionID === results[tier])",
    "            const messages = tierEvent ? await ctx.session.context({ sessionID: tierEvent.sessionID }) : []",
    "            outputs[tier] = { sessionID: tierEvent?.sessionID, text: messageText(messages) }",
    "          }",
    "          const routingStart = events.length",
    "          const routingRoot = await createSession(ctx, \"[native smoke] primary routing\", \"build\", rootModel)",
    "          await ctx.session.prompt({ sessionID: routingRoot.id, text: \"Use the native subagent tool exactly once. Select agent medium and ask it to return exactly NATIVE_ROUTE_MEDIUM_OK without using tools. After it returns, reply exactly NATIVE_ROUTE_OK. Do not call any other tools.\" })",
    "          await ctx.session.wait({ sessionID: routingRoot.id })",
    "          const routingChild = await waitForAgentEvent(events, routingStart, \"medium\")",
    "          const routingRootMessages = await ctx.session.context({ sessionID: routingRoot.id })",
    "          const routingChildMessages = await ctx.session.context({ sessionID: routingChild.sessionID })",
    "          const routing = { rootSessionID: routingRoot.id, childSessionID: routingChild.sessionID, rootText: messageText(routingRootMessages), childText: messageText(routingChildMessages) }",
    "          await exerciseNativeTools(ctx, events)",
    "          const tierEvents = events.filter((event) => tiers.includes(event.agent) && results[event.agent] === event.sessionID)",
    "          const routingEvents = events.slice(routingStart)",
    "          const lifecycle = await exerciseNativeLifecycle(ctx, events)",
    "          writeFileSync(resultPath, JSON.stringify({ expected: expectedTiers, expectedProviderErrorModel: providerErrorModel, tiers: results, outputs, routing, lifecycle, tierEvents, routingEvents, events }))",
    "        } catch (error) {",
    "          writeFileSync(failurePath, JSON.stringify({ message: error?.message ?? String(error), stack: error?.stack, events }))",
    "        }",
    "      })()",
    "    })",
    "  },",
    "}",
    "",
    "async function exerciseNativeTools(ctx, events) {",
    "  const checks = {",
    "    medium: \"Tool-access test: your response is invalid unless you call the patch tool now. Apply this exact patch before saying anything: *** Begin Patch\\n*** Add File: native-smoke-medium.txt\\n+MEDIUM_EDIT_OK\\n*** End Patch. After the patch succeeds, reply exactly TOOL_CHECK_MEDIUM_OK.\",",
    "    heavy: \"Tool-access test: your response is invalid unless you call the shell tool now. Run exactly this command before saying anything: printf HEAVY_SHELL_OK > native-smoke-heavy.txt. After the command succeeds, reply exactly TOOL_CHECK_HEAVY_OK.\",",
    "  }",
    "  for (const [agent, text] of Object.entries(checks)) {",
    "    const child = [...events].reverse().find((event) => event.agent === agent)",
    "    if (!child) throw new Error(`native smoke did not observe ${agent} child for tool check`)",
    "    await ctx.session.prompt({ sessionID: child.sessionID, text })",
    "    await ctx.session.wait({ sessionID: child.sessionID })",
    "  }",
    "}",
    "",
    "async function exerciseNativeLifecycle(ctx, events) {",
    "  const cancellationStart = events.length",
    "  const cancellationRoot = await createSession(ctx, \"[native smoke] cancellation\", \"build\", rootModel)",
    "  let cancellationError",
    "  const cancellationPrompt = ctx.session.prompt({ sessionID: cancellationRoot.id, text: \"Use the native subagent tool exactly once. Select agent fast and ask it to spend a long time producing a detailed research answer. Do not answer until the child returns.\" }).catch((error) => { cancellationError = String(error) })",
    "  const cancellationChild = await waitForAgentEvent(events, cancellationStart, \"fast\")",
    "  const cancellationInterrupt = await withTimeout(ctx.session.interrupt({ sessionID: cancellationRoot.id, resume: false }), 30_000)",
    "  await withTimeout(cancellationPrompt, 30_000)",
    "  const cancellationRootInfo = await waitForOutcome(ctx, cancellationRoot.id, \"interrupted\", 30_000)",
    "  const cancellationChildInfo = await waitForOutcome(ctx, cancellationChild.sessionID, \"interrupted\", 30_000)",
    "  const providerStart = events.length",
    "  const providerRoot = await createSession(ctx, \"[native smoke] provider error\", \"build\", rootModel)",
    "  let providerPromptError",
    "  const providerPrompt = ctx.session.prompt({ sessionID: providerRoot.id, text: \"Use the native subagent tool exactly once. Select agent provider-error and ask it to return exactly PROVIDER_ERROR_SHOULD_NOT_SUCCEED. Do not select another agent or retry with another model.\" }).catch((error) => { providerPromptError = String(error) })",
    "  await withTimeout(providerPrompt, 30_000)",
    "  const providerRootInfo = await waitForCompletion(ctx, providerRoot.id, 30_000)",
    "  const fallbackEvents = events.slice(providerStart).filter((event) => [\"fast\", \"medium\", \"heavy\"].includes(event.agent))",
    "  const providerMessages = await ctx.session.context({ sessionID: providerRoot.id })",
    "  const providerToolErrors = failedSubagentErrors(providerMessages)",
    "  return {",
    "    cancellation: { rootSessionID: cancellationRoot.id, childSessionID: cancellationChild.sessionID, interrupt: cancellationInterrupt, rootOutcome: cancellationRootInfo.outcome, childOutcome: cancellationChildInfo.outcome, error: cancellationError },",
    "    providerFailure: { rootSessionID: providerRoot.id, rootOutcome: providerRootInfo.outcome, error: providerPromptError ?? messageErrors(providerMessages), toolErrors: providerToolErrors, fallbackEvents },",
    "  }",
    "}",
    "",
    "async function waitForAgentEvent(events, start, agent) {",
    "  return poll(() => events.slice(start).find((candidate) => candidate.agent === agent), Boolean, 30_000, `native smoke did not observe agent ${agent}`)",
    "}",
    "",
    "async function waitForOutcome(ctx, sessionID, expected, timeout) {",
    "  return poll(() => ctx.session.get({ sessionID }), (session) => session.outcome === expected, timeout, `session ${sessionID} did not reach outcome ${expected}`)",
    "}",
    "",
    "async function waitForCompletion(ctx, sessionID, timeout) {",
    "  return poll(() => ctx.session.get({ sessionID }), (session) => Boolean(session.outcome), timeout, `session ${sessionID} did not complete`)",
    "}",
    "",
    "async function poll(read, matches, timeout, failureMessage) {",
    "  const deadline = Date.now() + timeout",
    "  let latest",
    "  while (Date.now() < deadline) {",
    "    latest = await read()",
    "    if (matches(latest)) return latest",
    "    await new Promise((resolve) => setTimeout(resolve, 100))",
    "  }",
    "  throw new Error(`${failureMessage}: ${JSON.stringify(latest)}`)",
    "}",
    "",
    "async function withTimeout(promise, timeout) {",
    "  return Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error(\"native smoke operation timed out\")), timeout))])",
    "}",
    "",
    "function messageErrors(messages) {",
    "  return messages.flatMap((message) => [message.error, message.retry?.error, ...(message.content ?? []).flatMap((part) => [part.error, part.state?.error])]).filter(Boolean).map((error) => String(error.message ?? error)).join(\"\\n\")",
    "}",
    "",
    "function failedSubagentErrors(messages) {",
    "  return messages.flatMap((message) => (message.content ?? []).filter((part) => part.type === \"tool\" && part.name === \"subagent\" && part.state?.status === \"error\").map((part) => part.state.error)).filter(Boolean)",
    "}",
  ].join("\n")
}

function verify(result, agents, workspace, configuredProviderErrorModel) {
  const fileChecks = {
    medium: { path: join(workspace, "native-smoke-medium.txt"), content: "MEDIUM_EDIT_OK\n", action: "edit" },
    heavy: { path: join(workspace, "native-smoke-heavy.txt"), content: "HEAVY_SHELL_OK", action: "run a shell command" },
  }
  for (const tier of ["fast", "medium", "heavy"]) {
    const events = result.tierEvents.filter((event) => event.agent === tier)
    if (events.length === 0) throw new Error(`native ${tier} agent was never invoked: ${JSON.stringify(result)}`)
    if (new Set(events.map((event) => event.sessionID)).size !== 1) {
      throw new Error(`native ${tier} was invoked more than once: ${JSON.stringify(events)}`)
    }
    const tierEvent = events.at(-1)
    if (tierEvent.hasProtocol) throw new Error(`native ${tier} tier session received the primary routing protocol`)
    if (!tierEvent.model?.providerID || !tierEvent.model?.id) throw new Error(`native ${tier} tier session has no resolved model`)
    if (tierEvent.toolNames.includes("subagent")) throw new Error(`native ${tier} tier session can recurse`)
    const expected = result.expected[tier]
    if (!matchesExpectedModel(tierEvent.model, expected)) {
      throw new Error(`native ${tier} used the wrong model: ${JSON.stringify({ expected, actual: tierEvent.model })}`)
    }
    if (result.outputs[tier]?.text !== `NATIVE_${tier.toUpperCase()}_OK`) {
      throw new Error(`native ${tier} returned the wrong child result: ${JSON.stringify(result.outputs[tier])}`)
    }
    const fileCheck = fileChecks[tier]
    if (fileCheck && (!existsSync(fileCheck.path) || readFileSync(fileCheck.path, "utf8") !== fileCheck.content)) {
      throw new Error(`native ${tier} could not ${fileCheck.action}: ${JSON.stringify(result.outputs[tier])}`)
    }
    const agent = verifyTierAgent(agents, tier, expected, "configured")
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
    } else {
      for (const action of ["edit", "write", "shell"]) {
        const rule = [...permissions].reverse().find(
          (candidate) => candidate.resource === "*" && (candidate.action === action || candidate.action === "*"),
        )
        if (rule?.effect !== "allow") {
          throw new Error(`native ${tier} cannot perform ${action}: ${JSON.stringify(agent)}`)
        }
      }
    }
  }
  const primary = result.events.find((event) => event.agent === "build" && event.hasProtocol)
  if (!primary) throw new Error(`primary routing protocol was not observed: ${JSON.stringify(result.events)}`)
  if (!primary.toolNames.includes("subagent")) throw new Error("primary session did not expose the native subagent tool")
  const routingChild = result.routingEvents?.find((event) => event.agent === "medium")
  if (!routingChild || routingChild.hasProtocol || routingChild.toolNames.includes("subagent")) {
    throw new Error(`primary routing did not produce a valid medium child: ${JSON.stringify(result.routing)}`)
  }
  if (result.routing?.childText !== "NATIVE_ROUTE_MEDIUM_OK" || result.routing?.rootText !== "NATIVE_ROUTE_OK") {
    throw new Error(`primary routing returned the wrong result: ${JSON.stringify(result.routing)}`)
  }
  if (
    result.lifecycle?.cancellation?.interrupt?.interrupted !== true
    || result.lifecycle?.cancellation?.rootOutcome !== "interrupted"
    || result.lifecycle?.cancellation?.childOutcome !== "interrupted"
  ) {
    throw new Error(`native cancellation was not preserved: ${JSON.stringify(result.lifecycle)}`)
  }
  const providerAgent = agents.find((candidate) => candidate.id === "provider-error")
  const providerFailure = result.lifecycle?.providerFailure
  if (
    result.expectedProviderErrorModel !== configuredProviderErrorModel
    || !["succeeded", "failed"].includes(providerFailure?.rootOutcome)
    || providerAgent?.mode !== "subagent"
    || !matchesExpectedModel(providerAgent?.model, { model: configuredProviderErrorModel })
    || !providerFailure.error
    || !providerFailure.error.includes(configuredProviderErrorModel)
    || !Array.isArray(providerFailure.toolErrors)
    || providerFailure.toolErrors.length === 0
    || !providerFailure.toolErrors.some((error) => String(error?.message ?? error).includes(configuredProviderErrorModel))
    || providerFailure.fallbackEvents?.length !== 0
  ) {
    throw new Error(`native provider failure was not surfaced: ${JSON.stringify(result.lifecycle)}`)
  }
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
