import type { Context } from "@opencode/plugin/promise/plugin"
import { describe, expect, it, vi } from "vitest"
import plugin from "../src/index.js"

const models = [
  { providerID: "openai", id: "gpt-5.6-luna-fast", enabled: true, capabilities: { tools: true }, variants: [] },
  { providerID: "openai", id: "gpt-5.6-luna", enabled: true, capabilities: { tools: true }, variants: [{ id: "max" }] },
  { providerID: "openai", id: "gpt-5.6-sol", enabled: true, capabilities: { tools: true }, variants: [{ id: "medium" }] },
]

type ContextEvent = { sessionID: string; agent: string; tools: Record<string, unknown>; system: unknown[] }
type ToolEvent = { tool: string; input: unknown }

interface FixtureFailures {
  toolHook?: Error
  contextHook?: Error
  dispose?: Partial<Record<"agent" | "tool" | "context", Error>>
}

function makeContext(options: Record<string, unknown>, failures: FixtureFailures = {}): {
  context: Context
  agents: typeof agents
  hookCallbacks: Array<(event: ContextEvent) => void | Promise<void>>
  toolHookCallbacks: Array<(event: ToolEvent) => void | Promise<void>>
  disposes: { agent: ReturnType<typeof vi.fn>; tool: ReturnType<typeof vi.fn>; context: ReturnType<typeof vi.fn> }
  disposalOrder: string[]
  removedAgents: string[]
} {
  const agents = [
    { id: "fast", mode: "subagent" },
    { id: "medium", mode: "subagent" },
    { id: "heavy", mode: "subagent" },
    { id: "build", mode: "primary", permissions: [] },
    { id: "all", mode: "all", permissions: [] },
  ]
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
      list: vi.fn(async () => ({ data: agents })),
      transform: vi.fn(async (callback: (editor: any) => void) => {
        callback({
          list: () => agents,
          get: (id: string) => agents.find((agent) => agent.id === id),
          default: () => undefined,
          update: (id: string, update: (agent: any) => void) => {
            const agent = agents.find((candidate) => candidate.id === id)
            if (!agent) throw new Error(`missing agent ${id}`)
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
        parentID: sessionID === "child" ? "root" : undefined,
      })),
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
  return { context, agents, hookCallbacks, toolHookCallbacks, disposes, disposalOrder, removedAgents }
}

const options = {
  tiers: {
    fast: { model: "openai/gpt-5.6-luna-fast" },
    medium: { model: "openai/gpt-5.6-luna", variant: "max" },
    heavy: { model: "openai/gpt-5.6-sol", variant: "medium" },
  },
}

describe("plugin setup", () => {
  it("injects routing into primary sessions and leaves native tier agents intact", async () => {
    const fixture = makeContext(options)

    const cleanup = await plugin.setup(fixture.context)

    expect(fixture.hookCallbacks).toHaveLength(1)
    expect(fixture.context.agent.transform).toHaveBeenCalledOnce()
    expect(fixture.agents[0]).toMatchObject({
      description: "Focused read-only exploration and research",
      model: { providerID: "openai", id: "gpt-5.6-luna-fast" },
    })
    const hook = fixture.hookCallbacks[0]!
    const root = { sessionID: "root", agent: "build", tools: {}, system: [] as unknown[] }
    await hook(root)
    expect((root.system[0] as { text: string }).text).toContain("native `subagent` tool")
    expect(fixture.context.agent.list).toHaveBeenCalledOnce()

    const child = { sessionID: "child", agent: "fast", tools: {}, system: [] as unknown[] }
    await hook(child)
    expect(child.system).toEqual([])
    expect(fixture.context.agent.list).toHaveBeenCalledOnce()

    const allRoot = { sessionID: "root-all", agent: "all", tools: {}, system: [] as unknown[] }
    await hook(allRoot)
    expect((allRoot.system[0] as { text: string }).text).toContain("native `subagent` tool")

    const allChild = { sessionID: "child", agent: "all", tools: {}, system: [] as unknown[] }
    await hook(allChild)
    expect(allChild.system).toEqual([])

    expect(cleanup).toBeTypeOf("function")
    if (typeof cleanup === "function") await cleanup()
    expect(fixture.disposalOrder).toEqual(["context", "tool", "agent"])
    expect(fixture.disposes.context).toHaveBeenCalledOnce()
    expect(fixture.disposes.tool).toHaveBeenCalledOnce()
    expect(fixture.disposes.agent).toHaveBeenCalledOnce()
  })

  it("does not inspect catalogs or register behavior when disabled", async () => {
    const fixture = makeContext({ enabled: false })

    const cleanup = await plugin.setup(fixture.context)

    expect(cleanup).toBeTypeOf("function")
    expect(fixture.context.model.list).not.toHaveBeenCalled()
    expect(fixture.context.agent.list).not.toHaveBeenCalled()
    expect(fixture.context.agent.transform).toHaveBeenCalledOnce()
    expect(fixture.context.session.hook).not.toHaveBeenCalled()
    expect(fixture.removedAgents).toEqual(["fast", "medium", "heavy"])
    if (typeof cleanup === "function") await cleanup()
    expect(fixture.disposalOrder).toEqual(["agent"])
  })

  it("applies optional tier instructions without injecting routing recursively", async () => {
    const fixture = makeContext({
      ...options,
      tiers: {
        ...options.tiers,
        medium: { model: "openai/gpt-5.6-luna", variant: "max", instructions: "Keep the patch minimal" },
      },
    })
    await plugin.setup(fixture.context)
    const hook = fixture.hookCallbacks[0]!
    const child = { sessionID: "child", agent: "medium", tools: {}, system: [] as unknown[] }

    await hook(child)

    expect((child.system[0] as { text: string }).text).toBe("Keep the patch minimal")
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
      expect(() => guard({ tool: "subagent", input: { agent, model: "other/model" } }))
        .toThrow(new RegExp(`Tier agent ${agent} owns its model configuration`))
    }
    expect(() => guard({ tool: "subagent", input: { agent: "fast" } })).not.toThrow()
    expect(() => guard({ tool: "subagent", input: { agent: "custom", model: "other/model" } })).not.toThrow()
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
})
