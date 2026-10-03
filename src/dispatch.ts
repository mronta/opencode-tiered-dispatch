import { resolve } from "node:path"
import { assertModelsAvailable, type ModelCatalogEntry } from "./catalog.js"
import { DispatchError } from "./errors.js"
import type { EnabledRouterOptions } from "./options.js"
import { buildDelegatedPermissions, type PermissionRule } from "./permissions.js"
import { assertSuccessfulOutcome, extractFinalText } from "./result.js"
import { DEFAULT_TIER_INSTRUCTIONS, TIER_AGENTS, type TierName } from "./tiers.js"

const CLEANUP_DRAIN_TIMEOUT_MS = 1_000

export interface DelegateInput {
  tier: TierName
  description: string
  prompt: string
}

export interface DelegateOutput {
  tier: TierName
  model: string
  sessionID: string
  text: string
}

export interface ToolExecutionContext {
  sessionID: string
  agent: string
  signal: AbortSignal
  progress(update: Record<string, unknown>): Promise<void>
}

export interface SessionRecord {
  id: string
  location: { directory: string }
  subpath?: string
  permissions?: readonly PermissionRule[]
  metadata?: Readonly<Record<string, unknown>>
  outcome?: "succeeded" | "failed" | "interrupted"
}

export interface AgentRecord {
  id: string
  permissions?: readonly PermissionRule[]
}

export interface DispatchRuntime {
  listModels(): Promise<readonly ModelCatalogEntry[]>
  getSession(sessionID: string): Promise<SessionRecord>
  getAgent(agentID: string): Promise<AgentRecord>
  createSession(input: {
    title: string
    agent: string
    model: { providerID: string; id: string; variant?: string }
    location: { directory: string }
    metadata: Readonly<Record<string, string | boolean>>
    permissions: readonly PermissionRule[]
  }): Promise<SessionRecord>
  prompt(sessionID: string, text: string, signal: AbortSignal): Promise<void>
  wait(sessionID: string, signal: AbortSignal): Promise<void>
  context(sessionID: string): Promise<readonly { type: string }[]>
  interrupt(sessionID: string): Promise<void>
}

export interface Dispatcher {
  execute(input: unknown, context: ToolExecutionContext): Promise<{
    content: string
    output: DelegateOutput
    metadata: Omit<DelegateOutput, "text">
  }>
  isOwnedSession(sessionID: string): Promise<boolean>
  cleanup(): Promise<void>
}

export function createDispatcher(
  runtime: DispatchRuntime,
  options: EnabledRouterOptions,
  subagentIDs: ReadonlySet<string>,
): Dispatcher {
  const inFlight = new Set<string>()
  const ownedSessionIDs = new Set<string>()
  const activeOperations = new Set<Promise<unknown>>()
  const cleanupFailures: unknown[] = []
  let closing = false
  let cleanupPromise: Promise<void> | undefined

  const log = (message: string, metadata?: Record<string, unknown>): void => {
    if (options.logging) console.info(`[tiered-dispatch] ${message}`, metadata ?? {})
  }

  const executeOperation = async (rawInput: unknown, context: ToolExecutionContext) => {
    const input = validateInput(rawInput)
    if (closing) throw new DispatchError("Tiered Dispatch is unloading")
    if (subagentIDs.has(context.agent)) {
      throw new DispatchError("Nested tiered dispatch is not allowed from a subagent")
    }
    throwIfAborted(context.signal)

    const tierOptions = options.tiers[input.tier]
    assertModelsAvailable(options, await runtime.listModels(), "dispatch", input.tier)
    if (closing) throw new DispatchError("Tiered Dispatch is unloading")

    const [callerSession, callerAgent] = await Promise.all([
      runtime.getSession(context.sessionID),
      runtime.getAgent(context.agent),
    ])
    throwIfAborted(context.signal)
    if (closing) throw new DispatchError("Tiered Dispatch is unloading")

    const permissions = buildDelegatedPermissions(
      input.tier,
      callerAgent.permissions,
      callerSession.permissions,
    )
    const directory = callerSession.subpath
      ? resolve(callerSession.location.directory, callerSession.subpath)
      : callerSession.location.directory
    const model = {
      ...tierOptions.modelRef,
      ...(tierOptions.variant === undefined ? {} : { variant: tierOptions.variant }),
    }

    if (closing) throw new DispatchError("Tiered Dispatch is unloading")
    await context.progress({ status: `Starting ${input.tier} delegation` })
    if (closing) throw new DispatchError("Tiered Dispatch is unloading")
    const child = await runtime.createSession({
      title: `[${input.tier}] ${input.description.slice(0, 100)}`,
      agent: TIER_AGENTS[input.tier],
      model,
      location: { directory },
      metadata: {
        plugin: "tiered-dispatch",
        parentSessionID: context.sessionID,
        parentAgent: context.agent,
        tier: input.tier,
      },
      permissions,
    })
    inFlight.add(child.id)
    ownedSessionIDs.add(child.id)
    log("delegation started", { tier: input.tier, model: tierOptions.model, sessionID: child.id })

    let interruptionChain = Promise.resolve()
    let primaryFailure: unknown
    let interruptionFailureReported = false
    const interrupt = (): Promise<void> => {
      const attempt = interruptionChain.then(async () => {
        try {
          await runtime.interrupt(child.id)
        } catch (error) {
          cleanupFailures.push(error)
          throw error
        }
      })
      interruptionChain = attempt.catch(() => undefined)
      return attempt
    }
    const requestInterrupt = async (): Promise<void> => {
      try {
        await interrupt()
      } catch (error) {
        interruptionFailureReported = true
        console.error(`[tiered-dispatch] failed to interrupt child ${child.id}`, { error })
      }
    }
    const abort = (): void => {
      void interrupt().catch(() => undefined)
    }
    context.signal.addEventListener("abort", abort, { once: true })
    let finished = false

    try {
      if (closing || context.signal.aborted) {
        await requestInterrupt()
        throwIfAborted(context.signal)
        throw new DispatchError("Tiered Dispatch is unloading")
      }

      await runtime.prompt(child.id, buildChildPrompt(input, tierOptions.instructions), context.signal)
      if (closing || context.signal.aborted) {
        await requestInterrupt()
        throwIfAborted(context.signal)
        throw new DispatchError("Tiered Dispatch is unloading")
      }
      await runtime.wait(child.id, context.signal)
      throwIfAborted(context.signal)
      if (closing) {
        await requestInterrupt()
        throw new DispatchError("Tiered Dispatch is unloading")
      }

      const [completed, messages] = await Promise.all([
        runtime.getSession(child.id),
        runtime.context(child.id),
      ])
      throwIfAborted(context.signal)
      if (closing) {
        await requestInterrupt()
        throw new DispatchError("Tiered Dispatch is unloading")
      }
      assertSuccessfulOutcome(completed.outcome, messages)
      const text = extractFinalText(messages)
      const output: DelegateOutput = {
        tier: input.tier,
        model: formatModel(tierOptions.model, tierOptions.variant),
        sessionID: child.id,
        text,
      }
      log("delegation completed", { tier: input.tier, model: output.model, sessionID: child.id })
      finished = true
      return {
        content: text,
        output,
        metadata: { tier: output.tier, model: output.model, sessionID: output.sessionID },
      }
    } catch (error) {
      if (options.logging) console.error("[tiered-dispatch] delegation failed", {
        error,
        aborted: context.signal.aborted,
        closing,
        childID: child.id,
      })
      if (context.signal.aborted) {
        try {
          throwIfAborted(context.signal)
        } catch (cancellation) {
          primaryFailure = cancellation
          throw cancellation
        }
      }
      primaryFailure = error
      throw error
    } finally {
      context.signal.removeEventListener("abort", abort)
      if (!finished) {
        try {
          await interrupt()
        } catch (error) {
          if (primaryFailure === undefined) throw error
          if (!interruptionFailureReported) {
            console.error(`[tiered-dispatch] failed to interrupt child ${child.id}`, {
              error,
              cause: primaryFailure,
            })
          }
        }
      }
      await interruptionChain
      inFlight.delete(child.id)
      ownedSessionIDs.delete(child.id)
    }
  }

  const execute = (rawInput: unknown, context: ToolExecutionContext): Promise<{
    content: string
    output: DelegateOutput
    metadata: Omit<DelegateOutput, "text">
  }> => {
    if (closing) return Promise.reject(new DispatchError("Tiered Dispatch is unloading"))
    const operation = executeOperation(rawInput, context)
    activeOperations.add(operation)
    void operation.then(
      () => activeOperations.delete(operation),
      () => activeOperations.delete(operation),
    )
    return operation
  }

  const isOwnedSession = async (sessionID: string): Promise<boolean> => {
    if (ownedSessionIDs.has(sessionID)) return true
    const session = await runtime.getSession(sessionID)
    return session.metadata?.plugin === "tiered-dispatch"
  }

  const cleanup = (): Promise<void> => {
    if (cleanupPromise) return cleanupPromise
    cleanupPromise = (async () => {
      closing = true
      while (activeOperations.size > 0 || inFlight.size > 0) {
        const operations = [...activeOperations]
        const sessions = [...inFlight]
        const interruptions = await settleAllWithin(
          sessions.map((sessionID) => runtime.interrupt(sessionID)),
          CLEANUP_DRAIN_TIMEOUT_MS,
        )
        if (interruptions === undefined) {
          cleanupFailures.push(new DispatchError(
            `Timed out while interrupting ${sessions.length} tiered delegation session${sessions.length === 1 ? "" : "s"}`,
          ))
        } else {
          for (const interruption of interruptions) {
            if (interruption.status === "rejected") cleanupFailures.push(interruption.reason)
          }
        }
        const drained = await settleWithin(operations, CLEANUP_DRAIN_TIMEOUT_MS)
        if (!drained) {
          cleanupFailures.push(new DispatchError(
            `Timed out while draining ${inFlight.size} tiered delegation session${inFlight.size === 1 ? "" : "s"}`,
          ))
          break
        }
      }
      if (cleanupFailures.length > 0) {
        throw new AggregateError(cleanupFailures, "Tiered Dispatch could not interrupt every child session")
      }
    })()
    return cleanupPromise
  }

  return { execute, isOwnedSession, cleanup }
}

async function settleWithin(promises: readonly Promise<unknown>[], timeoutMs: number): Promise<boolean> {
  if (promises.length === 0) return true
  let timer: ReturnType<typeof setTimeout> | undefined
  const drained = Promise.allSettled(promises).then(() => true)
  const timedOut = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs)
  })
  const result = await Promise.race([drained, timedOut])
  if (timer !== undefined) clearTimeout(timer)
  return result
}

async function settleAllWithin(
  promises: readonly Promise<unknown>[],
  timeoutMs: number,
): Promise<PromiseSettledResult<unknown>[] | undefined> {
  if (promises.length === 0) return []
  let timer: ReturnType<typeof setTimeout> | undefined
  const settled = Promise.allSettled(promises)
  const timedOut = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), timeoutMs)
  })
  const result = await Promise.race([settled, timedOut])
  if (timer !== undefined) clearTimeout(timer)
  return result
}

function validateInput(input: unknown): DelegateInput {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new DispatchError("Delegation input must be an object")
  }
  const value = input as Record<string, unknown>
  if (!["fast", "medium", "heavy"].includes(value.tier as string)) {
    throw new DispatchError(`Unknown tier: ${String(value.tier)}`)
  }
  const description = typeof value.description === "string" ? value.description.trim() : ""
  const prompt = typeof value.prompt === "string" ? value.prompt.trim() : ""
  if (!description) throw new DispatchError("Delegation description must not be empty")
  if (!prompt) throw new DispatchError("Delegation prompt must not be empty")
  return { tier: value.tier as TierName, description, prompt }
}

function buildChildPrompt(input: DelegateInput, additionalInstructions: string | undefined): string {
  return [
    `You are handling a ${input.tier} tier delegation.`,
    DEFAULT_TIER_INSTRUCTIONS[input.tier],
    ...(additionalInstructions ? [`Additional instructions: ${additionalInstructions}`] : []),
    "",
    "Delegated task:",
    input.prompt,
    "",
    "Return the requested result directly and concisely to the orchestrator.",
  ].join("\n")
}

function formatModel(model: string, variant: string | undefined): string {
  return variant ? `${model}:${variant}` : model
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return
  if (signal.reason instanceof Error) throw signal.reason
  throw new DOMException("Delegation was cancelled", "AbortError")
}
