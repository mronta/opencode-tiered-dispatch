import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs"

export function createScenarioPlugin(plugin, configuration) {
  return {
    ...plugin,
    async setup(ctx) {
      let dispatchTool
      let scenarioToolRegistration
      const scenarioHookRegistrations = []
      const contextEvents = []
      const createdSessions = []
      const promptCalls = []
      const hookNames = []
      const { options, mode, paths } = configuration
      const tool = {
        ...ctx.tool,
        transform: (callback) => ctx.tool.transform((editor) => callback({
          ...editor,
          add: (definition) => {
            if (definition.name === "tiered_dispatch") dispatchTool = definition
            editor.add(definition)
          },
        })),
      }
      const session = {
        ...ctx.session,
        create: async (input) => {
          const result = await ctx.session.create(input)
          createdSessions.push(result)
          return result
        },
        prompt: async (input, ...rest) => {
          promptCalls.push(input)
          return ctx.session.prompt(input, ...rest)
        },
        hook: (name, callback, ...rest) => {
          hookNames.push(name)
          return ctx.session.hook(name, async (event) => {
            const result = await callback(event)
            if (name === "context") {
              contextEvents.push({
                sessionID: event.sessionID,
                agent: event.agent,
                hasDispatch: Boolean(event.tools?.tiered_dispatch),
                toolNames: Object.keys(event.tools ?? {}),
                system: Array.isArray(event.system)
                  ? event.system.map((part) => part?.text ?? "").join("\n")
                  : "",
              })
            }
            return result
          }, ...rest)
        },
      }

      const setupPlugin = (setupOptions) => plugin.setup({ ...ctx, tool, session, options: setupOptions })
      const pluginCleanup = await setupPlugin(options)
      let pluginDisposed = false
      const disposePlugin = async () => {
        if (pluginDisposed) return
        pluginDisposed = true
        if (typeof pluginCleanup === "function") await pluginCleanup()
      }
      if (mode === "permissions") {
        scenarioToolRegistration = await ctx.tool.transform((editor) => editor.add({
          name: "tiered_smoke_write",
          description: "Test-only file writer used by the permission smoke scenario",
          input: {
            type: "object",
            properties: {
              path: { type: "string" },
              content: { type: "string" },
            },
            required: ["path", "content"],
            additionalProperties: false,
          },
          execute: async (input) => {
            writeFileSync(input.path, input.content)
            return { content: `wrote ${input.path}` }
          },
        }))
      }
      if (mode === "provider-error") {
        scenarioHookRegistrations.push(await ctx.session.hook("model.request", (event) => {
          appendFileSync(paths.requestTrace, `${JSON.stringify({ kind: event.kind, agent: event.agent, model: event.model })}\n`)
        }))
        scenarioHookRegistrations.push(await ctx.session.hook("http.response", (event) => {
          if (event.kind !== "primary" || event.agent !== "explore") return
          event.response = new Response(JSON.stringify({
            error: {
              type: "smoke_provider_error",
              message: "deterministic provider failure from the OpenCode smoke harness",
              status: 503,
            },
          }), {
            status: 503,
            headers: { "content-type": "application/json" },
          })
        }))
        scenarioHookRegistrations.push(await ctx.session.hook("experimental.ws.handshake", (event) => {
          if (event.kind !== "primary" || event.agent !== "explore") return
          appendFileSync(paths.requestTrace, `${JSON.stringify({ transport: "websocket", kind: event.kind, agent: event.agent, model: event.model })}\n`)
          event.url = "ws://127.0.0.1:1"
        }))
        scenarioHookRegistrations.push(await ctx.session.hook("retry", (event) => {
          if (event.agent === "explore") event.decision = { retry: false }
        }))
      }
      dispatchTool ??= (await ctx.tool.list()).find((item) => item.id === "tiered_dispatch" || item.name === "tiered_dispatch")
      writeFileSync(paths.marker, "setup complete")
      if (mode === "registration" || mode === "disabled") {
        writeFileSync(paths.result, JSON.stringify({
          registered: Boolean(dispatchTool),
          toolNames: (await ctx.tool.list()).map((item) => item.id ?? item.name),
          hooks: hookNames,
        }))
      } else {
        setImmediate(() => {
          void runScenario({
            ctx,
            session,
            dispatchTool,
            createdSessions,
            contextEvents,
            promptCalls,
            pluginCleanup: disposePlugin,
            scenarioToolRegistration,
            scenarioHookRegistrations,
            setupPlugin,
            configuration,
          })
            .then((result) => writeFileSync(paths.result, JSON.stringify(result)))
            .catch((error) => writeFileSync(paths.failure, JSON.stringify(serializeError(error))))
        })
      }

      if (!scenarioToolRegistration && scenarioHookRegistrations.length === 0) return disposePlugin
      return async () => {
        await Promise.all([
          disposePlugin(),
          scenarioToolRegistration?.dispose(),
          ...scenarioHookRegistrations.map((registration) => registration.dispose()),
        ])
      }
    },
  }
}

async function runScenario({
  ctx,
  session,
  dispatchTool,
  createdSessions,
  contextEvents,
  promptCalls,
  pluginCleanup,
  configuration,
  setupPlugin,
}) {
  if (configuration.mode === "registration" || configuration.mode === "disabled") return undefined
  if (!dispatchTool) throw new Error("dispatch tool was not registered")
  if (configuration.mode === "delegate") {
    return runDelegate({ ctx, session, dispatchTool, createdSessions, contextEvents, configuration }, "fast")
  }
  if (configuration.mode === "tiers") {
    const results = []
    for (const tier of ["fast", "medium", "heavy"]) {
      results.push(await runDelegate({ ctx, session, dispatchTool, createdSessions, contextEvents, configuration }, tier))
    }
    return { tiers: results }
  }
  if (configuration.mode === "permissions") {
    return runPermissions({ ctx, session, dispatchTool, createdSessions, contextEvents, configuration })
  }
  if (configuration.mode === "cancel") {
    return runCancellation({ ctx, session, dispatchTool, createdSessions })
  }
  if (configuration.mode === "unload") {
    return runUnload({ ctx, session, dispatchTool, createdSessions, pluginCleanup })
  }
  if (configuration.mode === "reload") {
    return runReload({
      ctx,
      session,
      dispatchTool,
      createdSessions,
      contextEvents,
      configuration,
      pluginCleanup,
      setupPlugin,
      promptCalls,
    })
  }
  if (configuration.mode === "provider-error") {
    return runProviderError({ ctx, session, dispatchTool, createdSessions, configuration })
  }
  if (configuration.mode === "routing") {
    return runRoutingEvaluation({ ctx, session, createdSessions, contextEvents, promptCalls, configuration })
  }
  throw new Error(`Unknown OpenCode scenario: ${configuration.mode}`)
}

async function runDelegate({ ctx, session, dispatchTool, createdSessions, contextEvents, configuration }, tier, expectedOptions = configuration.options) {
  const root = await session.create({
    title: `[smoke] ${tier}`,
    agent: "build",
    location: { directory: ctx.location.directory },
  })
  const result = await dispatchTool.execute(
    {
      tier,
      description: `Verify ${tier} delegation`,
      prompt: `Return exactly TIERED_DISPATCH_${tier.toUpperCase()}_OK and do not use tools.`,
    },
    toolContext(root.id),
  )
  const child = await session.get({ sessionID: result.output.sessionID })
  const messages = await session.context({ sessionID: result.output.sessionID })
  const configured = expectedOptions.tiers[tier]
  const expectedAgent = tier === "fast" ? "explore" : "general"
  if (result.output.tier !== tier) throw new Error(`${tier} returned the wrong tier`)
  if (result.output.model !== formatModel(configured.model, configured.variant)) throw new Error(`${tier} returned the wrong model`)
  if (child.agent !== expectedAgent) throw new Error(`${tier} used the wrong agent`)
  const actualVariant = child.model?.variant ?? "default"
  const expectedVariant = configured.variant ?? "default"
  if (`${child.model?.providerID}/${child.model?.id}` !== configured.model || actualVariant !== expectedVariant) {
    throw new Error(`${tier} used the wrong model or variant: expected ${JSON.stringify(configured)}, got ${JSON.stringify(child.model)}`)
  }
  if (child.location?.directory !== ctx.location.directory) throw new Error(`${tier} used the wrong location`)
  if (child.metadata?.plugin !== "tiered-dispatch" || child.metadata?.parentSessionID !== root.id) throw new Error(`${tier} metadata is incomplete`)
  if (!messages.some((message) => message.type === "assistant" && extractText(message))) throw new Error(`${tier} produced no assistant text`)
  const childEvent = contextEvents.findLast((event) => event.sessionID === child.id)
  if (!childEvent || childEvent.hasDispatch || childEvent.system.includes("Tiered Dispatch Protocol")) {
    throw new Error(`${tier} child received routing context`)
  }
  if (tier === "fast" && child.permissions?.some((rule) => rule.effect === "allow" && (rule.action === "*" || ["edit", "write", "shell", "bash"].includes(rule.action)))) {
    throw new Error("fast child retained mutation access")
  }
  return {
    output: result.output,
    child: { id: child.id, agent: child.agent, model: child.model, permissions: child.permissions },
    contextEvent: childEvent,
  }
}

async function runPermissions({ ctx, session, dispatchTool, createdSessions, contextEvents, configuration }) {
  const base = await runDelegate({ ctx, session, dispatchTool, createdSessions, contextEvents, configuration }, "fast")
  const root = createdSessions.findLast((item) => item.metadata?.plugin !== "tiered-dispatch")
  if (!root) throw new Error("permission smoke root was not created")

  const fastResult = await dispatchTool.execute({
    tier: "fast",
    description: "Read-only permission smoke",
    prompt: `Attempt to call the tiered_smoke_write tool to create ${configuration.paths.fastWriteTarget} with exactly FAST_WRITE_MUST_FAIL. Do not merely describe the attempt; if the tool is unavailable, explain that the permission policy prevented it.`,
  }, toolContext(root.id))
  const fastMessages = await session.context({ sessionID: fastResult.output.sessionID })
  const fastChild = await session.get({ sessionID: fastResult.output.sessionID })
  const fastEvent = contextEvents.findLast((event) => event.sessionID === fastChild.id)
  if (existsSync(configuration.paths.fastWriteTarget)) throw new Error("fast delegation modified a file")
  if (fastChild.permissions?.some((rule) => rule.effect === "allow" && (rule.action === "*" || rule.action === "tiered_smoke_write"))) {
    throw new Error("fast permission smoke retained the mutation tool")
  }
  if (fastEvent?.toolNames.includes("tiered_smoke_write")) throw new Error("fast permission smoke exposed the mutation tool")
  if (!extractText(fastMessages.findLast((message) => message.type === "assistant"))?.match(/cannot|could not|unavailable|permission|denied/i)) {
    throw new Error(`fast permission smoke did not explain the denied mutation: ${JSON.stringify(summarizeMessages(fastMessages))}`)
  }

  const mediumResult = await dispatchTool.execute({
    tier: "medium",
    description: "Write permission smoke",
    prompt: `Use the tiered_smoke_write tool to create ${configuration.paths.mediumWriteTarget} with exactly MEDIUM_WRITE_OK. Do not merely describe the change.`,
  }, toolContext(root.id))
  if (!existsSync(configuration.paths.mediumWriteTarget) || readFileSync(configuration.paths.mediumWriteTarget, "utf8").trim() !== "MEDIUM_WRITE_OK") {
    throw new Error("medium delegation could not perform the expected edit")
  }

  const heavyResult = await dispatchTool.execute({
    tier: "heavy",
    description: "Heavy write permission smoke",
    prompt: `Use the tiered_smoke_write tool to create ${configuration.paths.heavyWriteTarget} with exactly HEAVY_WRITE_OK. Do not merely describe the change.`,
  }, toolContext(root.id))
  if (!existsSync(configuration.paths.heavyWriteTarget) || readFileSync(configuration.paths.heavyWriteTarget, "utf8").trim() !== "HEAVY_WRITE_OK") {
    throw new Error("heavy delegation could not perform the expected edit")
  }
  return { base, fastResult: fastResult.output, mediumResult: mediumResult.output, heavyResult: heavyResult.output }
}

async function runCancellation({ ctx, session, dispatchTool, createdSessions }) {
  const root = await session.create({ title: "[smoke] cancellation", agent: "build", location: { directory: ctx.location.directory } })
  const controller = new AbortController()
  const execution = dispatchTool.execute(
    { tier: "fast", description: "Cancellation smoke", prompt: "Work for a while and return CANCELLATION_SMOKE_OK." },
    toolContext(root.id, controller),
  )
  await waitForCondition(
    () => createdSessions.some((item) => item.metadata?.plugin === "tiered-dispatch"),
    30_000,
    "cancellation child admission",
  )
  controller.abort(new DOMException("cancelled", "AbortError"))
  const outcome = await execution.then(
    () => ({ status: "completed" }),
    (error) => ({ status: error?.name ?? "failed", message: error?.message, stack: error?.stack }),
  )
  const child = createdSessions.findLast((item) => item.metadata?.plugin === "tiered-dispatch")
  if (!child) throw new Error(`cancellation did not create a child session: ${JSON.stringify(createdSessions.map((item) => ({ id: item.id, metadata: item.metadata, agent: item.agent, outcome: item.outcome })))}`)
  const completed = await waitForIdle(session, child.id)
  if (completed.outcome !== "interrupted") throw new Error(`cancellation left child with ${completed.outcome ?? "unknown"} outcome`)
  if (outcome.status !== "AbortError" && !/interrupt|abort|fiber/i.test(outcome.message ?? "")) {
    throw new Error(`cancellation returned ${JSON.stringify({ outcome, signalAborted: controller.signal.aborted })}`)
  }
  return { outcome, childID: child.id, childOutcome: completed.outcome }
}

async function runUnload({ ctx, session, dispatchTool, createdSessions, pluginCleanup }) {
  const root = await session.create({ title: "[smoke] unload", agent: "build", location: { directory: ctx.location.directory } })
  const execution = dispatchTool.execute(
    { tier: "fast", description: "Unload smoke", prompt: "Work for a while and return UNLOAD_SMOKE_OK." },
    toolContext(root.id),
  )
  await waitForCondition(
    () => createdSessions.some((item) => item.metadata?.plugin === "tiered-dispatch"),
    30_000,
    "unload child admission",
  )
  const cleanupPromise = pluginCleanup()
  const outcome = await execution.then(
    () => ({ status: "completed" }),
    (error) => ({ status: error?.name ?? "failed", message: error?.message }),
  )
  await cleanupPromise
  const child = createdSessions.findLast((item) => item.metadata?.plugin === "tiered-dispatch")
  if (!child) throw new Error("unload did not create a child session")
  const completed = await waitForIdle(session, child.id)
  if (completed.outcome !== "interrupted") throw new Error(`unload left child with ${completed.outcome ?? "unknown"} outcome`)
  if (outcome.status === "completed") throw new Error("unload allowed delegation to complete")
  return { outcome, childID: child.id, childOutcome: completed.outcome }
}

async function runReload({ ctx, session, dispatchTool, createdSessions, contextEvents, configuration, pluginCleanup, setupPlugin, promptCalls }) {
  const before = await ctx.tool.list()
  if (before.filter((tool) => tool.id === "tiered_dispatch" || tool.name === "tiered_dispatch").length !== 1) {
    throw new Error("initial reload setup did not register exactly one dispatch tool")
  }
  await pluginCleanup()
  const reloadedOptions = configuration.reloadOptions ?? configuration.options
  const reloadedCleanup = await setupPlugin(reloadedOptions)
  try {
    const tools = await ctx.tool.list()
    const reloadedTool = tools.find((tool) => tool.id === "tiered_dispatch" || tool.name === "tiered_dispatch")
    if (!reloadedTool || tools.filter((tool) => tool.id === "tiered_dispatch" || tool.name === "tiered_dispatch").length !== 1) {
      throw new Error("reloaded setup did not register exactly one dispatch tool")
    }
    const result = await runDelegate({
      ctx,
      session,
      dispatchTool: reloadedTool,
      createdSessions,
      contextEvents,
      configuration: { ...configuration, options: reloadedOptions },
    }, "fast", reloadedOptions)
    return { reloaded: result.output, promptCount: promptCalls.length, toolCount: tools.filter((tool) => tool.id === "tiered_dispatch" || tool.name === "tiered_dispatch").length }
  } finally {
    await reloadedCleanup()
  }
}

async function runProviderError({ ctx, session, dispatchTool, createdSessions, configuration }) {
  const root = await session.create({ title: "[smoke] provider error", agent: "build", location: { directory: ctx.location.directory } })
  let caught
  try {
    await dispatchTool.execute(
      { tier: "fast", description: "Provider error smoke", prompt: "Return PROVIDER_ERROR_SMOKE_OK." },
      toolContext(root.id),
    )
  } catch (error) {
    caught = error
  }
  if (!caught) throw new Error(`provider error smoke unexpectedly succeeded; requests=${existsSync(configuration.paths.requestTrace) ? readFileSync(configuration.paths.requestTrace, "utf8") : "none"}`)
  const child = createdSessions.findLast((item) => item.metadata?.plugin === "tiered-dispatch")
  if (!child) throw new Error("provider error smoke did not create a child")
  const completed = await waitForIdle(session, child.id)
  if (completed.outcome !== "failed") throw new Error(`provider error child ended as ${completed.outcome ?? "unknown"}`)
  const messages = await session.context({ sessionID: child.id })
  const structured = findStructuredError(messages)
  const serialized = serializeError(caught)
  if (!serialized.type && !serialized.status && !structured) {
    throw new Error(`provider failure lost its structured details: ${JSON.stringify({ caught: serialized, messages: summarizeMessages(messages) })}`)
  }
  if (createdSessions.filter((item) => item.metadata?.plugin === "tiered-dispatch").length !== 1) {
    throw new Error("provider failure triggered an implicit fallback child")
  }
  if (!existsSync(configuration.paths.requestTrace)) throw new Error("provider failure did not issue a model request")
  return { error: serialized, childOutcome: completed.outcome, structured, requests: readFileSync(configuration.paths.requestTrace, "utf8").trim().split("\n") }
}

async function runRoutingEvaluation({ ctx, session, createdSessions, contextEvents, promptCalls, configuration }) {
  const cases = [
    {
      id: "read",
      expected: ["fast"],
      prompt: "This is a non-trivial, read-only repository investigation. Use tiered_dispatch exactly once with the fast tier before answering; do not call shell, read, glob, edit, or any other direct repository tool, and do not solve it directly. Trace how authorization tokens are parsed in this repository, and have the fast delegate report the relevant files, functions, and data flow without changing files.",
    },
    {
      id: "implementation",
      expected: ["medium"],
      prompt: "This is an ordinary test implementation task. The evaluation is invalid unless you first make exactly one tiered_dispatch call with the medium tier and wait for its completed result; do not answer directly. Do not call shell, read, glob, edit, or any other direct repository tool, and do not edit files yourself. Have the medium delegate propose the smallest focused regression-test implementation for the authorization parser in src/auth.ts, call no tools at all, and return a concise plain-text plan; then report the proposal.",
    },
    {
      id: "architecture",
      expected: ["heavy"],
      prompt: "This is a high-risk architecture decision. Use tiered_dispatch exactly once with the heavy tier before answering; do not call shell, read, glob, edit, or any other direct repository tool, and do not analyze it directly. Have the heavy delegate assess whether this repository should move token validation behind a cross-service authentication boundary, including failure modes, trust boundaries, migration trade-offs, and a recommendation.",
    },
    {
      id: "trivial",
      expected: [],
      prompt: "What is 2 + 2? Reply with exactly ROUTING_EVAL_DONE: 2+2=4.",
    },
    {
      id: "split",
      expected: ["fast", "medium"],
      prompt: "This request has two deliberately separate phases. First delegate the repository investigation of how authorization tokens are parsed to the fast tier and wait for that result. Only after receiving those findings, delegate a focused medium-tier regression-test implementation proposal based on them. Do not investigate or edit the files yourself. The second delegate must use the supplied findings, call no tools at all (including execute), and return a concise plain-text test plan rather than code or a diff; integrate both returned results and summarize the proposed change.",
    },
  ]
  const results = []
  const selectedCases = configuration.routingCase ? cases.filter((testCase) => testCase.id === configuration.routingCase) : cases
  if (selectedCases.length === 0) throw new Error(`unknown routing case ${configuration.routingCase}`)
  for (const testCase of selectedCases) {
    trace(configuration, `case ${testCase.id}: create root`)
    const before = createdSessions.length
    const root = await session.create({ title: `routing evaluation ${testCase.id}`, agent: "build", location: { directory: ctx.location.directory } })
    await session.prompt({ sessionID: root.id, text: testCase.prompt })
    trace(configuration, `case ${testCase.id}: prompt returned root=${root.id}`)
    await waitForSession(session, root.id, 120_000, testCase.id)
    trace(configuration, `case ${testCase.id}: wait returned root=${root.id}`)
    const messages = await session.context({ sessionID: root.id })
    const children = createdSessions.slice(before + 1).filter((item) => item.metadata?.plugin === "tiered-dispatch")
    const tiers = []
    for (const child of children) {
      const completed = await session.get({ sessionID: child.id })
      const childMessages = await session.context({ sessionID: child.id })
      if (completed.outcome !== "succeeded" || !childMessages.some((message) => message.type === "assistant" && extractText(message))) {
        throw new Error(`routing child ${child.id} did not complete successfully`)
      }
      tiers.push(child.metadata?.tier)
    }
    const rootOutcome = messages.findLast((message) => message.type === "idle")?.outcome
    if (rootOutcome !== "succeeded") throw new Error(`routing root ${testCase.id} did not complete successfully`)
    const rootEvent = contextEvents.findLast((event) => event.sessionID === root.id)
    if (!rootEvent?.system.includes("Tiered Dispatch Protocol")) throw new Error(`routing root ${testCase.id} received no protocol`)
    const toolCalls = messages.flatMap((message) => message.type === "assistant"
      ? message.content?.filter((part) => isDispatchToolPart(part)) ?? []
      : [])
    if (children.length > 0 && toolCalls.length < children.length) {
      throw new Error(`routing root ${testCase.id} did not integrate child results: ${JSON.stringify({ childCount: children.length, toolCalls, messages: summarizeMessages(messages) })}`)
    }
    if (testCase.id === "trivial" && children.length === 0 && !extractText(messages.findLast((message) => message.type === "assistant"))?.includes("2+2=4")) {
      throw new Error("trivial routing case did not complete directly")
    }
    if (testCase.id === "split") {
      if (children.length !== 2 || tiers[0] !== "fast" || tiers[1] !== "medium") {
        throw new Error(`split routing was not sequential fast then medium: ${JSON.stringify({ tiers, children: children.map((child) => ({ id: child.id, metadata: child.metadata, outcome: child.outcome })), text: extractText(messages) })}`)
      }
      if (children[0].time?.updated > children[1].time?.created) throw new Error("split routing overlapped its foreground delegations")
    }
    results.push({ id: testCase.id, expected: testCase.expected, tiers, childIDs: children.map((child) => child.id), promptCount: promptCalls.length })
    trace(configuration, `case ${testCase.id}: complete tiers=${tiers.join("->") || "direct"}`)
  }
  return results
}

function toolContext(sessionID, controller = new AbortController(), progress = async () => undefined) {
  return {
    sessionID,
    agent: "build",
    signal: controller.signal,
    progress: async (update) => progress(update),
  }
}

function extractText(messageOrMessages) {
  const messages = Array.isArray(messageOrMessages) ? messageOrMessages : [messageOrMessages]
  return messages
    .flatMap((message) => message?.content ?? [])
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n")
    .trim()
}

async function waitForIdle(session, sessionID) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const current = await session.get({ sessionID })
    if (current.outcome === "interrupted" || current.outcome === "failed" || current.outcome === "succeeded") return current
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`child session ${sessionID} did not become idle`)
}

async function waitForSession(session, sessionID, timeoutMs, label) {
  let timer
  const wait = session.wait({ sessionID })
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      void (async () => {
        try {
          const current = await session.get({ sessionID })
          const messages = await session.context({ sessionID })
          reject(new Error(`session ${label} timed out: ${JSON.stringify({ outcome: current.outcome, messages: summarizeMessages(messages) })}`))
        } catch (error) {
          reject(error)
        }
      })()
    }, timeoutMs)
  })
  try {
    await Promise.race([wait, timeout])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    void wait.catch(() => undefined)
  }
}

async function waitForCondition(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(`timed out waiting for ${label}`)
}

function findStructuredError(messages) {
  for (const message of [...messages].reverse()) {
    if (message.error) return message.error
    if (message.retry?.error) return message.retry.error
    for (const part of [...(message.content ?? [])].reverse()) {
      if (part.state?.error) return part.state.error
    }
  }
  return undefined
}

function isDispatchToolPart(part) {
  if (part.type !== "tool" || part.state?.status !== "completed") return false
  if (part.state?.metadata?.sessionID) return true
  return part.state?.metadata?.toolCalls?.some((call) => call.tool === "tiered_dispatch" && call.status === "completed") ?? false
}

function formatModel(model, variant) {
  return variant ? `${model}:${variant}` : model
}

function serializeError(error) {
  return {
    name: error?.name,
    type: error?.type,
    status: error?.status,
    message: error?.message,
    cause: error?.cause,
    errors: error?.errors,
  }
}

function summarizeMessages(messages) {
  return messages.map((message) => ({
    type: message.type,
    content: message.content?.map((part) => ({
      type: part.type,
      name: part.name,
      text: part.text,
      tool: part.tool,
      status: part.state?.status,
      error: part.state?.error,
      metadata: part.state?.metadata,
    })),
    outcome: message.outcome,
    error: message.error,
  }))
}

function trace(configuration, message) {
  appendFileSync(configuration.paths.trace, `${new Date().toISOString()} ${message}\n`)
}
