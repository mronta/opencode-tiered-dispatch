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

const FAST_READ_ACTIONS = new Set(["grep", "glob", "webfetch", "websearch", "read"])

const FAST_READ_ONLY_RULES: readonly PermissionRule[] = [
  { action: "*", resource: "*", effect: "deny" },
  { action: "grep", resource: "*", effect: "allow" },
  { action: "glob", resource: "*", effect: "allow" },
  { action: "webfetch", resource: "*", effect: "allow" },
  { action: "websearch", resource: "*", effect: "allow" },
  { action: "read", resource: "*", effect: "allow" },
  { action: "read", resource: "*.env", effect: "ask" },
  { action: "read", resource: "*.env.*", effect: "ask" },
  { action: "read", resource: "*.env.example", effect: "allow" },
]

export function buildDelegatedPermissions(
  tier: TierName,
  callerAgentRules: readonly PermissionRule[] | undefined,
  callerSessionRules: readonly PermissionRule[] | undefined,
): PermissionRule[] {
  const callerRules = [...(callerAgentRules ?? []), ...(callerSessionRules ?? [])]
  if (tier !== "fast") return [...callerRules, ...CHILD_GUARDS]

  // Session rules are last-match-wins. Keep caller denies and read-only asks
  // after the fast baseline so it cannot weaken a caller restriction, while
  // write-related caller asks/allows cannot grant mutation access.
  return [
    ...callerRules,
    ...FAST_READ_ONLY_RULES,
    ...callerRules.filter(
      (rule) => rule.effect === "deny" || (rule.effect === "ask" && FAST_READ_ACTIONS.has(rule.action)),
    ),
    ...CHILD_GUARDS,
  ]
}
