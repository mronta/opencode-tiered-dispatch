import type { Context } from "@opencode/plugin/promise/plugin"
import { describe, expect, it, vi } from "vitest"
import plugin from "../src/index.js"

const models = [
  { providerID: "p", id: "fast", enabled: true, capabilities: { tools: true }, variants: [{ id: "low" }] },
  { providerID: "p", id: "medium", enabled: true, capabilities: { tools: true }, variants: [] },
  { providerID: "p", id: "heavy", enabled: true, capabilities: { tools: true }, variants: [] },
]

const agents = [
  { id: "explore", mode: "subagent", permissions: [] },
  { id: "general", mode: "subagent", permissions: [] },
]

type CapturedTool = {
  name: string
  execute?: (input: unknown, context: unknown) => Promise<unknown>
  [key: string]: unknown
}

function makeContext(options: Record<string, unknown>): {
  context: Context
  addedTools: CapturedTool[]
  hookCallbacks: Array<(event: { agent: string; tools: Record<string, unknown>; system: unknown[] }) => void>
  disposes: { tool: ReturnType<typeof vi.fn>; hook: ReturnType<typeof vi.fn> }
} {
  const addedTools: CapturedTool[] = []
  const hookCallbacks: Array<(event: { agent: string; tools: Record<string, unknown>; system: unknown[] }) => void> = []
  const disposes = {
    tool: vi.fn(async () => undefined),
    hook: vi.fn(async () => undefined),
  }
  const context = {
    options,
    model: {
      list: vi.fn(async () => ({ data: models })),
    },
    agent: {
      list: vi.fn(async () => ({ data: agents })),
      get: vi.fn(async ({ agentID }: { agentID: string }) => ({
        data: { id: agentID, permissions: [{ action: "*", resource: "*", effect: "allow" as const }] },
      })),
    },
    tool: {
      list: vi.fn(async () => []),
     transform: vi.fn(async (callback: (editor: { add(tool: CapturedTool): void }) => void) => {
         callback({ add: (tool) => addedTools.push(tool) })
         return { dispose: disposes.tool }
       }),
    },
    session: {
      hook: vi.fn(async (
        name: "context",
        callback: (event: { agent: string; tools: Record<string, unknown>; system: unknown[] }) => void,
      ) => {
        expect(name).toBe("context")
        hookCallbacks.push(callback)
        return { dispose: disposes.hook }
      }),
      get: vi.fn(async ({ sessionID }: { sessionID: string }) => sessionID === "root"
        ? { id: sessionID, location: { directory: "/workspace" }, permissions: [{ action: "edit", resource: "*", effect: "deny" as const }] }
        : { id: sessionID, location: { directory: "/workspace" }, outcome: "succeeded" as const }),
      create: vi.fn(async (input: { location: { directory: string } }) => ({ id: "child", location: input.location })),
      prompt: vi.fn(async () => ({ id: "user" })),
      wait: vi.fn(async () => undefined),
      context: vi.fn(async () => [
        { type: "assistant", content: [{ type: "text", text: "delegated" }] },
      ]),
      interrupt: vi.fn(async () => undefined),
    },
  } as unknown as Context
  return { context, addedTools, hookCallbacks, disposes }
}

describe("plugin setup", () => {
  it("registers the dispatch tool and root context hook", async () => {
    const fixture = makeContext({
      tiers: {
        fast: { model: "p/fast", variant: "low" },
        medium: { model: "p/medium" },
        heavy: { model: "p/heavy" },
      },
    })

    const cleanup = await plugin.setup(fixture.context)

    expect(fixture.addedTools.map((tool) => tool.name)).toEqual(["tiered_dispatch"])
    expect(fixture.hookCallbacks).toHaveLength(1)
    const hook = fixture.hookCallbacks[0]!
    const root = { agent: "build", tools: { tiered_dispatch: {} }, system: [] as unknown[] }
    hook(root)
    expect(root.system).toHaveLength(1)
    const child = { agent: "explore", tools: { tiered_dispatch: {} }, system: [] as unknown[] }
    hook(child)
    expect(child.tools).toEqual({})
    expect(child.system).toEqual([])
    expect(cleanup).toBeTypeOf("function")
    if (typeof cleanup === "function") await cleanup()
    expect(fixture.disposes.tool).toHaveBeenCalledOnce()
    expect(fixture.disposes.hook).toHaveBeenCalledOnce()
  })

  it("does not inspect catalogs or register behavior when disabled", async () => {
    const fixture = makeContext({ enabled: false })

    const cleanup = await plugin.setup(fixture.context)

    expect(cleanup).toBeUndefined()
    expect(fixture.context.model.list).not.toHaveBeenCalled()
    expect(fixture.context.agent.list).not.toHaveBeenCalled()
    expect(fixture.context.tool.transform).not.toHaveBeenCalled()
    expect(fixture.context.session.hook).not.toHaveBeenCalled()
  })

  it("executes through the V2 runtime adapter with fast-tier restrictions", async () => {
    const fixture = makeContext({
      tiers: {
        fast: { model: "p/fast", variant: "low" },
        medium: { model: "p/medium" },
        heavy: { model: "p/heavy" },
      },
    })
    const cleanup = await plugin.setup(fixture.context)
    const tool = fixture.addedTools[0]
    if (!tool?.execute) throw new Error("test tool was not registered")

    const result = await tool.execute(
      { tier: "fast", description: "Inspect the repository", prompt: "Find the relevant files" },
      {
        sessionID: "root",
        agent: "build",
        signal: new AbortController().signal,
        progress: vi.fn(async () => undefined),
      },
    )

    expect(result).toMatchObject({ output: { tier: "fast", model: "p/fast:low", sessionID: "child", text: "delegated" } })
    expect(fixture.context.session.create).toHaveBeenCalledWith(expect.objectContaining({
      agent: "explore",
      model: { providerID: "p", id: "fast", variant: "low" },
    }))
    const createInput = vi.mocked(fixture.context.session.create).mock.calls[0]?.[0] as unknown as {
      permissions: ReadonlyArray<{ action: string; effect: string }>
    }
    expect(createInput.permissions.findLast((rule) => rule.action === "*")?.effect).toBe("deny")
    expect(createInput.permissions.find((rule) => rule.action === "edit" && rule.effect === "allow")).toBeUndefined()
    expect(fixture.context.session.prompt).toHaveBeenCalledWith(expect.objectContaining({
      sessionID: "child",
      text: expect.stringContaining("Find the relevant files"),
    }))

    if (typeof cleanup === "function") await cleanup()
  })

  it("surfaces a structured provider failure without trying another tier", async () => {
    const fixture = makeContext({
      tiers: {
        fast: { model: "p/fast" },
        medium: { model: "p/medium" },
        heavy: { model: "p/heavy" },
      },
    })
    vi.mocked(fixture.context.session.get).mockImplementation(async ({ sessionID }: { sessionID: string }) => (
      sessionID === "root"
        ? { id: sessionID, location: { directory: "/workspace" }, permissions: [] }
        : { id: sessionID, location: { directory: "/workspace" }, outcome: "failed" as const }
    ) as never)
    vi.mocked(fixture.context.session.context).mockResolvedValue([
      { type: "assistant", content: [], error: { type: "rate_limit", message: "provider refused", status: 429 } },
    ] as never)
    const cleanup = await plugin.setup(fixture.context)
    const tool = fixture.addedTools[0]
    if (!tool?.execute) throw new Error("test tool was not registered")

    await expect(tool.execute(
      { tier: "fast", description: "Fail", prompt: "Trigger the provider failure" },
      {
        sessionID: "root",
        agent: "build",
        signal: new AbortController().signal,
        progress: vi.fn(async () => undefined),
      },
    )).rejects.toMatchObject({
      name: "TieredDispatchProviderError",
      message: "rate_limit: provider refused",
      providerError: { type: "rate_limit", message: "provider refused", status: 429 },
    })
    expect(fixture.context.session.create).toHaveBeenCalledOnce()
    expect(fixture.context.session.create).toHaveBeenCalledWith(expect.objectContaining({
      model: { providerID: "p", id: "fast" },
    }))

    if (typeof cleanup === "function") await cleanup()
  })

  it("disposes registrations across a plugin reload and supports a changed configuration", async () => {
    const first = makeContext({
      tiers: {
        fast: { model: "p/fast" },
        medium: { model: "p/medium" },
        heavy: { model: "p/heavy" },
      },
    })
    const firstCleanup = await plugin.setup(first.context)
    expect(first.addedTools).toHaveLength(1)
    if (typeof firstCleanup === "function") await firstCleanup()
    expect(first.disposes.tool).toHaveBeenCalledOnce()
    expect(first.disposes.hook).toHaveBeenCalledOnce()

    const second = makeContext({
      logging: true,
      tiers: {
        fast: { model: "p/fast", variant: "low" },
        medium: { model: "p/medium" },
        heavy: { model: "p/heavy" },
      },
    })
    const secondCleanup = await plugin.setup(second.context)
    expect(second.addedTools.map((tool) => tool.name)).toEqual(["tiered_dispatch"])
    expect(second.context.model.list).toHaveBeenCalledOnce()
    if (typeof secondCleanup === "function") await secondCleanup()
    expect(second.disposes.tool).toHaveBeenCalledOnce()
    expect(second.disposes.hook).toHaveBeenCalledOnce()
  })
})
