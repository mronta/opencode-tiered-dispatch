import { Plugin } from "@opencode/plugin"
import type { AgentEditor } from "@opencode/plugin/promise/agent"
import type { Context } from "@opencode/plugin/promise/plugin"
import { TIER_AGENT_DEFINITIONS } from "./agents.js"
import { assertAgentsAvailable, assertModelsAvailable } from "./catalog.js"
import { tierModelOverrideError } from "./invocation.js"
import { parseOptions, type TierOptions } from "./options.js"
import {
  PLAN_ORCHESTRATION_TIERS,
  PLAN_READONLY_INSTRUCTION,
  PLAN_READONLY_TOOLS,
  StatefulPlanSafety,
} from "./plan-safety.js"
import { buildRoutingProtocol } from "./protocol.js"
import { isTierName, TIER_NAMES, type TierName } from "./tiers.js"

interface Registration {
  dispose: () => Promise<void>
}

export default Plugin.define({
  id: "tiered-dispatch",

  async setup(ctx) {
    const options = parseOptions(ctx.options)
    if (!options.enabled) return undefined
    const log = options.logging
      ? (...values: unknown[]) => console.error("[tiered-dispatch]", ...values)
      : undefined

    const modelCatalog = await ctx.model.list()
    const models = modelCatalog.data.map(toModelCatalogEntry)

    assertModelsAvailable(options, models)

    const routingProtocol = buildRoutingProtocol(options)
    const planSafety = new StatefulPlanSafety(ctx)
    const loadAgents = async (): Promise<readonly ReturnType<typeof toAgentCatalogEntry>[]> => {
      const catalog = await ctx.agent.list()
      const agents = catalog.data.map(toAgentCatalogEntry)
      assertAgentsAvailable(agents, options)
      return agents
    }
    const registrations: Registration[] = []
    try {
      registrations.push(await ctx.agent.transform((editor) => {
        for (const tier of TIER_NAMES) {
          const definition = TIER_AGENT_DEFINITIONS[tier]
          const configured = options.tiers[tier]
          editor.update(tier, (agent) => {
            agent.mode = "subagent"
            if ("name" in agent) agent.name = tier as unknown as typeof agent.name
            agent.hidden = false
            agent.request = { settings: {}, headers: {}, body: {} }
            delete agent.steps
            agent.description = definition.description
            agent.system = definition.system
            agent.model = toAgentModel(configured)
            agent.permissions = definition.permissions.map((rule) => ({ ...rule }))
          })
        }
      }))

      registrations.push(await ctx.tool.hook("execute.before", async (event) => {
        let planSession: Awaited<ReturnType<StatefulPlanSafety["inspect"]>> | undefined
        if (event.sessionID !== undefined) {
          try {
            planSession = await planSafety.inspect(event.sessionID, event.agent)
          } catch (error) {
            if (event.agent === "plan" || isTierName(event.agent)) throw error
            log?.("could not inspect session ancestry; normal tool execution continues", error)
          }
        }
        if (planSession?.owned && event.tool !== "subagent" && !PLAN_READONLY_TOOLS.has(event.tool)) {
          throw new Error(`Plan-originated sessions are read-only; tool ${event.tool} is not permitted`)
        }

        if (event.tool !== "subagent") return
        const violation = tierModelOverrideError(event.input)
        if (violation !== undefined) throw new Error(violation)

        const input = asRecord(event.input)
        const targetAgent = input?.agent
        const continuedSessionID = input?.sessionID
        if (planSession?.owned && event.sessionID !== undefined) {
          if (targetAgent !== undefined) {
            if (typeof targetAgent !== "string" || !PLAN_ORCHESTRATION_TIERS.has(targetAgent)) {
              throw new Error("Plan can orchestrate only the fast, medium, and heavy plugin tiers")
            }
          } else if (typeof continuedSessionID !== "string") {
            throw new Error("Plan subagent calls must target a plugin tier or continue a verified tier session")
          }

          if (typeof continuedSessionID === "string") {
            if (continuedSessionID === event.sessionID) {
              throw new Error("Plan cannot continue its own session")
            }
            const continued = await planSafety.inspect(continuedSessionID)
            if (!continued.owned) {
              throw new Error("Plan can continue only a session whose read-only ancestry can be verified")
            }
            if (
              targetAgent === undefined
              && !isTierName(continued.effectiveAgent ?? continued.session.agent)
            ) {
              throw new Error("Plan can continue only a verified fast, medium, or heavy tier session")
            }
          }

          // The root marker is the inheritance handoff. It contains no real
          // tool deny rule, so keeping it on the root does not poison the
          // host's pre-context tool snapshot. If an external edit removed it,
          // do not overwrite that edit here: the child still becomes owned by
          // the current Plan ancestry when its context is inspected.
          return
        }

        // Native subagent calls made by ordinary sessions must use the native
        // agent input. Continuation-only calls are reserved for verified Plan
        // orchestration above.
        if (typeof targetAgent !== "string" || targetAgent.trim() === "") {
          throw new Error("Native subagent calls must provide input.agent")
        }
      }))

      registrations.push(await ctx.session.hook("prompt", async (event) => {
        await planSafety.preflight(event.sessionID)
      }))

      registrations.push(await ctx.session.hook("context", async (event) => {
        let planSession: Awaited<ReturnType<StatefulPlanSafety["inspect"]>> | undefined
        try {
          planSession = await planSafety.inspect(event.sessionID, event.agent)
        } catch (error) {
          if (event.agent === "plan" || isTierName(event.agent)) throw error
          log?.("could not inspect session ancestry; routing guidance omitted", error)
          return
        }
        if (planSession.owned) {
          for (const tool of Object.keys(event.tools)) {
            if (tool !== "subagent" && !PLAN_READONLY_TOOLS.has(tool)) delete event.tools[tool]
          }
          if (planSession.kind === "descendant") {
            if (isTierName(event.agent)) {
              const instructions = options.tiers[event.agent as TierName].instructions
              if (instructions !== undefined) event.system.push({ type: "text", text: instructions })
            }
            event.system.push({ type: "text", text: PLAN_READONLY_INSTRUCTION })
          }
          return
        }
        const agents = await loadAgents()
        const agent = agents.find((candidate) => candidate.id === event.agent)
        if (isTierName(event.agent)) {
          const instructions = options.tiers[event.agent as TierName].instructions
          if (instructions !== undefined) event.system.push({ type: "text", text: instructions })
          return
        }
        // Fail closed when the current agent cannot be classified. Injecting an
        // orchestration protocol into an unknown child is worse than omitting it.
        if (
          !agent
          || planSession.session.parentID !== undefined
          || (agent.mode !== "primary" && agent.mode !== "all")
        ) {
          return
        }
        event.system.push({ type: "text", text: routingProtocol })
      }))
    } catch (error) {
      await rollbackRegistrations(registrations, planSafety, error)
    }

    log?.("native tier routing enabled")

    return async () => {
      await disposePlugin(registrations, planSafety)
      log?.("native tier routing disabled")
    }
  },
})

type ModelInfo = Awaited<ReturnType<Context["model"]["list"]>>["data"][number]
type AgentInfo = Awaited<ReturnType<Context["agent"]["list"]>>["data"][number]
type EditableAgent = Parameters<Parameters<AgentEditor["update"]>[1]>[0]
type AgentModel = NonNullable<EditableAgent["model"]>

function toAgentModel(configured: TierOptions): AgentModel {
  const model = {
    providerID: configured.modelRef.providerID as unknown as AgentModel["providerID"],
    id: configured.modelRef.id as unknown as AgentModel["id"],
  }
  if (configured.variant === undefined) return model
  return { ...model, variant: configured.variant as unknown as NonNullable<AgentModel["variant"]> }
}

function toModelCatalogEntry(model: ModelInfo) {
  return {
    providerID: model.providerID,
    id: model.id,
    enabled: model.enabled,
    capabilities: { tools: model.capabilities.tools },
    variants: model.variants.map((variant) => ({ id: variant.id })),
  }
}

function toAgentCatalogEntry(agent: AgentInfo) {
  return {
    id: agent.id,
    mode: agent.mode,
    ...(agent.model === undefined
      ? {}
      : {
        model: agent.model === null
          ? null
          : {
            providerID: agent.model.providerID,
            id: agent.model.id,
            ...(agent.model.variant === undefined ? {} : { variant: agent.model.variant }),
          },
      }),
    permissions: agent.permissions,
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

async function rollbackRegistrations(
  registrations: readonly Registration[],
  planSafety: StatefulPlanSafety,
  setupError: unknown,
): Promise<never> {
  try {
    await disposePlugin(registrations, planSafety)
  } catch (cleanupError) {
    throw new AggregateError(
      [setupError, cleanupError],
      "Tiered Dispatch setup and rollback failed",
    )
  }
  throw setupError
}

async function disposePlugin(
  registrations: readonly Registration[],
  planSafety: StatefulPlanSafety,
): Promise<void> {
  const failures: unknown[] = []
  try {
    // Unregister hooks first. A still-live hook must not race a permission
    // restoration and observe a half-reconciled session.
    await disposeRegistrations(registrations)
  } catch (error) {
    failures.push(error)
  }
  try {
    await planSafety.dispose()
  } catch (error) {
    failures.push(error)
  }
  if (failures.length === 0) return
  if (failures.length === 1) throw failures[0]
  throw new AggregateError(failures, "Tiered Dispatch cleanup failed")
}

async function disposeRegistrations(registrations: readonly Registration[]): Promise<void> {
  const failures: unknown[] = []
  for (const registration of [...registrations].reverse()) {
    try {
      await registration.dispose()
    } catch (error) {
      failures.push(error)
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, "Tiered Dispatch could not dispose every registration")
  }
}
