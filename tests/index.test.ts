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

function makeContext(options: Record<string, unknown>): {
  context: Context
  addedTools: Array<{ name: string }>
  hookCallbacks: Array<(event: { agent: string; tools: Record<string, unknown>; system: unknown[] }) => void>
  disposes: { tool: ReturnType<typeof vi.fn>; hook: ReturnType<typeof vi.fn> }
} {
  const addedTools: Array<{ name: string }> = []
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
    },
    tool: {
      list: vi.fn(async () => []),
      transform: vi.fn(async (callback: (editor: { add(tool: { name: string }): void }) => void) => {
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
})
