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

function deferred<T>(): {
  promise: Promise<T>
  resolve(value: T): void
  reject(error: unknown): void
} {
  let resolvePromise: (value: T) => void = () => undefined
  let rejectPromise: (error: unknown) => void = () => undefined
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve
    rejectPromise = reject
  })
  return { promise, resolve: resolvePromise, reject: rejectPromise }
}

async function flushAsyncWork(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve))
}

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

  it("does not retain completed child ownership in memory", async () => {
    const runtime = makeRuntime()
    vi.mocked(runtime.getSession).mockImplementation(async (id) => id === "root"
      ? { id, location: { directory: "/workspace" }, permissions: [] }
      : {
        id,
        location: { directory: "/workspace" },
        metadata: { plugin: "tiered-dispatch" },
        outcome: "succeeded" as const,
      })
    const dispatcher = createDispatcher(runtime, parsed, new Set(["explore", "general"]))

    await dispatcher.execute(
      { tier: "fast", description: "Find auth", prompt: "Locate auth handling" },
      toolContext(),
    )
    vi.mocked(runtime.getSession).mockClear()

    expect(await dispatcher.isOwnedSession("ses_child")).toBe(true)
    expect(await dispatcher.isOwnedSession("ses_child")).toBe(true)
    expect(runtime.getSession).toHaveBeenCalledTimes(2)
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

  it("waits for cancellation interruption before rejecting", async () => {
    const runtime = makeRuntime()
    const controller = new AbortController()
    const interruption = deferred<void>()
    vi.mocked(runtime.wait).mockImplementation(async () => {
      controller.abort(new DOMException("cancelled", "AbortError"))
    })
    vi.mocked(runtime.interrupt).mockReturnValue(interruption.promise)
    const dispatcher = createDispatcher(runtime, parsed, new Set(["explore", "general"]))

    let settled = false
    const execution = dispatcher.execute(
      { tier: "heavy", description: "Analyze", prompt: "Analyze" },
      { ...toolContext(), signal: controller.signal },
    ).finally(() => { settled = true })
    await flushAsyncWork()
    expect(runtime.interrupt).toHaveBeenCalledWith("ses_child")
    expect(settled).toBe(false)

    interruption.resolve()
    await expect(execution).rejects.toThrow(/cancelled/)
  })

  it("interrupts again after a cancelled prompt is admitted", async () => {
    const runtime = makeRuntime()
    const controller = new AbortController()
    const promptGate = deferred<void>()
    vi.mocked(runtime.prompt).mockReturnValue(promptGate.promise)
    const dispatcher = createDispatcher(runtime, parsed, new Set(["explore", "general"]))

    const execution = dispatcher.execute(
      { tier: "medium", description: "Implement", prompt: "Implement" },
      { ...toolContext(), signal: controller.signal },
    )
    await flushAsyncWork()
    controller.abort(new DOMException("cancelled", "AbortError"))
    await flushAsyncWork()
    expect(runtime.interrupt).toHaveBeenCalledOnce()

    promptGate.resolve()
    await expect(execution).rejects.toThrow(/cancelled/)
    expect(vi.mocked(runtime.interrupt).mock.calls.length).toBeGreaterThanOrEqual(2)
  })

  it("rejects when cancellation arrives while collecting the child result", async () => {
    const runtime = makeRuntime()
    const controller = new AbortController()
    const contextGate = deferred<readonly { type: string }[]>()
    vi.mocked(runtime.context).mockReturnValue(contextGate.promise)
    const dispatcher = createDispatcher(runtime, parsed, new Set(["explore", "general"]))

    const execution = dispatcher.execute(
      { tier: "medium", description: "Inspect", prompt: "Inspect" },
      { ...toolContext(), signal: controller.signal },
    )
    await flushAsyncWork()
    expect(runtime.context).toHaveBeenCalledWith("ses_child")
    controller.abort(new DOMException("cancelled", "AbortError"))
    contextGate.resolve([{ type: "assistant" }])

    await expect(execution).rejects.toThrow(/cancelled/)
    expect(runtime.interrupt).toHaveBeenCalledWith("ses_child")
  })

  it("interrupts a child when prompting fails", async () => {
    const runtime = makeRuntime()
    vi.mocked(runtime.prompt).mockRejectedValue(new Error("prompt failed"))
    const dispatcher = createDispatcher(runtime, parsed, new Set(["explore", "general"]))

    await expect(dispatcher.execute(
      { tier: "medium", description: "Implement", prompt: "Implement" },
      toolContext(),
    )).rejects.toThrow("prompt failed")
    expect(runtime.interrupt).toHaveBeenCalledWith("ses_child")
  })

  it("surfaces an interruption failure during unload", async () => {
    const runtime = makeRuntime()
    const waiting = deferred<void>()
    vi.mocked(runtime.wait).mockReturnValue(waiting.promise)
    vi.mocked(runtime.interrupt).mockImplementation(async () => {
      waiting.resolve()
      throw new Error("interrupt unavailable")
    })
    const dispatcher = createDispatcher(runtime, parsed, new Set(["explore", "general"]))

    const execution = dispatcher.execute(
      { tier: "heavy", description: "Analyze", prompt: "Analyze" },
      toolContext(),
    )
    await flushAsyncWork()
    const cleanup = dispatcher.cleanup()
    await expect(execution).rejects.toThrow(/unloading/)
    await expect(cleanup).rejects.toThrow(/could not interrupt/)
  })

  it("bounds cleanup when an interrupted child never settles", async () => {
    const runtime = makeRuntime()
    vi.mocked(runtime.wait).mockReturnValue(new Promise<void>(() => undefined))
    vi.mocked(runtime.interrupt).mockRejectedValue(new Error("interrupt unavailable"))
    const dispatcher = createDispatcher(runtime, parsed, new Set(["explore", "general"]))

    void dispatcher.execute(
      { tier: "heavy", description: "Hang", prompt: "Hang" },
      toolContext(),
    )
    await flushAsyncWork()

    await expect(dispatcher.cleanup()).rejects.toThrow(/could not interrupt/)
    expect(runtime.interrupt).toHaveBeenCalled()
  })

  it("keeps concurrent tier results and child sessions isolated", async () => {
    const runtime = makeRuntime()
    let nextID = 0
    vi.mocked(runtime.createSession).mockImplementation(async (input) => ({
      id: `ses_child_${++nextID}`,
      location: input.location,
    }))
    vi.mocked(runtime.context).mockImplementation(async (sessionID) => [
      { type: "assistant", content: [{ type: "text", text: `answer for ${sessionID}` }] },
      { type: "idle", outcome: "succeeded" },
    ])
    const dispatcher = createDispatcher(runtime, parsed, new Set(["explore", "general"]))

    const [fast, heavy] = await Promise.all([
      dispatcher.execute({ tier: "fast", description: "Find", prompt: "Find" }, toolContext()),
      dispatcher.execute({ tier: "heavy", description: "Reason", prompt: "Reason" }, toolContext()),
    ])

    expect(fast.output).toMatchObject({ tier: "fast", model: "p/fast:low", sessionID: "ses_child_1", text: "answer for ses_child_1" })
    expect(heavy.output).toMatchObject({ tier: "heavy", model: "p/heavy", sessionID: "ses_child_2", text: "answer for ses_child_2" })
    expect(runtime.createSession).toHaveBeenCalledTimes(2)
    expect(runtime.createSession).toHaveBeenNthCalledWith(1, expect.objectContaining({ agent: "explore", model: { providerID: "p", id: "fast", variant: "low" } }))
    expect(runtime.createSession).toHaveBeenNthCalledWith(2, expect.objectContaining({ agent: "general", model: { providerID: "p", id: "heavy" } }))
  })

  it("surfaces provider error details without falling back", async () => {
    const runtime = makeRuntime()
    vi.mocked(runtime.getSession).mockImplementation(async (id) => id === "root"
      ? { id, location: { directory: "/workspace" }, permissions: [] }
      : { id, location: { directory: "/workspace" }, outcome: "failed" as const })
    const providerError = { type: "rate_limit", message: "provider refused", status: 429 }
    vi.mocked(runtime.context).mockResolvedValue([
      { type: "assistant", content: [], error: providerError },
    ] as never)
    const dispatcher = createDispatcher(runtime, parsed, new Set(["explore", "general"]))

    await expect(dispatcher.execute(
      { tier: "fast", description: "Fail", prompt: "Trigger failure" },
      toolContext(),
    )).rejects.toBe(providerError)
    expect(runtime.createSession).toHaveBeenCalledOnce()
    expect(runtime.createSession).toHaveBeenCalledWith(expect.objectContaining({ agent: "explore" }))
  })

  it("drains a child that is created while cleanup is waiting", async () => {
    const runtime = makeRuntime()
    const creation = deferred<{ id: string; location: { directory: string } }>()
    vi.mocked(runtime.createSession).mockReturnValue(creation.promise)
    const dispatcher = createDispatcher(runtime, parsed, new Set(["explore", "general"]))

    const execution = dispatcher.execute(
      { tier: "medium", description: "Implement", prompt: "Implement it" },
      toolContext(),
    )
    await flushAsyncWork()
    expect(runtime.createSession).toHaveBeenCalledOnce()

    const cleanup = dispatcher.cleanup()
    creation.resolve({ id: "ses_late", location: { directory: "/workspace" } })

    await expect(execution).rejects.toThrow(/unloading/)
    await cleanup
    expect(runtime.interrupt).toHaveBeenCalledWith("ses_late")
  })

  it("waits for an active child to stop before cleanup resolves", async () => {
    const runtime = makeRuntime()
    const waiting = deferred<void>()
    vi.mocked(runtime.wait).mockReturnValue(waiting.promise)
    vi.mocked(runtime.interrupt).mockImplementation(async () => {
      waiting.resolve()
    })
    const dispatcher = createDispatcher(runtime, parsed, new Set(["explore", "general"]))

    const execution = dispatcher.execute(
      { tier: "heavy", description: "Analyze", prompt: "Analyze" },
      toolContext(),
    )
    await flushAsyncWork()
    expect(runtime.wait).toHaveBeenCalledWith("ses_child", expect.any(AbortSignal))

    const cleanup = dispatcher.cleanup()
    await expect(execution).rejects.toThrow(/unloading/)
    await cleanup
    expect(runtime.interrupt).toHaveBeenCalledWith("ses_child")
  })

  it("interrupts a child created after the caller is cancelled", async () => {
    const runtime = makeRuntime()
    const creation = deferred<{ id: string; location: { directory: string } }>()
    vi.mocked(runtime.createSession).mockReturnValue(creation.promise)
    const controller = new AbortController()
    const dispatcher = createDispatcher(runtime, parsed, new Set(["explore", "general"]))

    const execution = dispatcher.execute(
      { tier: "fast", description: "Find", prompt: "Find it" },
      { ...toolContext(), signal: controller.signal },
    )
    await flushAsyncWork()
    controller.abort(new DOMException("cancelled", "AbortError"))
    creation.resolve({ id: "ses_cancelled", location: { directory: "/workspace" } })

    await expect(execution).rejects.toThrow(/cancelled/)
    expect(runtime.interrupt).toHaveBeenCalledWith("ses_cancelled")
  })

  it("makes cleanup idempotent and rejects new work after unload", async () => {
    const runtime = makeRuntime()
    const dispatcher = createDispatcher(runtime, parsed, new Set(["explore", "general"]))

    const first = dispatcher.cleanup()
    const second = dispatcher.cleanup()
    expect(second).toBe(first)
    await Promise.all([first, second])
    await expect(dispatcher.execute(
      { tier: "fast", description: "late", prompt: "late" },
      toolContext(),
    )).rejects.toThrow(/unloading/)
    expect(runtime.createSession).not.toHaveBeenCalled()
  })
})
