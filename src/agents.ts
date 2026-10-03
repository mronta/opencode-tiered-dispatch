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
    system: "Act as a focused, read-only investigator. Search only as far as needed. Return concrete findings with file paths, line references, and a concise conclusion. Do not edit files, run mutating commands, or delegate further.",
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
    system: "Act as an implementation specialist. Match existing project patterns, make the requested changes, and run targeted verification. Report files changed, key decisions, and verification results. Do not delegate further.",
    permissions: implementationPermissions(),
  },
  heavy: {
    description: "Architecture, security, difficult debugging, and high-risk reasoning",
    system: "Act as a senior architecture and difficult-debugging specialist. Analyze evidence carefully, state trade-offs, and give a concrete recommendation or requested implementation. Do not delegate further.",
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
