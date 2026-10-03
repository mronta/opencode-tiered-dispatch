import type { TierName } from "./tiers.js"

export interface PermissionRule {
  action: string
  resource: string
  effect: "allow" | "deny" | "ask"
}

const CHILD_GUARDS: readonly PermissionRule[] = [
  { action: "question", resource: "*", effect: "deny" },
  { action: "subagent", resource: "*", effect: "deny" },
  { action: "tiered_dispatch", resource: "*", effect: "deny" },
]

const FAST_RULES: readonly PermissionRule[] = [
  { action: "*", resource: "*", effect: "deny" },
  { action: "grep", resource: "*", effect: "allow" },
  { action: "glob", resource: "*", effect: "allow" },
  { action: "webfetch", resource: "*", effect: "allow" },
  { action: "websearch", resource: "*", effect: "allow" },
  { action: "read", resource: "*", effect: "allow" },
  { action: "read", resource: "*.env", effect: "ask" },
  { action: "read", resource: "*.env.*", effect: "ask" },
  { action: "read", resource: "*.env.example", effect: "allow" },
  ...CHILD_GUARDS,
]

export function buildDelegatedPermissions(
  tier: TierName,
  callerAgentRules: readonly PermissionRule[] | undefined,
  callerSessionRules: readonly PermissionRule[] | undefined,
): PermissionRule[] {
  return [
    ...(callerAgentRules ?? []),
    ...(callerSessionRules ?? []),
    ...(tier === "fast" ? FAST_RULES : CHILD_GUARDS),
  ]
}
