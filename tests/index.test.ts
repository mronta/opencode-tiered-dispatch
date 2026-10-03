import type { Context } from "@opencode/plugin/promise/plugin"
import { describe, expect, it, vi } from "vitest"
import plugin from "../src/index.js"

const models = [
  { providerID: "p", id: "fast", enabled: true, capabilities: { tools: true }, variants: [{ id: "low" }] },
  { providerID: "p", id: "medium", enabled: true, capabilities: { tools: true }, variants: [] },
  { providerID: "p", id: "heavy", enabled: true, capabilities: { tools: true }, variants: [] },
]

const agents = [
  {
    id: "fast",
    mode: "subagent",
    model: { providerID: "p", id: "fast", variant: "low" },
    permissions: [
      { action: "*", resource: "*", effect: "deny" as const },
      { action: "subagent", resource: "*", effect: "deny" as const },
    ],
  },
  {
    id: "medium",
    mode: "subagent",
    model: { providerID: "p", id: "medium" },
    permissions: [
      { action: "*", resource: "*", effect: "allow" as const },
      { action: "subagent", resource: "*", effect: "deny" as const },
    ],
  },
  {
    id: "heavy",
    mode: "subagent",
    model: { providerID: "p", id: "heavy" },
    permissions: [
      { action: "*", resource: "*", effect: "allow" as const },
      { action: "subagent", resource: "*", effect: "deny" as const },
    ],
  },
  { id: "build", mode: "primary", permissions: [] },
  { id: "all", mode: "all", permissions: [] },
]

function makeContext(options: Record<string, unknown>): {
  context: Context
  hookCallbacks: Array<(event: { sessionID: string; agent: string; tools: Record<string, unknown>; system: unknown[] }) => void | Promise<void>>
  disposes: { hook: ReturnType<typeof vi.fn> }
} {
  const hookCallbacks: Array<(event: { sessionID: string; agent: string; tools: Record<string, unknown>; system: unknown[] }) => void | Promise<void>> = []
  const disposes = {
    hook: vi.fn(async () => undefined),
  }
  const context = {
    options,
    model: {
      list: vi.fn(async () => ({ data: models })),
    },
    agent: {
      list: vi.fn(async () => ({ data: agents })),
      transform: vi.fn(async () => ({ dispose: vi.fn(async () => undefined) })),
    },
    session: {
      get: vi.fn(async ({ sessionID }: { sessionID: string }) => ({
        id: sessionID,
        parentID: sessionID === "child" ? "root" : undefined,
      })),
      hook: vi.fn(async (
        name: "context",
        callback: (event: { sessionID: string; agent: string; tools: Record<string, unknown>; system: unknown[] }) => void | Promise<void>,
      ) => {
        expect(name).toBe("context")
        hookCallbacks.push(callback)
        return { dispose: disposes.hook }
      }),
    },
  } as unknown as Context
  return { context, hookCallbacks, disposes }
}

const options = {
  tiers: {
    fast: { model: "p/fast", variant: "low" },
    medium: { model: "p/medium" },
    heavy: { model: "p/heavy" },
  },
}

describe("plugin setup", () => {
  it("injects routing into primary sessions and leaves native tier agents intact", async () => {
    const fixture = makeContext(options)

    const cleanup = await plugin.setup(fixture.context)

    expect(fixture.hookCallbacks).toHaveLength(1)
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
    expect(fixture.disposes.hook).toHaveBeenCalledOnce()
  })

  it("does not inspect catalogs or register behavior when disabled", async () => {
    const fixture = makeContext({ enabled: false })

    const cleanup = await plugin.setup(fixture.context)

    expect(cleanup).toBeUndefined()
    expect(fixture.context.model.list).not.toHaveBeenCalled()
    expect(fixture.context.agent.list).not.toHaveBeenCalled()
    expect(fixture.context.agent.transform).not.toHaveBeenCalled()
    expect(fixture.context.session.hook).not.toHaveBeenCalled()
  })

  it("applies optional tier instructions without injecting routing recursively", async () => {
    const fixture = makeContext({
      ...options,
      tiers: {
        ...options.tiers,
        medium: { model: "p/medium", instructions: "Keep the patch minimal" },
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
})
