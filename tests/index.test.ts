import type { Context } from "@opencode/plugin/promise/plugin"
import { describe, expect, it, vi } from "vitest"
import type { AgentCatalogEntry } from "../src/catalog.js"
import plugin from "../src/index.js"
import { PLAN_READONLY_INSTRUCTION } from "../src/plan-safety.js"
import { modelCatalog, requiredTierOptions, tierModel } from "./tier-fixtures.js"

const models = modelCatalog()

type ContextEvent = { sessionID: string; agent: string; tools: Record<string, unknown>; system: unknown[] }
type ToolEvent = { tool: string; sessionID?: string; agent?: string; input: unknown }
type FixtureAgent = AgentCatalogEntry & {
  permissions: NonNullable<AgentCatalogEntry["permissions"]>
  name?: string
  hidden?: boolean
  steps?: number
  request?: unknown
  color?: string
}

interface FixtureFailures {
  toolHook?: Error
  contextHook?: Error
  dispose?: Partial<Record<"agent" | "tool" | "context", Error>>
}

function makeContext(options: Record<string, unknown>, failures: FixtureFailures = {}): {
  context: Context
  agents: FixtureAgent[]
  setAgentCatalog: (agents: FixtureAgent[]) => void
  setSession: (sessionID: string, session: { parentID?: string; agent?: string }) => void
  setSessionPermissions: (sessionID: string, permissions: FixtureAgent["permissions"]) => void
  hookCallbacks: Array<(event: ContextEvent) => void | Promise<void>>
  toolHookCallbacks: Array<(event: ToolEvent) => void | Promise<void>>
  disposes: { agent: ReturnType<typeof vi.fn>; tool: ReturnType<typeof vi.fn>; context: ReturnType<typeof vi.fn> }
  disposalOrder: string[]
  removedAgents: string[]
} {
  const agents: FixtureAgent[] = [
    { id: "build", mode: "primary", permissions: [] },
    { id: "all", mode: "all", permissions: [] },
    {
      id: "plan",
      mode: "primary",
      permissions: [{ action: "subagent", resource: "*", effect: "allow" }],
    },
  ]
  let agentCatalog = agents
  const sessionInfo = new Map<string, { parentID?: string; agent?: string }>([
    ["root", { agent: "build" }],
    ["root-all", { agent: "all" }],
    ["plan-root", { agent: "plan" }],
    ["child", { parentID: "root", agent: "fast" }],
    ["plan-child", { parentID: "plan-root", agent: "medium" }],
  ])
  const sessionPermissions = new Map<string, FixtureAgent["permissions"]>()
  const hookCallbacks: Array<(event: ContextEvent) => void | Promise<void>> = []
  const toolHookCallbacks: Array<(event: ToolEvent) => void | Promise<void>> = []
  const removedAgents: string[] = []
  const disposalOrder: string[] = []
  const disposes = {
    agent: vi.fn(async () => {
      disposalOrder.push("agent")
      if (failures.dispose?.agent) throw failures.dispose.agent
    }),
    tool: vi.fn(async () => {
      disposalOrder.push("tool")
      if (failures.dispose?.tool) throw failures.dispose.tool
    }),
    context: vi.fn(async () => {
      disposalOrder.push("context")
      if (failures.dispose?.context) throw failures.dispose.context
    }),
  }
  const context = {
    options,
    model: {
      list: vi.fn(async () => ({ data: models })),
    },
    agent: {
      list: vi.fn(async () => ({ data: agentCatalog })),
      transform: vi.fn(async (callback: (editor: any) => void) => {
        callback({
          list: () => agents,
          get: (id: string) => agents.find((agent) => agent.id === id),
          default: () => undefined,
          update: (id: string, update: (agent: any) => void) => {
            const agent = agents.find((candidate) => candidate.id === id) ?? { id, mode: "primary", permissions: [] }
            if (!agents.includes(agent)) agents.push(agent)
            update(agent)
          },
          remove: (id: string) => removedAgents.push(id),
        })
        return { dispose: disposes.agent }
      }),
    },
    tool: {
      hook: vi.fn(async (
        name: "execute.before",
        callback: (event: ToolEvent) => void | Promise<void>,
      ) => {
        expect(name).toBe("execute.before")
        if (failures.toolHook) throw failures.toolHook
        toolHookCallbacks.push(callback)
        return { dispose: disposes.tool }
      }),
    },
    session: {
      get: vi.fn(async ({ sessionID }: { sessionID: string }) => ({
        id: sessionID,
        ...sessionInfo.get(sessionID),
        permissions: sessionPermissions.get(sessionID),
      })),
      update: vi.fn(async ({
        sessionID,
        permissions,
      }: {
        sessionID: string
        permissions: FixtureAgent["permissions"]
      }) => {
        sessionPermissions.set(sessionID, permissions)
      }),
      hook: vi.fn(async (
        name: "context",
        callback: (event: ContextEvent) => void | Promise<void>,
      ) => {
        expect(name).toBe("context")
        if (failures.contextHook) throw failures.contextHook
        hookCallbacks.push(callback)
        return { dispose: disposes.context }
      }),
    },
  } as unknown as Context
  return {
    context,
    agents,
    setAgentCatalog: (next) => { agentCatalog = next },
    setSession: (sessionID, session) => { sessionInfo.set(sessionID, session) },
    setSessionPermissions: (sessionID, permissions) => { sessionPermissions.set(sessionID, permissions) },
    hookCallbacks,
    toolHookCallbacks,
    disposes,
    disposalOrder,
    removedAgents,
  }
}

const options = {
  tiers: requiredTierOptions(),
}

describe("plugin setup", () => {
  it("materializes tiers and injects routing only into root primary sessions", async () => {
    const fixture = makeContext(options)

    const cleanup = await plugin.setup(fixture.context)

    expect(fixture.hookCallbacks).toHaveLength(1)
    expect(fixture.context.agent.transform).toHaveBeenCalledOnce()
    expect(fixture.agents.find((agent) => agent.id === "fast")).toMatchObject({
      mode: "subagent",
      description: "Focused read-only exploration and research",
      model: tierModel("fast"),
    })
    expect(fixture.agents.find((agent) => agent.id === "medium")).toMatchObject({
      mode: "subagent",
      model: tierModel("medium"),
    })
    expect(fixture.agents.find((agent) => agent.id === "heavy")).toMatchObject({
      mode: "subagent",
      model: tierModel("heavy"),
    })
    const hook = fixture.hookCallbacks[0]!
    const root = { sessionID: "root", agent: "build", tools: {}, system: [] as unknown[] }
    await hook(root)
    expect((root.system[0] as { text: string }).text).toContain("native `subagent`")
    expect(fixture.context.agent.list).toHaveBeenCalledOnce()

    const child = { sessionID: "child", agent: "fast", tools: {}, system: [] as unknown[] }
    await hook(child)
    expect(child.system).toEqual([])
    expect(fixture.context.agent.list).toHaveBeenCalledTimes(2)

    const allRoot = { sessionID: "root-all", agent: "all", tools: {}, system: [] as unknown[] }
    await hook(allRoot)
    expect((allRoot.system[0] as { text: string }).text).toContain("native `subagent`")
    expect(fixture.context.agent.list).toHaveBeenCalledTimes(3)

    const allChild = { sessionID: "child", agent: "all", tools: {}, system: [] as unknown[] }
    await hook(allChild)
    expect(allChild.system).toEqual([])
    expect(fixture.context.agent.list).toHaveBeenCalledTimes(4)

    expect(cleanup).toBeTypeOf("function")
    if (typeof cleanup === "function") await cleanup()
    expect(fixture.disposalOrder).toEqual(["context", "tool", "agent"])
    expect(fixture.disposes.context).toHaveBeenCalledOnce()
    expect(fixture.disposes.tool).toHaveBeenCalledOnce()
    expect(fixture.disposes.agent).toHaveBeenCalledOnce()
  })

  it("does not inspect catalogs or register behavior when disabled", async () => {
    const fixture = makeContext({ enabled: false })
    const customFast: FixtureAgent = {
      id: "fast",
      mode: "subagent",
      permissions: [],
      hidden: true,
      steps: 1,
      request: { settings: { stale: true }, headers: {}, body: {} },
    }
    const customMedium: FixtureAgent = {
      id: "medium",
      mode: "subagent",
      permissions: [],
      hidden: true,
      steps: 1,
      request: { settings: { stale: true }, headers: {}, body: {} },
    }
    fixture.agents.push(customFast, customMedium)

    const cleanup = await plugin.setup(fixture.context)

    expect(cleanup).toBeUndefined()
    expect(fixture.context.model.list).not.toHaveBeenCalled()
    expect(fixture.context.agent.list).not.toHaveBeenCalled()
    expect(fixture.context.agent.transform).not.toHaveBeenCalled()
    expect(fixture.context.session.hook).not.toHaveBeenCalled()
    expect(fixture.removedAgents).toEqual([])
    expect(fixture.agents).toContain(customFast)
    expect(fixture.agents).toContain(customMedium)
    expect(customFast).toMatchObject({ hidden: true, steps: 1, request: { settings: { stale: true } } })
    expect(customMedium).toMatchObject({ hidden: true, steps: 1, request: { settings: { stale: true } } })
    expect(fixture.disposalOrder).toEqual([])
  })

  it("lets Plan dispatch every tier while making its sessions read-only", async () => {
    const fixture = makeContext(options)
    const cleanup = await plugin.setup(fixture.context)
    const plan = fixture.agents.find((agent) => agent.id === "plan")
    if (!plan) throw new Error("test fixture is missing plan agent")

    expect(plan.permissions).toEqual([{ action: "subagent", resource: "*", effect: "allow" }])
    fixture.setSessionPermissions("plan-root", [
      { action: "read", resource: "private.txt", effect: "deny" },
      { action: "edit", resource: "*", effect: "allow" },
    ])

    const hook = fixture.hookCallbacks[0]!
    const planContext = { sessionID: "plan-root", agent: "plan", tools: {}, system: [] as unknown[] }
    await hook(planContext)
    expect(planContext.system).toEqual([])
    expect(fixture.context.agent.list).not.toHaveBeenCalled()

    const planRules = vi.mocked(fixture.context.session.update).mock.calls[0]?.[0].permissions
    expect(planRules).toEqual(expect.arrayContaining([
      { action: "read", resource: "private.txt", effect: "deny" },
      { action: "edit", resource: "*", effect: "allow" },
      { action: "*", resource: "*", effect: "deny" },
      { action: "read", resource: "*", effect: "allow" },
      { action: "subagent", resource: "medium", effect: "allow" },
      { action: "subagent", resource: "heavy", effect: "allow" },
    ]))
    if (!planRules) throw new Error("Plan session permissions were not updated")
    expect([...planRules].reverse().find((rule) => rule.action === "edit" || rule.action === "*")?.effect)
      .toBe("deny")
    expect([...planRules].reverse().find(
      (rule) => rule.action === "read" && (rule.resource === "private.txt" || rule.resource === "*"),
    )?.effect).toBe("deny")

    const guard = fixture.toolHookCallbacks[0]!
    for (const agent of ["fast", "medium", "heavy"]) {
      await expect(guard({ tool: "subagent", sessionID: "plan-root", agent: "plan", input: { agent } }))
        .resolves.toBeUndefined()
    }
    await expect(guard({ tool: "subagent", sessionID: "root", agent: "build", input: { agent: "medium" } }))
      .resolves.toBeUndefined()
    await expect(guard({ tool: "subagent", sessionID: "root", agent: "customactor", input: { agent: "medium" } }))
      .resolves.toBeUndefined()

    const childContext = { sessionID: "plan-child", agent: "medium", tools: {}, system: [] as unknown[] }
    await hook(childContext)
    expect(childContext.system).toEqual([{
      type: "text",
      text: PLAN_READONLY_INSTRUCTION,
    }])
    await expect(guard({ tool: "read", sessionID: "plan-child", agent: "medium", input: {} }))
      .resolves.toBeUndefined()
    await expect(guard({ tool: "subagent", sessionID: "plan-child", agent: "medium", input: { agent: "fast" } }))
      .resolves.toBeUndefined()
    await expect(guard({
      tool: "subagent",
      sessionID: "plan-root",
      agent: "plan",
      input: { agent: "medium", sessionID: "plan-child" },
    })).resolves.toBeUndefined()
    for (const tool of ["edit", "write", "shell", "patch"]) {
      await expect(guard({ tool, sessionID: "plan-child", agent: "medium", input: {} }))
        .rejects.toThrow(/sessions are read-only/)
    }

    await expect(guard({
      tool: "subagent",
      sessionID: "plan-root",
      agent: "plan",
      input: { sessionID: "plan-child", agent: "heavy" },
    })).resolves.toBeUndefined()

    if (typeof cleanup === "function") await cleanup()
  })

  it("rejects Plan continuation into non-Plan or unverifiable sessions", async () => {
    const fixture = makeContext(options)
    const cleanup = await plugin.setup(fixture.context)
    const guard = fixture.toolHookCallbacks[0]!
    fixture.setSession("custom-child", { parentID: "plan-root", agent: "custom" })

    for (const sessionID of ["root", "unverified-session"]) {
      await expect(guard({
        tool: "subagent",
        sessionID: "plan-root",
        agent: "plan",
        input: { sessionID },
      })).rejects.toThrow(/read-only ancestry can be verified/)
    }

    await expect(guard({
      tool: "subagent",
      sessionID: "plan-root",
      agent: "plan",
      input: { agent: "custom", sessionID: "custom-child" },
    })).rejects.toThrow(/only the fast, medium, and heavy plugin tiers/)

    if (typeof cleanup === "function") await cleanup()
  })

  it("uses the native permission rule setter when the host exposes it", async () => {
    const fixture = makeContext(options)
    const rules = vi.fn(async () => {})
    ;(fixture.context as unknown as { permission: { rules: typeof rules } }).permission = { rules }
    const cleanup = await plugin.setup(fixture.context)

    await fixture.hookCallbacks[0]!({ sessionID: "plan-root", agent: "plan", tools: {}, system: [] })

    expect(rules).toHaveBeenCalledOnce()
    expect(fixture.context.session.update).not.toHaveBeenCalled()
    if (typeof cleanup === "function") await cleanup()
  })

  it("normalizes every tier execution field without changing cosmetic color", async () => {
    const fixture = makeContext(options)
    const colors = new Map<string, string>()
    for (const tier of ["fast", "medium", "heavy"] as const) {
      const color = `${tier}-color`
      colors.set(tier, color)
      fixture.agents.push({
        id: tier,
        mode: "primary",
        name: `old-${tier}`,
        hidden: true,
        steps: 1,
        request: { settings: { stale: true }, headers: { stale: "true" }, body: { stale: true } },
        color,
        permissions: [{ action: "read", resource: "*", effect: "allow" }],
      })
    }

    await plugin.setup(fixture.context)

    for (const tier of ["fast", "medium", "heavy"] as const) {
      const agent = fixture.agents.find((candidate) => candidate.id === tier)
      if (!agent) throw new Error(`test fixture is missing ${tier} agent`)
      expect(agent).toMatchObject({
        name: tier,
        mode: "subagent",
        hidden: false,
        description: expect.any(String),
        system: expect.any(String),
        model: tierModel(tier),
        request: { settings: {}, headers: {}, body: {} },
        color: colors.get(tier),
      })
      expect(agent).not.toHaveProperty("steps")
      expect(agent.permissions).not.toEqual([{ action: "read", resource: "*", effect: "allow" }])
    }
    const fast = fixture.agents.find((candidate) => candidate.id === "fast")
    const medium = fixture.agents.find((candidate) => candidate.id === "medium")
    const heavy = fixture.agents.find((candidate) => candidate.id === "heavy")
    expect(fast?.request).not.toBe(medium?.request)
    expect(medium?.request).not.toBe(heavy?.request)
  })

  it("applies optional tier instructions without injecting routing recursively", async () => {
    const fixture = makeContext({
      ...options,
      tiers: {
        ...options.tiers,
        medium: { ...requiredTierOptions().medium, instructions: "Keep the patch minimal" },
      },
    })
    await plugin.setup(fixture.context)
    const hook = fixture.hookCallbacks[0]!
    const child = { sessionID: "child", agent: "medium", tools: {}, system: [] as unknown[] }

    await hook(child)

    expect((child.system[0] as { text: string }).text).toBe("Keep the patch minimal")
  })

  it("gives tiers evidence handoff and stop contracts without automatic delegation", async () => {
    const fixture = makeContext(options)
    await plugin.setup(fixture.context)
    const system = (tier: string) => (fixture.agents.find((agent) => agent.id === tier) as unknown as { system: string }).system

    expect(system("fast")).toContain("unresolved questions")
    expect(system("fast")).toContain("Do not repeat broad exploration")
    expect(system("medium")).toContain("NEED CONTEXT:")
    expect(system("medium")).toContain("blocked by repeated failures")
    expect(system("heavy")).toContain("SCOPE GROWTH:")
    expect(system("heavy")).toContain("implementation only when requested")
    for (const tier of ["fast", "medium", "heavy"]) expect(system(tier)).toContain("Do not delegate")
  })

  it("refreshes effective-agent routing for each context", async () => {
    const fixture = makeContext(options)
    await plugin.setup(fixture.context)
    const hook = fixture.hookCallbacks[0]!
    const validCatalog = structuredClone(fixture.agents)

    const primary = { sessionID: "root", agent: "build", tools: {}, system: [] as unknown[] }
    await hook(primary)
    expect(primary.system).toHaveLength(1)

    const subagentCatalog = structuredClone(validCatalog)
    const buildAsSubagent = subagentCatalog.find((agent) => agent.id === "build")
    if (!buildAsSubagent) throw new Error("test fixture is missing build agent")
    buildAsSubagent.mode = "subagent"
    fixture.setAgentCatalog(subagentCatalog)

    const subagent = { sessionID: "root", agent: "build", tools: {}, system: [] as unknown[] }
    await hook(subagent)
    expect(subagent.system).toEqual([])

    const primaryAgain = structuredClone(subagentCatalog)
    const buildAsPrimary = primaryAgain.find((agent) => agent.id === "build")
    if (!buildAsPrimary) throw new Error("test fixture is missing build agent")
    buildAsPrimary.mode = "primary"
    fixture.setAgentCatalog(primaryAgain)

    const restored = { sessionID: "root", agent: "build", tools: {}, system: [] as unknown[] }
    await hook(restored)
    expect(restored.system).toHaveLength(1)
    expect(fixture.context.agent.list).toHaveBeenCalledTimes(3)
  })

  it("revalidates updated tier models and permissions", async () => {
    const fixture = makeContext(options)
    await plugin.setup(fixture.context)
    const hook = fixture.hookCallbacks[0]!
    const validCatalog = structuredClone(fixture.agents)
    await hook({ sessionID: "root", agent: "build", tools: {}, system: [] })

    const invalidModel = structuredClone(validCatalog)
    const fastWithInvalidModel = invalidModel.find((agent) => agent.id === "fast")
    if (!fastWithInvalidModel) throw new Error("test fixture is missing fast agent")
    fastWithInvalidModel.model = { ...tierModel("fast"), id: "other" }
    fixture.setAgentCatalog(invalidModel)
    await expect(hook({ sessionID: "root", agent: "build", tools: {}, system: [] }))
      .rejects.toThrow("model does not match")

    const invalidPermissions = structuredClone(validCatalog)
    const mediumWithInvalidPermissions = invalidPermissions.find((agent) => agent.id === "medium")
    if (!mediumWithInvalidPermissions) throw new Error("test fixture is missing medium agent")
    mediumWithInvalidPermissions.permissions = [
      { action: "*", resource: "*", effect: "deny" },
      { action: "subagent", resource: "*", effect: "deny" },
    ]
    fixture.setAgentCatalog(invalidPermissions)
    await expect(hook({ sessionID: "root", agent: "build", tools: {}, system: [] }))
      .rejects.toThrow("must allow the edit permission")
  })

  it("retries agent catalog loading after a transient failure", async () => {
    const fixture = makeContext(options)
    await plugin.setup(fixture.context)
    const hook = fixture.hookCallbacks[0]!
    await hook({ sessionID: "root", agent: "build", tools: {}, system: [] })
    vi.mocked(fixture.context.agent.list).mockRejectedValueOnce(new Error("agent catalog unavailable"))

    await expect(hook({ sessionID: "root", agent: "build", tools: {}, system: [] }))
      .rejects.toThrow("agent catalog unavailable")
    const root = { sessionID: "root", agent: "build", tools: {}, system: [] as unknown[] }
    await hook(root)

    expect(fixture.context.agent.list).toHaveBeenCalledTimes(3)
    expect(root.system).toHaveLength(1)
  })

  it("fails closed when session ancestry cannot be inspected", async () => {
    const fixture = makeContext(options)
    await plugin.setup(fixture.context)
    vi.mocked(fixture.context.session.get).mockRejectedValue(new Error("session lookup failed"))
    const root = { sessionID: "root", agent: "build", tools: {}, system: [] as unknown[] }

    await fixture.hookCallbacks[0]!(root)

    expect(root.system).toEqual([])
  })

  it("rejects per-call model overrides for packaged tier agents", async () => {
    const fixture = makeContext(options)
    await plugin.setup(fixture.context)

    const guard = fixture.toolHookCallbacks[0]!
    for (const agent of ["fast", "medium", "heavy"]) {
      await expect(guard({ tool: "subagent", input: { agent, model: "other/model" } }))
        .rejects.toThrow(new RegExp(`Tier agent ${agent} owns its model configuration`))
    }
    await expect(guard({ tool: "subagent", input: { agent: "fast" } })).resolves.toBeUndefined()
    await expect(guard({ tool: "subagent", input: { agent: "custom", model: "other/model" } }))
      .resolves.toBeUndefined()
  })

  it("rolls back acquired registrations when tool-hook setup fails", async () => {
    const fixture = makeContext(options, { toolHook: new Error("tool hook failed") })

    await expect(plugin.setup(fixture.context)).rejects.toThrow("tool hook failed")
    expect(fixture.disposalOrder).toEqual(["agent"])
    expect(fixture.context.session.hook).not.toHaveBeenCalled()
  })

  it("rolls back acquired registrations when context-hook setup fails", async () => {
    const fixture = makeContext(options, { contextHook: new Error("context hook failed") })

    await expect(plugin.setup(fixture.context)).rejects.toThrow("context hook failed")
    expect(fixture.disposalOrder).toEqual(["tool", "agent"])
  })

  it("preserves setup and rollback failures", async () => {
    const fixture = makeContext(options, {
      contextHook: new Error("context hook failed"),
      dispose: { tool: new Error("tool cleanup failed") },
    })

    let failure: unknown
    try {
      await plugin.setup(fixture.context)
    } catch (error) {
      failure = error
    }

    expect(failure).toBeInstanceOf(AggregateError)
    const errors = (failure as AggregateError).errors
    expect(errors).toHaveLength(2)
    expect(errors[0]).toBeInstanceOf(Error)
    expect((errors[0] as Error).message).toBe("context hook failed")
    expect(errors[1]).toBeInstanceOf(AggregateError)
    expect((errors[1] as AggregateError).errors[0]).toBeInstanceOf(Error)
    expect(((errors[1] as AggregateError).errors[0] as Error).message).toBe("tool cleanup failed")
    expect(fixture.disposalOrder).toEqual(["tool", "agent"])
  })

  it("attempts every registration when cleanup fails", async () => {
    const fixture = makeContext(options, { dispose: { context: new Error("context cleanup failed") } })
    const cleanup = await plugin.setup(fixture.context)

    if (typeof cleanup !== "function") throw new Error("test setup did not return cleanup")
    await expect(cleanup()).rejects.toThrow("could not dispose every registration")
    expect(fixture.disposalOrder).toEqual(["context", "tool", "agent"])
  })

  it("aggregates every cleanup failure without losing reverse order", async () => {
    const fixture = makeContext(options, {
      dispose: {
        agent: new Error("agent cleanup failed"),
        tool: new Error("tool cleanup failed"),
        context: new Error("context cleanup failed"),
      },
    })
    const cleanup = await plugin.setup(fixture.context)

    if (typeof cleanup !== "function") throw new Error("test setup did not return cleanup")
    let failure: unknown
    try {
      await cleanup()
    } catch (error) {
      failure = error
    }

    expect(failure).toBeInstanceOf(AggregateError)
    expect((failure as AggregateError).errors.map((error) => (error as Error).message)).toEqual([
      "context cleanup failed",
      "tool cleanup failed",
      "agent cleanup failed",
    ])
    expect(fixture.disposalOrder).toEqual(["context", "tool", "agent"])
  })
})
