import { Plugin } from "@opencode/plugin"
import type { AgentEditor } from "@opencode/plugin/promise/agent"
import type { Context } from "@opencode/plugin/promise/plugin"
import { TIER_AGENT_DEFINITIONS } from "./agents.js"
import { assertAgentsAvailable, assertModelsAvailable } from "./catalog.js"
import { tierModelOverrideError } from "./invocation.js"
import { parseOptions, type TierOptions } from "./options.js"
import {
  enforcePlanSessionPermissions,
  findPlanSession,
  PLAN_ORCHESTRATION_TIERS,
  PLAN_READONLY_INSTRUCTION,
  PLAN_READONLY_TOOLS,
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
    const planSessionIDs = new Set<string>()
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
        const planSession = event.sessionID === undefined
          ? undefined
          : await findPlanSession(ctx, event.sessionID, event.agent, planSessionIDs)
        if (planSession?.owned && event.tool !== "subagent" && !PLAN_READONLY_TOOLS.has(event.tool)) {
          throw new Error(`Plan-originated sessions are read-only; tool ${event.tool} is not permitted`)
        }

        if (event.tool !== "subagent") return
        const violation = tierModelOverrideError(event.input)
        if (violation !== undefined) throw new Error(violation)

        if (!planSession?.owned || event.sessionID === undefined) return
        await enforcePlanSessionPermissions(ctx, event.sessionID, planSession.session)

        const input = asRecord(event.input)
        const targetAgent = input?.agent
        const continuedSessionID = input?.sessionID
        if (targetAgent !== undefined) {
          if (typeof targetAgent !== "string" || !PLAN_ORCHESTRATION_TIERS.has(targetAgent)) {
            throw new Error("Plan can orchestrate only the fast, medium, and heavy plugin tiers")
          }
        } else if (typeof continuedSessionID !== "string") {
          throw new Error("Plan subagent calls must target a plugin tier or continue a verified tier session")
        }

        if (typeof continuedSessionID !== "string") return
        const continued = await findPlanSession(ctx, continuedSessionID, undefined, planSessionIDs)
        if (!continued.owned) {
          throw new Error("Plan can continue only a session whose read-only ancestry can be verified")
        }
        if (targetAgent === undefined && !isTierName(continued.session.agent)) {
          throw new Error("Plan can continue only a verified fast, medium, or heavy tier session")
        }
        await enforcePlanSessionPermissions(ctx, continuedSessionID, continued.session)
      }))

      registrations.push(await ctx.session.hook("context", async (event) => {
        let planSession: Awaited<ReturnType<typeof findPlanSession>> | undefined
        try {
          planSession = await findPlanSession(ctx, event.sessionID, event.agent, planSessionIDs)
        } catch (error) {
          if (event.agent === "plan" || isTierName(event.agent)) throw error
          log?.("could not inspect session ancestry; routing guidance omitted", error)
          return
        }
        if (planSession.owned) {
          await enforcePlanSessionPermissions(ctx, event.sessionID, planSession.session)
          if (isTierName(event.agent)) {
            const instructions = options.tiers[event.agent as TierName].instructions
            if (instructions !== undefined) event.system.push({ type: "text", text: instructions })
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
      await rollbackRegistrations(registrations, error)
    }

    log?.("native tier routing enabled")

    return async () => {
      await disposeRegistrations(registrations)
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

async function rollbackRegistrations(registrations: readonly Registration[], setupError: unknown): Promise<never> {
  try {
    await disposeRegistrations(registrations)
  } catch (cleanupError) {
    throw new AggregateError(
      [setupError, cleanupError],
      "Tiered Dispatch setup and rollback failed",
    )
  }
  throw setupError
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
