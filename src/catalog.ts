import { ConfigurationError } from "./errors.js"
import type { EnabledRouterOptions, TierOptions } from "./options.js"
import { assertRequiredTierModel, TIER_NAMES, type TierName } from "./tiers.js"

const FAST_READ_ACTIONS = new Set(["grep", "glob", "webfetch", "websearch", "read"])
const IMPLEMENTATION_ACTIONS = ["edit", "write", "shell"] as const

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
  model?: { providerID: string; id: string; variant?: string } | null
  permissions?: readonly { action: string; resource: string; effect: "allow" | "deny" | "ask" }[]
}

export function assertModelsAvailable(
  options: EnabledRouterOptions,
  models: readonly ModelCatalogEntry[],
): void {
  for (const tier of TIER_NAMES) {
    assertRequiredTierModel(tier, options.tiers[tier].model, options.tiers[tier].variant)
    assertModelAvailable(tier, options.tiers[tier], models)
  }
}

function assertModelAvailable(
  tier: TierName,
  configured: TierOptions,
  models: readonly ModelCatalogEntry[],
): void {
  const model = models.find(
    (candidate) => candidate.providerID === configured.modelRef.providerID && candidate.id === configured.modelRef.id,
  )
  if (!model) {
    throw new ConfigurationError(`Tier ${tier} model ${configured.model} is not in the active model catalog`)
  }
  if (!model.enabled) {
    throw new ConfigurationError(`Tier ${tier} model ${configured.model} is disabled`)
  }
  if (!model.capabilities.tools) {
    throw new ConfigurationError(`Tier ${tier} model ${configured.model} does not support tools`)
  }
  if (configured.variant && !model.variants.some((variant) => variant.id === configured.variant)) {
    const available = model.variants.map((variant) => variant.id).join(", ") || "none"
    throw new ConfigurationError(
      `Tier ${tier} variant ${configured.variant} is unavailable for ${configured.model}; available variants: ${available}`,
    )
  }
}

export function assertAgentsAvailable(
  agents: readonly AgentCatalogEntry[],
  options?: EnabledRouterOptions,
): void {
  for (const agentID of TIER_NAMES) {
    const agent = agents.find((candidate) => candidate.id === agentID)
    assertAgentIdentity(agentID, agent)
    if (!options) continue
    assertAgentModel(agentID, agent, options)
    const permissions = agent.permissions ?? []
    assertNoAgentRecursion(agentID, permissions)
    if (agentID === "fast") assertFastPermissions(permissions)
    else assertImplementationPermissions(agentID, permissions)
  }
}

type AgentPermissionRule = NonNullable<AgentCatalogEntry["permissions"]>[number]

function assertAgentIdentity(agentID: TierName, agent: AgentCatalogEntry | undefined): asserts agent is AgentCatalogEntry {
  if (!agent) throw new ConfigurationError(`Required tier agent ${agentID} is unavailable`)
  if (agent.mode !== "subagent") {
    throw new ConfigurationError(`Required tier agent ${agentID} must be a subagent`)
  }
}

function assertAgentModel(agentID: TierName, agent: AgentCatalogEntry, options: EnabledRouterOptions): void {
  const configured = options.tiers[agentID]
  if (!agent.model) {
    throw new ConfigurationError(`Tier agent ${agentID} has no configured model`)
  }
  if (
    agent.model.providerID !== configured.modelRef.providerID
    || agent.model.id !== configured.modelRef.id
    || normalizedVariant(agent.model.variant, configured.variant) !== configured.variant
  ) {
    throw new ConfigurationError(
      `Tier agent ${agentID} model does not match options.tiers.${agentID}.model`,
    )
  }
}

function assertNoAgentRecursion(agentID: TierName, permissions: readonly AgentPermissionRule[]): void {
  const subagentRule = effectivePermission(permissions, "subagent")
  if (subagentRule?.effect !== "deny") {
    throw new ConfigurationError(`Tier agent ${agentID} must deny the subagent permission`)
  }
  const subagentDenyIndex = permissions.findLastIndex(
    (rule) => rule.resource === "*"
      && rule.effect === "deny"
      && (rule.action === "subagent" || rule.action === "*"),
  )
  const laterRecursionRules = permissions
    .slice(subagentDenyIndex + 1)
    .filter((rule) => rule.effect !== "deny" && (rule.action === "subagent" || rule.action === "*"))
  if (laterRecursionRules.length > 0) {
    throw new ConfigurationError(`Tier agent ${agentID} has a later rule that can enable subagent recursion`)
  }
}

function assertFastPermissions(permissions: readonly AgentPermissionRule[]): void {
  const denyAllIndex = permissions.findLastIndex(
    (rule) => rule.action === "*" && rule.resource === "*" && rule.effect === "deny",
  )
  if (denyAllIndex < 0) {
    throw new ConfigurationError("Tier agent fast must have a deny-all rule before read-only allows")
  }
  const unsafeAllows = permissions
    .slice(denyAllIndex + 1)
    .filter((rule) => rule.effect !== "deny" && !FAST_READ_ACTIONS.has(rule.action))
  if (unsafeAllows.length > 0) {
    throw new ConfigurationError("Tier agent fast has an allow rule for a non-read action")
  }
}

function assertImplementationPermissions(
  agentID: Exclude<TierName, "fast">,
  permissions: readonly AgentPermissionRule[],
): void {
  for (const action of IMPLEMENTATION_ACTIONS) {
    if (effectivePermission(permissions, action)?.effect !== "allow") {
      throw new ConfigurationError(`Tier agent ${agentID} must allow the ${action} permission`)
    }
  }
}

function normalizedVariant(actual: string | undefined, configured: string | undefined): string | undefined {
  return configured === undefined && actual === "default" ? undefined : actual
}

function effectivePermission(
  permissions: readonly AgentPermissionRule[],
  action: string,
): AgentPermissionRule | undefined {
  return [...permissions].reverse().find(
    (rule) => rule.resource === "*" && (rule.action === action || rule.action === "*"),
  )
}
