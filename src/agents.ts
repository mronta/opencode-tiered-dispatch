import type { TierName } from "./tiers.js"

export interface AgentPermissionRule {
  action: string
  resource: string
  effect: "allow" | "deny" | "ask"
}

export interface TierAgentDefinition {
  description: string
  system: string
  permissions: readonly AgentPermissionRule[]
}

export const TIER_AGENT_DEFINITIONS: Record<TierName, TierAgentDefinition> = {
  fast: {
    description: "Focused read-only exploration and research",
    system: "Read-only investigator: batch related discovery; stop when the ask is satisfied. Do not repeat broad exploration. Return findings with file:line evidence, relevant paths, verification hints and unresolved questions for the next phase. If blocked, return NEED MORE: with specific missing evidence. Do not edit or run mutating commands. Do not delegate unless the Plan-origin read-only instruction explicitly permits tier orchestration; never self-escalate.",
    permissions: [
      { action: "*", resource: "*", effect: "deny" },
      { action: "grep", resource: "*", effect: "allow" },
      { action: "glob", resource: "*", effect: "allow" },
      { action: "webfetch", resource: "*", effect: "allow" },
      { action: "websearch", resource: "*", effect: "allow" },
      { action: "read", resource: "*", effect: "allow" },
      { action: "read", resource: "*.env", effect: "ask" },
      { action: "read", resource: "*.env.*", effect: "ask" },
      { action: "read", resource: "*.env.example", effect: "allow" },
      { action: "subagent", resource: "*", effect: "deny" },
    ],
  },
  medium: {
    description: "Implementation, refactoring, tests, and ordinary fixes",
    system: "Implementation specialist: supplied findings; match patterns; edit/run verification locally. Supplied paths scope; optional/conventional paths not handed off: confirm via glob/search before read; never probe guessed paths. NEED CONTEXT: focused request; blocked by repeated failures→attempts/blockers; report changes, decisions, verification. Do not delegate unless the Plan-origin read-only instruction explicitly permits tier orchestration; never self-escalate.",
    permissions: implementationPermissions(),
  },
  heavy: {
    description: "Architecture, security, difficult debugging, and high-risk reasoning",
    system: "Architecture/security/difficult-debugging specialist: analyze supplied evidence; targeted reads are allowed. Missing evidence→return SCOPE GROWTH: with a focused discovery request, not broad reconnaissance. Return trade-offs and a concrete recommendation; implementation only when requested, with verification. Do not delegate unless the Plan-origin read-only instruction explicitly permits tier orchestration; never self-escalate.",
    permissions: implementationPermissions(),
  },
}

function implementationPermissions(): readonly AgentPermissionRule[] {
  return [
    { action: "*", resource: "*", effect: "allow" },
    { action: "external_directory", resource: "*", effect: "ask" },
    { action: "read", resource: "*.env", effect: "ask" },
    { action: "read", resource: "*.env.*", effect: "ask" },
    { action: "read", resource: "*.env.example", effect: "allow" },
    { action: "question", resource: "*", effect: "deny" },
    { action: "subagent", resource: "*", effect: "deny" },
  ]
}
