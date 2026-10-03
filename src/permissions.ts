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

const FAST_READ_ACTIONS = ["grep", "glob", "webfetch", "websearch", "read"] as const
const FAST_READ_ACTION_SET = new Set<string>(FAST_READ_ACTIONS)

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

  // Session rules are last-match-wins. Start with a read-only baseline, then
  // replay caller rules only for read-capable actions. Wildcard caller
  // asks/denies are expanded instead of replayed as wildcards: a wildcard ask
  // must not turn fast's deny-all mutation guard into an approval prompt.
  return [
    ...FAST_READ_ONLY_RULES,
    ...callerRules.flatMap((rule) => {
      if (FAST_READ_ACTION_SET.has(rule.action)) return [rule]
      if (rule.action === "*") {
        if (rule.effect === "allow") return []
        return FAST_READ_ACTIONS.map((action) => ({ ...rule, action }))
      }
      // A caller deny is compatible with fast's stronger read-only guard.
      // A caller ask for a mutation must not weaken that guard into ask.
      return rule.effect === "deny" ? [rule] : []
    }),
    ...CHILD_GUARDS,
  ]
}
