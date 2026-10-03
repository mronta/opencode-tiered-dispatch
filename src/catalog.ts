import { ConfigurationError, DispatchError } from "./errors.js"
import type { EnabledRouterOptions, TierOptions } from "./options.js"
import { TIER_AGENTS, TIER_NAMES, type TierName } from "./tiers.js"

export interface ModelCatalogEntry {
  providerID: string
  id: string
  enabled: boolean
  capabilities: { tools: boolean }
  variants: readonly { id: string }[]
}

export interface AgentCatalogEntry {
  id: string
  mode?: string
  permissions?: readonly { action: string; resource: string; effect: "allow" | "deny" | "ask" }[]
}

export function assertModelsAvailable(
  options: EnabledRouterOptions,
  models: readonly ModelCatalogEntry[],
  phase: "setup" | "dispatch" = "setup",
  onlyTier?: TierName,
): void {
  const tiers = onlyTier === undefined ? TIER_NAMES : [onlyTier]
  for (const tier of tiers) assertModelAvailable(tier, options.tiers[tier], models, phase)
}

function assertModelAvailable(
  tier: TierName,
  configured: TierOptions,
  models: readonly ModelCatalogEntry[],
  phase: "setup" | "dispatch",
): void {
  const ErrorType = phase === "setup" ? ConfigurationError : DispatchError
  const model = models.find(
    (candidate) => candidate.providerID === configured.modelRef.providerID && candidate.id === configured.modelRef.id,
  )
  if (!model) {
    throw new ErrorType(`Tier ${tier} model ${configured.model} is not in the active model catalog`)
  }
  if (!model.enabled) {
    throw new ErrorType(`Tier ${tier} model ${configured.model} is disabled`)
  }
  if (!model.capabilities.tools) {
    throw new ErrorType(`Tier ${tier} model ${configured.model} does not support tools`)
  }
  if (configured.variant && !model.variants.some((variant) => variant.id === configured.variant)) {
    const available = model.variants.map((variant) => variant.id).join(", ") || "none"
    throw new ErrorType(
      `Tier ${tier} variant ${configured.variant} is unavailable for ${configured.model}; available variants: ${available}`,
    )
  }
}

export function assertAgentsAvailable(agents: readonly AgentCatalogEntry[]): Set<string> {
  const subagents = new Set(agents.filter((agent) => agent.mode === "subagent").map((agent) => agent.id))
  for (const agentID of new Set(Object.values(TIER_AGENTS))) {
    const agent = agents.find((candidate) => candidate.id === agentID)
    if (!agent) throw new ConfigurationError(`Required built-in agent ${agentID} is unavailable`)
    if (agent.mode !== "subagent") {
      throw new ConfigurationError(`Required built-in agent ${agentID} must be a subagent`)
    }
  }
  return subagents
}
