import { describe, expect, it, vi } from "vitest"
import { createDispatcher, type DispatchRuntime } from "../src/dispatch.js"
import { parseOptions } from "../src/options.js"

const parsed = parseOptions({
  tiers: {
    fast: { model: "p/fast", variant: "low" },
    medium: { model: "p/medium" },
    heavy: { model: "p/heavy" },
  },
})
if (!parsed.enabled) throw new Error("test setup")

function makeRuntime(): DispatchRuntime {
  return {
    listModels: vi.fn(async () => [
      { providerID: "p", id: "fast", enabled: true, capabilities: { tools: true }, variants: [{ id: "low" }] },
      { providerID: "p", id: "medium", enabled: true, capabilities: { tools: true }, variants: [] },
      { providerID: "p", id: "heavy", enabled: true, capabilities: { tools: true }, variants: [] },
    ]),
    getSession: vi.fn(async (id) => id === "root"
      ? { id, location: { directory: "/workspace" }, permissions: [{ action: "edit", resource: "*", effect: "deny" as const }] }
      : { id, location: { directory: "/workspace" }, outcome: "succeeded" as const }),
    getAgent: vi.fn(async (id) => ({ id, permissions: [{ action: "*", resource: "*", effect: "allow" as const }] })),
    createSession: vi.fn(async (input) => ({ id: "ses_child", location: input.location })),
    prompt: vi.fn(async () => undefined),
    wait: vi.fn(async () => undefined),
    context: vi.fn(async () => [
      { type: "assistant", content: [{ type: "text", text: "delegated answer" }] },
      { type: "idle", outcome: "succeeded" },
    ]),
    interrupt: vi.fn(async () => undefined),
  }
}

const toolContext = () => ({
  sessionID: "root",
  agent: "build",
  signal: new AbortController().signal,
  progress: vi.fn(async () => undefined),
})

describe("dispatcher", () => {
  it("creates the exact tier session and returns structured output", async () => {
    const runtime = makeRuntime()
    const dispatcher = createDispatcher(runtime, parsed, new Set(["explore", "general"]))
    const result = await dispatcher.execute(
      { tier: "fast", description: "Find auth", prompt: "Locate auth handling" },
      toolContext(),
    )

    expect(runtime.createSession).toHaveBeenCalledWith(expect.objectContaining({
      agent: "explore",
      model: { providerID: "p", id: "fast", variant: "low" },
      location: { directory: "/workspace" },
      metadata: {
        plugin: "tiered-dispatch",
        parentSessionID: "root",
        parentAgent: "build",
        tier: "fast",
      },
    }))
    expect(result.output).toEqual({
      tier: "fast",
      model: "p/fast:low",
      sessionID: "ses_child",
      text: "delegated answer",
    })
  })

  it("preserves caller edit denial for medium", async () => {
    const runtime = makeRuntime()
    const dispatcher = createDispatcher(runtime, parsed, new Set(["explore", "general"]))
    await dispatcher.execute(
      { tier: "medium", description: "Implement", prompt: "Implement it" },
      toolContext(),
    )
    const call = vi.mocked(runtime.createSession).mock.calls[0]![0]
    expect(call.permissions.findLast((rule) => rule.action === "edit")?.effect).toBe("deny")
  })

  it("rejects nested dispatch", async () => {
    const dispatcher = createDispatcher(makeRuntime(), parsed, new Set(["explore", "general"]))
    await expect(dispatcher.execute(
      { tier: "fast", description: "nested", prompt: "nested" },
      { ...toolContext(), agent: "general" },
    )).rejects.toThrow(/Nested/)
  })

  it("interrupts a child when cancelled", async () => {
    const runtime = makeRuntime()
    const controller = new AbortController()
    vi.mocked(runtime.wait).mockImplementation(async () => {
      controller.abort(new DOMException("cancelled", "AbortError"))
    })
    const dispatcher = createDispatcher(runtime, parsed, new Set(["explore", "general"]))
    await expect(dispatcher.execute(
      { tier: "heavy", description: "Analyze", prompt: "Analyze" },
      { ...toolContext(), signal: controller.signal },
    )).rejects.toThrow(/cancelled/)
    expect(runtime.interrupt).toHaveBeenCalledWith("ses_child")
  })
})
