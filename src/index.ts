import { Plugin } from "@opencode/plugin"
import type { AgentEditor } from "@opencode/plugin/promise/agent"
import type { Context } from "@opencode/plugin/promise/plugin"
import { TIER_AGENT_DEFINITIONS } from "./agents.js"
import { assertAgentsAvailable, assertModelsAvailable } from "./catalog.js"
import { planMutatingTierError, tierModelOverrideError } from "./invocation.js"
import { parseOptions, type TierOptions } from "./options.js"
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
        const plan = editor.get("plan")
        if (plan !== undefined) appendPlanTierDenies(plan)
      }))

      registrations.push(await ctx.tool.hook("execute.before", (event) => {
        if (event.tool !== "subagent") return
        const planViolation = planMutatingTierError(event.agent, event.input)
        if (planViolation !== undefined) throw new Error(planViolation)
        const violation = tierModelOverrideError(event.input)
        if (violation !== undefined) throw new Error(violation)
      }))

      registrations.push(await ctx.session.hook("context", async (event) => {
        if (event.agent === "plan") return
        const agents = await loadAgents()
        const agent = agents.find((candidate) => candidate.id === event.agent)
        if (isTierName(event.agent)) {
          const instructions = options.tiers[event.agent as TierName].instructions
          if (instructions !== undefined) event.system.push({ type: "text", text: instructions })
          return
        }
        let session: Awaited<ReturnType<Context["session"]["get"]>>
        try {
          session = await ctx.session.get({ sessionID: event.sessionID })
        } catch (error) {
          log?.("could not inspect session ancestry; routing guidance omitted", error)
          return
        }
        // Fail closed when the current agent cannot be classified. Injecting an
        // orchestration protocol into an unknown child is worse than omitting it.
        if (!agent || session.parentID !== undefined || (agent.mode !== "primary" && agent.mode !== "all")) {
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

const PLAN_BLOCKED_TIERS = ["medium", "heavy"] as const

function appendPlanTierDenies(agent: EditableAgent): void {
  const permissions = agent.permissions ?? (agent.permissions = [])
  for (const tier of PLAN_BLOCKED_TIERS) {
    const lastRule = [...permissions].reverse().find(
      (rule) => rule.action === "subagent" && rule.resource === tier,
    )
    if (lastRule?.effect === "deny") continue
    permissions.push({ action: "subagent", resource: tier, effect: "deny" })
  }
}

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
