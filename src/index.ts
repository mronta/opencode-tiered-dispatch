import { Plugin } from "@opencode/plugin"
import type { Context } from "@opencode/plugin/promise/plugin"
import { TIER_AGENT_DEFINITIONS } from "./agents.js"
import { assertAgentsAvailable, assertModelsAvailable } from "./catalog.js"
import { parseOptions } from "./options.js"
import { buildRoutingProtocol } from "./protocol.js"
import { TIER_NAMES, type TierName } from "./tiers.js"

export default Plugin.define({
  id: "tiered-dispatch",

  async setup(ctx) {
    const options = parseOptions(ctx.options)
    if (!options.enabled) {
      const agentRegistration = await ctx.agent.transform((editor) => {
        for (const tier of TIER_NAMES) editor.remove(tier)
      })
      return async () => agentRegistration.dispose()
    }
    const log = options.logging
      ? (...values: unknown[]) => console.error("[tiered-dispatch]", ...values)
      : undefined

    const modelCatalog = await ctx.model.list()
    const models = modelCatalog.data.map(toModelCatalogEntry)

    assertModelsAvailable(options, models)

    const agentRegistration = await ctx.agent.transform((editor) => {
      for (const tier of TIER_NAMES) {
        const definition = TIER_AGENT_DEFINITIONS[tier]
        const configured = options.tiers[tier]
        editor.update(tier, (agent) => {
          agent.description = definition.description
          agent.system = definition.system
          agent.model = {
            providerID: configured.modelRef.providerID,
            id: configured.modelRef.id,
            ...(configured.variant === undefined ? {} : { variant: configured.variant }),
          } as unknown as NonNullable<typeof agent.model>
          agent.permissions = definition.permissions.map((rule) => ({ ...rule }))
        })
      }
    })

    const routingProtocol = buildRoutingProtocol(options)
    let agentCatalogPromise: Promise<readonly ReturnType<typeof toAgentCatalogEntry>[]> | undefined
    const loadAgents = (): Promise<readonly ReturnType<typeof toAgentCatalogEntry>[]> => {
      agentCatalogPromise ??= ctx.agent.list().then((catalog) => {
        const agents = catalog.data.map(toAgentCatalogEntry)
        assertAgentsAvailable(agents, options)
        return agents
      })
      return agentCatalogPromise
    }
    const contextRegistration = await ctx.session.hook("context", async (event) => {
      const agents = await loadAgents()
      const agent = agents.find((candidate) => candidate.id === event.agent)
      if (isTierAgent(event.agent)) {
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
    })

    log?.("native tier routing enabled")

    return async () => {
      await disposeAll([contextRegistration.dispose(), agentRegistration.dispose()])
      log?.("native tier routing disabled")
    }
  },
})

type ModelInfo = Awaited<ReturnType<Context["model"]["list"]>>["data"][number]
type AgentInfo = Awaited<ReturnType<Context["agent"]["list"]>>["data"][number]

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

function isTierAgent(value: string): value is TierName {
  return (TIER_NAMES as readonly string[]).includes(value)
}

async function disposeAll(operations: readonly (Promise<unknown> | void | undefined)[]): Promise<void> {
  const results = await Promise.allSettled(operations)
  const failures = results
    .filter((result): result is PromiseRejectedResult => result.status === "rejected")
    .map((result) => result.reason)
  if (failures.length > 0) {
    throw new AggregateError(failures, "Tiered Dispatch could not dispose every registration")
  }
}
