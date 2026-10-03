import { mkdirSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"

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

export function routingObserverSource(paths, model) {
  // A test observer only: records native calls, never rewrites prompts or routes work.
  return `
import { readFileSync, readdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
function snapshotFiles(directory) {
  return Object.fromEntries(["src", "test"].flatMap(base => readdirSync(join(directory, base), { recursive: true, withFileTypes: true }).filter(entry => entry.isFile()).map(entry => {
    const filename = join(entry.parentPath, entry.name)
    return [filename, readFileSync(filename, "utf8")]
  })))
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
        tools.push({ phase, time: Date.now(), id: event.id, sessionID: event.sessionID, agent: event.agent, tool: event.tool, input: event.input, status: event.status })
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
          results.push({ id: scenario.id, rootSessionID: root.id, elapsedMs: Date.now() - start, tools: tools.slice(toolStart), contexts: contexts.slice(contextStart), sessions, changedFiles })
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
  const problems = []
  if (JSON.stringify(route) !== JSON.stringify(expectedRoute)) problems.push(`expected ${expectedRoute.join("→") || "direct"}; observed ${route.join("→") || "direct"}`)
  if (result.sessions.some(session => session.outcome !== "succeeded")) problems.push("one or more sessions did not succeed")
  if (result.contexts && !result.contexts.some(event => event.sessionID === result.rootSessionID && event.hasProtocol)) problems.push("primary routing protocol was not observed")
  for (let index = 1; index < dispatches.length; index++) {
    const previous = dispatches[index - 1]
    const completed = result.tools.findIndex(event => event.phase === "after" && event.id === previous.id && event.status === "completed")
    if (completed < 0 || completed >= result.tools.indexOf(dispatches[index])) problems.push("dependent phases overlapped or discovery failed")
  }
  if (dispatches.length >= 2 && expectedRoute.length === 2 && !/src\//.test(dispatches[1]?.input?.prompt ?? "")) problems.push("execution prompt did not carry discovered file paths")
  if (result.tools.some(event => event.phase === "after" && event.tool === "subagent" && event.status === "error")) problems.push("a native delegation failed")
  const primaryReads = result.tools.filter(event => event.phase === "before" && event.sessionID === result.rootSessionID && ["read", "glob", "grep", "webfetch", "websearch"].includes(event.tool))
  const directReads = primaryReads.length
  if (directReads > 2) problems.push(`primary exceeded discovery budget: ${directReads} calls`)
  const usage = result.sessions.flatMap(session => session.usage)
  const tokenUsage = usage.filter(entry => entry.tokens)
  const tokens = tokenUsage.length === 0 ? null : tokenUsage.reduce((total, entry) => {
    for (const key of ["input", "output", "reasoning"]) total[key] += entry.tokens[key] ?? 0
    total.cachedRead += entry.tokens.cache?.read ?? 0
    return total
  }, { input: 0, output: 0, reasoning: 0, cachedRead: 0 })
  const firstDispatchIndex = dispatches.length > 0 ? result.tools.indexOf(dispatches[0]) : result.tools.length
  const readsBeforeDispatch = primaryReads.filter(event => result.tools.indexOf(event) < firstDispatchIndex).length
  const readCalls = result.tools.filter(event => event.phase === "before" && ["read", "glob", "grep", "webfetch", "websearch"].includes(event.tool))
  const readFingerprints = readCalls.map(event => `${event.tool}:${JSON.stringify(event.input)}`)
  const repeatedReads = readFingerprints.length - new Set(readFingerprints).size
  return { id: result.id, route, elapsedMs: result.elapsedMs, directReads, readsBeforeDispatch, repeatedReads, toolCalls: result.tools.filter(event => event.phase === "before").length, problems, tokens }
}
