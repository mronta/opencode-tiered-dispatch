import { mkdirSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { spawnSync } from "node:child_process"

const READ_TOOLS = new Set(["read", "glob", "grep", "webfetch", "websearch"])
// The primary may coordinate another delegation or inspect the workspace after
// a delegation returns. Keep this allowlist deliberately narrow: implementation
// and arbitrary command-execution tools must remain in the delegated session.
const PRIMARY_POST_DELEGATION_TOOLS = new Set(["subagent", "skill", ...READ_TOOLS])

export const scenarios = [
  { id: "trivial", text: "What is 2 + 2? Reply with just the number.", route: [] },
  {
    id: "known-scope",
    text: "In src/banner.js change banner(name) from `return name` to return the template literal `Hello, ${name}!`; keep the exported signature. Update test/banner.test.js to assert banner('Ada') is 'Hello, Ada!' and run node --test test/banner.test.js. No other files need changing.",
    route: ["medium"],
  },
  {
    id: "discover-implement",
    text: "Find how display names travel through this app and where their validation belongs. Reject blank names after trimming and names longer than the configured limit after trimming; preserve the existing result shape. Add regression tests and run npm test.",
    route: ["fast", "medium"],
  },
  {
    id: "discover-analyze",
    text: "Map the authentication trust boundaries and assess whether the login flow is safe against replay and forged identity. Recommend a migration strategy with trade-offs and cite concrete file evidence. Do not edit files.",
    route: ["fast", "heavy"],
  },
]

export function seedRoutingFixture(workspace) {
  const files = {
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
  }
  for (const [path, content] of Object.entries(files)) {
    const filename = join(workspace, path)
    mkdirSync(dirname(filename), { recursive: true })
    writeFileSync(filename, content)
  }
}

export function checkFixture(workspace, scenarioID, nodeBinary = "node") {
  if (!["known-scope", "discover-implement"].includes(scenarioID)) return []
  const checks = {
    "known-scope": "import { banner } from './src/banner.js'; assert.equal(banner('Ada'), 'Hello, Ada!')",
    "discover-implement": `
      import { saveName } from './src/controller.js'
      assert.equal(saveName('   ').ok, false)
      assert.equal(saveName(' abcdefghijklm ').ok, false)
      assert.deepEqual(saveName(' abcdefghijkl '), { ok: true, name: 'abcdefghijkl', limit: 12 })
    `,
  }
  const behavior = spawnSync(nodeBinary, ["--input-type=module", "-e", "import assert from 'node:assert/strict';\n" + checks[scenarioID]], { cwd: workspace, encoding: "utf8", timeout: 30_000 })
  const args = scenarioID === "known-scope" ? ["--test", "test/banner.test.js"] : ["--test"]
  const tests = spawnSync(nodeBinary, args, { cwd: workspace, encoding: "utf8", timeout: 30_000 })
  return [behavior, tests].filter(result => result.status !== 0).map(result => `fixture verification failed: ${result.error?.message ?? result.stderr}\n${result.stdout}`)
}

export function routingObserverSource(paths, model) {
  // A test observer only: records native calls, never rewrites prompts or routes work.
  return `
import { readFileSync, readdirSync, readlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { checkFixture } from ${JSON.stringify(import.meta.url)}
function snapshotFiles(directory) {
  const files = {}
  function visit(base) {
    for (const entry of readdirSync(base, { withFileTypes: true })) {
      const filename = join(base, entry.name)
      if (entry.isDirectory()) {
        if (!["node_modules", ".git"].includes(entry.name)) visit(filename)
      } else if (entry.isSymbolicLink()) files[filename] = "symlink:" + readlinkSync(filename)
      else if (entry.isFile()) files[filename] = readFileSync(filename).toString("base64")
    }
  }
  visit(directory)
  return files
}
export default {
  id: "tiered-routing-eval",
  async setup(ctx) {
    const tools = []
    const contexts = []
    const registrations = []
    registrations.push(await ctx.session.hook("context", event => {
      setImmediate(() => contexts.push({ sessionID: event.sessionID, agent: event.agent, model: event.model, variant: event.variant, hasProtocol: event.system.some(part => String(part?.text ?? "").includes("Tiered Dispatch Protocol")) }))
    }))
    for (const phase of ["before", "after"]) {
      registrations.push(await ctx.tool.hook("execute." + phase, event => {
        tools.push({ phase, time: Date.now(), id: event.id, sessionID: event.sessionID, agent: event.agent, tool: event.tool, input: event.input, status: event.status, resultText: event.status === "completed" ? JSON.stringify(event.result) : undefined })
      }))
    }
    writeFileSync(${JSON.stringify(paths.marker)}, "ready")
    setImmediate(() => void (async () => {
      const results = []
      try {
        for (const scenario of ${JSON.stringify(scenarios)}) {
          const start = Date.now()
          const beforeFiles = snapshotFiles(ctx.location.directory)
          const toolStart = tools.length
          const contextStart = contexts.length
          const root = await ctx.session.create({ title: "[routing eval] " + scenario.id, agent: "build", model: ${JSON.stringify(model)}, location: { directory: ctx.location.directory } })
          await ctx.session.prompt({ sessionID: root.id, text: scenario.text })
          await ctx.session.wait({ sessionID: root.id })
          await new Promise(resolve => setImmediate(resolve))
          const sessionIDs = [...new Set([root.id, ...contexts.slice(contextStart).map(event => event.sessionID)])]
          const sessions = []
          for (const sessionID of sessionIDs) {
            const info = await ctx.session.get({ sessionID })
            const messages = await ctx.session.context({ sessionID })
            const assistant = messages.filter(message => message.type === "assistant")
            const context = [...contexts.slice(contextStart)].reverse().find(event => event.sessionID === sessionID)
            sessions.push({ sessionID, parentID: info.parentID, agent: info.agent ?? context?.agent, model: info.model ?? context?.model, variant: info.variant ?? context?.variant, outcome: info.outcome, text: assistant.flatMap(message => message.content ?? []).filter(part => part.type === "text").map(part => part.text).join("\\n"), usage: assistant.map(message => ({ tokens: message.tokens, cost: message.cost })) })
          }
          const afterFiles = snapshotFiles(ctx.location.directory)
          const changedFiles = [...new Set([...Object.keys(beforeFiles), ...Object.keys(afterFiles)])].filter(path => beforeFiles[path] !== afterFiles[path])
          const fixtureProblems = checkFixture(ctx.location.directory, scenario.id, ${JSON.stringify(process.execPath)})
          if (scenario.id === "known-scope" && changedFiles.some(path => ![join(ctx.location.directory, "src/banner.js"), join(ctx.location.directory, "test/banner.test.js")].includes(path))) fixtureProblems.push("known-scope edit changed unrelated files")
          results.push({ id: scenario.id, rootSessionID: root.id, elapsedMs: Date.now() - start, tools: tools.slice(toolStart), contexts: contexts.slice(contextStart), sessions, changedFiles, fixtureProblems })
        }
        writeFileSync(${JSON.stringify(paths.result)}, JSON.stringify(results))
      } catch (error) {
        writeFileSync(${JSON.stringify(paths.failure)}, JSON.stringify({ message: error?.message ?? String(error), results, tools }))
      }
    })())
    return async () => { for (const registration of registrations.reverse()) await registration.dispose() }
  }
}
`
}

export function assessRouting(result, expectedRoute, tierModels) {
  const tools = result.tools ?? []
  const dispatches = tools.filter(event => event.phase === "before" && event.tool === "subagent" && event.sessionID === result.rootSessionID)
  const route = dispatches.map(event => event.input?.agent)
  const problems = [...(result.fixtureProblems ?? [])]
  const configuredTierModels = tierModels ?? result.requiredTierModels ?? result.tierModels
  const executionTier = expectedRoute.at(-1)
  const matchesRoute = expectedRoute.length === 0 ? route.length === 0
    : route[0] === expectedRoute[0] && route.at(-1) === executionTier
      && route.every(tier => tier === "fast" || tier === executionTier)
  if (!matchesRoute) problems.push(`expected ${expectedRoute.join("→") || "direct"} (focused discovery/resume cycles allowed); observed ${route.join("→") || "direct"}`)
  if ((result.sessions ?? []).some(session => session.outcome !== "succeeded")) problems.push("one or more sessions did not succeed")
  if (result.contexts && !result.contexts.some(event => event.sessionID === result.rootSessionID && event.hasProtocol)) problems.push("primary routing protocol was not observed")
  problems.push(...correlationProblems(result, dispatches, configuredTierModels))
  const completions = new Map(tools.flatMap((event, index) => event.phase === "after" && event.status === "completed" ? [[event.id, { event, index }]] : []))
  let previousExecution
  for (const dispatch of dispatches) {
    const dispatchIndex = tools.indexOf(dispatch)
    const completion = completions.get(dispatch.id)
    if (!completion || completion.index <= dispatchIndex) problems.push("native delegation did not complete")
    if (previousExecution && (completions.get(previousExecution.id)?.index ?? Infinity) >= dispatchIndex) problems.push("recovery or execution began before the previous execution returned")
    if (dispatch.input?.agent === "fast") continue
    previousExecution = dispatch
    const discoveryCalls = dispatches.filter(previous => previous.input?.agent === "fast" && tools.indexOf(previous) < tools.indexOf(dispatch))
    for (const discovery of discoveryCalls) {
      if ((completions.get(discovery.id)?.index ?? Infinity) >= dispatchIndex) problems.push("dependent phases overlapped or discovery failed")
    }
    const discovery = discoveryCalls.at(-1)
    if (discovery) {
      const evidence = completions.get(discovery.id)?.event.resultText ?? ""
      const paths = (evidence.match(/src\/[\w./-]+/g) ?? []).map(path => path.replace(/\.+$/, ""))
      if (!paths.some(path => dispatch.input?.prompt?.includes(path))) problems.push("execution prompt did not carry discovered file evidence")
    }
  }
  if (tools.some(event => event.phase === "after" && event.tool === "subagent" && event.status === "error")) problems.push("a native delegation failed")
  const readCalls = tools.filter(event => event.phase === "before" && READ_TOOLS.has(event.tool))
  const primaryReads = readCalls.filter(event => event.sessionID === result.rootSessionID)
  const primaryToolCalls = tools.filter(event => event.phase === "before" && event.sessionID === result.rootSessionID)
  const firstDispatchIndex = dispatches.length > 0 ? tools.indexOf(dispatches[0]) : tools.length
  const readsBeforeDispatch = primaryReads.filter(event => tools.indexOf(event) < firstDispatchIndex).length
  const preDispatchPrimaryTools = primaryToolCalls.filter(event => {
    const index = tools.indexOf(event)
    return event.tool !== "subagent" && index < firstDispatchIndex
  })
  if (expectedRoute.length > 0 && preDispatchPrimaryTools.length > 0) {
    problems.push(`primary used tools before first nontrivial delegation: ${preDispatchPrimaryTools.map(event => event.tool).join(", ")}`)
  }
  if (expectedRoute.length === 0 && primaryToolCalls.length > 1) {
    problems.push(`trivial route used ${primaryToolCalls.length} primary tool calls (expected at most one)`)
  }
  if (dispatches.length > 0) {
    const postDispatchPrimaryTools = primaryToolCalls.filter(event => tools.indexOf(event) > firstDispatchIndex && !isAllowedPrimaryPostDelegation(event))
    if (postDispatchPrimaryTools.length > 0) {
      problems.push(`primary used disallowed tools after delegation: ${postDispatchPrimaryTools.map(event => event.tool).join(", ")}`)
    }
  }
  const usage = (result.sessions ?? []).flatMap(session => session.usage ?? [])
  const tokenUsage = usage.filter(entry => entry.tokens)
  const tokens = tokenUsage.length === 0 ? null : tokenUsage.reduce((total, entry) => {
    for (const key of ["input", "output", "reasoning"]) total[key] += entry.tokens[key] ?? 0
    total.cachedRead += entry.tokens.cache?.read ?? 0
    return total
  }, { input: 0, output: 0, reasoning: 0, cachedRead: 0 })
  const readFingerprints = readCalls.map(event => `${event.tool}:${JSON.stringify(event.input)}`)
  const repeatedReads = readFingerprints.length - new Set(readFingerprints).size
  return { id: result.id, route, elapsedMs: result.elapsedMs, primaryReadCount: primaryReads.length, readsBeforeDispatch, repeatedReads, toolCalls: tools.filter(event => event.phase === "before").length, problems, tokens }
}

function isAllowedPrimaryPostDelegation(event) {
  if (PRIMARY_POST_DELEGATION_TOOLS.has(event.tool)) return true
  return event.tool === "shell" && isVerificationCommand(event.input?.command)
}

function isVerificationCommand(command) {
  if (typeof command !== "string") return false
  const trimmed = command.trim()
  if (trimmed === "") return false
  const inlineNode = trimmed.match(/^node\s+--input-type=module\s+-e\s+(?:"([\s\S]*)"|'([\s\S]*)')$/i)
  if (inlineNode) return isReadOnlyInlineNodeScript(inlineNode[1] ?? inlineNode[2])
  if (/[|;&`<>\n\r]|\$\(/u.test(trimmed)) return false
  if (/(?:^|\s)(?:>>?|<<|tee|touch|rm|rmdir|mv|cp|install|mkdir|sed\s+-i|perl\s+-i|python(?:3)?\s+-c|node\s+-e|git\s+(?:add|commit|reset|restore|checkout|clean)|npm\s+(?:install|ci|uninstall)|pnpm\s+(?:add|install|remove)|yarn\s+(?:add|install|remove))\b/i.test(trimmed)) return false
  if (/(?:^|\s)--?(?:output|out|write|fix|update(?:snapshot)?|watch(?:all)?|coverage(?:directory|-directory)?)(?:=|\s|$)/i.test(trimmed)) return false
  return /^(?:(?:npm|pnpm|yarn|bun)\s+(?:test|run\s+(?:test|typecheck|check|verify|lint))|(?:node|bun|deno)\s+--test|(?:pytest|vitest|jest|cargo\s+test|go\s+test|make\s+(?:test|check|verify|lint))|git\s+(?:diff|status|log)(?:\s|$))/i.test(trimmed)
}

function isReadOnlyInlineNodeScript(script) {
  if (/[`\n\r]|\$\(/u.test(script)) return false
  return !/(?:node:(?:fs|child_process|net|http|https)\b|\b(?:writeFile|appendFile|write|append|unlink|rm|mkdir|rmdir|rename|copyFile|chmod|chown|truncate)(?:Sync)?\s*\(|\b(?:exec|spawn|fork)(?:Sync)?\s*\(|\bfetch\s*\(|\b(?:Deno|Bun)\.(?:write|remove|rename|spawn)\s*\(|\bprocess\.(?:exit|kill|chdir)\s*\()/i.test(script)
}

function correlationProblems(result, dispatches, tierModels) {
  if (dispatches.length === 0) return []

  const contexts = new Map()
  for (const context of result.contexts ?? []) {
    if (context.sessionID !== undefined) contexts.set(context.sessionID, context)
  }

  const observed = new Map()
  for (const session of result.sessions ?? []) {
    if (session.sessionID === undefined) continue
    const context = contexts.get(session.sessionID)
    observed.set(session.sessionID, {
      ...context,
      ...session,
      agent: session.agent ?? context?.agent,
      model: session.model ?? context?.model,
      variant: session.variant ?? context?.variant,
    })
  }
  // Keep context-only records visible so a missing session inspection cannot
  // accidentally make a root tool trace look like a completed child.
  for (const [sessionID, context] of contexts) {
    if (!observed.has(sessionID)) observed.set(sessionID, { ...context, sessionID })
  }

  const children = [...observed.values()].filter(session => session.sessionID !== result.rootSessionID)
  const used = new Set()
  const problems = []
  for (const dispatch of dispatches) {
    const agent = dispatch.input?.agent
    const available = children.filter(session => !used.has(session.sessionID) && session.agent === agent)
    const rooted = available.find(session => session.parentID === result.rootSessionID)
    if (!rooted) {
      problems.push(`native delegation ${agent ?? "unknown"} did not correlate to an observed child session with parent ${result.rootSessionID}`)
      continue
    }
    const child = available.find(session => session.parentID === result.rootSessionID && session.outcome === "succeeded")
    if (!child) {
      problems.push(`native delegation ${agent ?? "unknown"} child session did not succeed`)
      continue
    }
    used.add(child.sessionID)
    const expectedModel = tierModels?.[agent]
    if (expectedModel !== undefined && !matchesTierModel(child.model, expectedModel, child.variant)) {
      problems.push(`native delegation ${agent} child session used an unexpected model or variant`)
    }
  }
  return problems
}

function matchesTierModel(observedModel, expectedModel, observedVariant) {
  const actual = normalizeModel(observedModel, observedVariant)
  const expected = normalizeModel(expectedModel)
  if (!actual || !expected) return false
  return actual.providerID === expected.providerID
    && actual.id === expected.id
    && normalizeVariant(actual.variant, expected.variant) === expected.variant
}

function normalizeModel(value, variant) {
  if (typeof value === "string") {
    const [reference, embeddedVariant] = value.split("#", 2)
    const separator = reference.indexOf("/")
    if (separator <= 0 || separator === reference.length - 1) return undefined
    return {
      providerID: reference.slice(0, separator),
      id: reference.slice(separator + 1),
      variant: variant ?? embeddedVariant,
    }
  }
  if (value && typeof value === "object") {
    const model = value
    if (typeof model.providerID === "string" && typeof model.id === "string") {
      return { providerID: model.providerID, id: model.id, variant: variant ?? model.variant }
    }
    if (typeof model.model === "string") return normalizeModel(model.model, variant ?? model.variant)
    if (model.model && typeof model.model === "object") return normalizeModel(model.model, variant ?? model.variant)
    if (model.modelRef && typeof model.modelRef === "object") return normalizeModel(model.modelRef, variant ?? model.variant)
  }
  return undefined
}

function normalizeVariant(actual, expected) {
  return expected === undefined && actual === "default" ? undefined : actual
}
