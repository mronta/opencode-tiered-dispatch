import { mkdirSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { spawnSync } from "node:child_process"

const READ_TOOLS = new Set(["read", "glob", "grep", "webfetch", "websearch"])

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
      setImmediate(() => contexts.push({ sessionID: event.sessionID, agent: event.agent, model: event.model, hasProtocol: event.system.some(part => String(part?.text ?? "").includes("Tiered Dispatch Protocol")) }))
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
          const sessionIDs = [...new Set([root.id, ...contexts.slice(contextStart).map(event => event.sessionID)])]
          const sessions = []
          for (const sessionID of sessionIDs) {
            const info = await ctx.session.get({ sessionID })
            const messages = await ctx.session.context({ sessionID })
            const assistant = messages.filter(message => message.type === "assistant")
            sessions.push({ sessionID, parentID: info.parentID, outcome: info.outcome, text: assistant.flatMap(message => message.content ?? []).filter(part => part.type === "text").map(part => part.text).join("\\n"), usage: assistant.map(message => ({ tokens: message.tokens, cost: message.cost })) })
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

export function assessRouting(result, expectedRoute) {
  const dispatches = result.tools.filter(event => event.phase === "before" && event.tool === "subagent" && event.sessionID === result.rootSessionID)
  const route = dispatches.map(event => event.input?.agent)
  const problems = [...(result.fixtureProblems ?? [])]
  const executionTier = expectedRoute.at(-1)
  const matchesRoute = expectedRoute.length === 0 ? route.length === 0
    : route[0] === expectedRoute[0] && route.at(-1) === executionTier
      && route.every(tier => tier === "fast" || tier === executionTier)
  if (!matchesRoute) problems.push(`expected ${expectedRoute.join("→") || "direct"} (focused discovery/resume cycles allowed); observed ${route.join("→") || "direct"}`)
  if (result.sessions.some(session => session.outcome !== "succeeded")) problems.push("one or more sessions did not succeed")
  if (result.contexts && !result.contexts.some(event => event.sessionID === result.rootSessionID && event.hasProtocol)) problems.push("primary routing protocol was not observed")
  const completions = new Map(result.tools.flatMap((event, index) => event.phase === "after" && event.status === "completed" ? [[event.id, { event, index }]] : []))
  let previousExecution
  for (const dispatch of dispatches) {
    const dispatchIndex = result.tools.indexOf(dispatch)
    const completion = completions.get(dispatch.id)
    if (!completion || completion.index <= dispatchIndex) problems.push("native delegation did not complete")
    if (previousExecution && (completions.get(previousExecution.id)?.index ?? Infinity) >= dispatchIndex) problems.push("recovery or execution began before the previous execution returned")
    if (dispatch.input?.agent === "fast") continue
    previousExecution = dispatch
    const discoveryCalls = dispatches.filter(previous => previous.input?.agent === "fast" && result.tools.indexOf(previous) < result.tools.indexOf(dispatch))
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
  if (result.tools.some(event => event.phase === "after" && event.tool === "subagent" && event.status === "error")) problems.push("a native delegation failed")
  const readCalls = result.tools.filter(event => event.phase === "before" && READ_TOOLS.has(event.tool))
  const primaryReads = readCalls.filter(event => event.sessionID === result.rootSessionID)
  const firstDispatchIndex = dispatches.length > 0 ? result.tools.indexOf(dispatches[0]) : result.tools.length
  const readsBeforeDispatch = primaryReads.filter(event => result.tools.indexOf(event) < firstDispatchIndex).length
  const preDispatchPrimaryTools = result.tools.filter((event, index) => event.phase === "before"
    && event.sessionID === result.rootSessionID
    && event.tool !== "subagent"
    && index < firstDispatchIndex)
  if (expectedRoute.length > 0 && preDispatchPrimaryTools.length > 0) {
    problems.push(`primary used tools before first nontrivial delegation: ${preDispatchPrimaryTools.map(event => event.tool).join(", ")}`)
  }
  const usage = result.sessions.flatMap(session => session.usage)
  const tokenUsage = usage.filter(entry => entry.tokens)
  const tokens = tokenUsage.length === 0 ? null : tokenUsage.reduce((total, entry) => {
    for (const key of ["input", "output", "reasoning"]) total[key] += entry.tokens[key] ?? 0
    total.cachedRead += entry.tokens.cache?.read ?? 0
    return total
  }, { input: 0, output: 0, reasoning: 0, cachedRead: 0 })
  const readFingerprints = readCalls.map(event => `${event.tool}:${JSON.stringify(event.input)}`)
  const repeatedReads = readFingerprints.length - new Set(readFingerprints).size
  return { id: result.id, route, elapsedMs: result.elapsedMs, primaryReadCount: primaryReads.length, readsBeforeDispatch, repeatedReads, toolCalls: result.tools.filter(event => event.phase === "before").length, problems, tokens }
}
