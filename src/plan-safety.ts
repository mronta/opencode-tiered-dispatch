import type { Context } from "@opencode/plugin/promise/plugin"
import type { AgentPermissionRule } from "./agents.js"
import { TIER_NAMES } from "./tiers.js"

export const PLAN_READONLY_TOOLS: ReadonlySet<string> = new Set([
  "read",
  "glob",
  "grep",
  "webfetch",
  "websearch",
])

export const PLAN_ORCHESTRATION_TIERS: ReadonlySet<string> = new Set(TIER_NAMES)

export const PLAN_READONLY_INSTRUCTION =
  "This is a Plan-originated child. Read-only policy is enforced: use only read/search tools or safe tier orchestration; do not edit, write, patch, run shell commands, or otherwise mutate the workspace. Return findings and verification guidance instead of making changes."

type SessionInfo = Awaited<ReturnType<Context["session"]["get"]>>
type SessionPermissionRule = NonNullable<SessionInfo["permissions"]>[number]

const PLAN_READONLY_RULES = [
  { action: "*", resource: "*", effect: "deny" },
  { action: "grep", resource: "*", effect: "allow" },
  { action: "glob", resource: "*", effect: "allow" },
  { action: "webfetch", resource: "*", effect: "allow" },
  { action: "websearch", resource: "*", effect: "allow" },
  { action: "read", resource: "*", effect: "allow" },
  { action: "read", resource: "*.env", effect: "ask" },
  { action: "read", resource: "*.env.*", effect: "ask" },
  { action: "read", resource: "*.env.example", effect: "allow" },
  ...TIER_NAMES.map((tier) => ({ action: "subagent", resource: tier, effect: "allow" as const })),
] as const satisfies readonly AgentPermissionRule[]

const PLAN_SAFE_ACTIONS = new Set([...PLAN_READONLY_TOOLS, "subagent"])

export interface PlanSessionLookup {
  readonly owned: boolean
  readonly session: SessionInfo
}

export async function findPlanSession(
  ctx: Context,
  sessionID: string,
  currentAgent: string | undefined,
  planSessionIDs: Set<string>,
): Promise<PlanSessionLookup> {
  if (currentAgent === "plan") planSessionIDs.add(sessionID)

  const currentSession = await ctx.session.get({ sessionID })
  if (currentSession.agent === "plan") planSessionIDs.add(currentSession.id)
  if (planSessionIDs.has(currentSession.id)) return { owned: true, session: currentSession }

  let ancestor = currentSession
  const visited = new Set<string>([ancestor.id])
  while (ancestor.parentID !== undefined) {
    if (planSessionIDs.has(ancestor.parentID)) return { owned: true, session: currentSession }
    if (visited.has(ancestor.parentID)) return { owned: false, session: currentSession }
    visited.add(ancestor.parentID)
    ancestor = await ctx.session.get({ sessionID: ancestor.parentID })
    if (ancestor.agent === "plan") {
      planSessionIDs.add(ancestor.id)
      return { owned: true, session: currentSession }
    }
    if (planSessionIDs.has(ancestor.id)) return { owned: true, session: currentSession }
  }

  return { owned: false, session: currentSession }
}

export async function enforcePlanSessionPermissions(
  ctx: Context,
  sessionID: string,
  session?: SessionInfo,
): Promise<void> {
  const current = session ?? await ctx.session.get({ sessionID })
  const existing = current.permissions ?? []
  const permissions = planReadonlyPermissions(existing)
  if (sameRules(existing, permissions)) return

  // Newer V2 hosts expose permission.rules directly. The supported 2.0.x
  // client types expose the same session-rule replacement through
  // session.update({ permissions }), so prefer the documented method and keep
  // the typed client fallback for the host version this package supports.
  const permissionContext = ctx.permission as unknown as {
    rules?: (input: {
      sessionID: string
      permissions: readonly SessionPermissionRule[]
    }) => Promise<void> | void
  } | undefined
  if (typeof permissionContext?.rules === "function") {
    await permissionContext.rules({ sessionID, permissions })
    return
  }

  if (typeof ctx.session.update !== "function") {
    throw new Error("Tiered Dispatch cannot enforce Plan read-only permissions: the host exposes no session rule setter")
  }
  await ctx.session.update({ sessionID, permissions })
}

export function planReadonlyPermissions(
  existing: readonly AgentPermissionRule[],
): readonly AgentPermissionRule[] {
  const withoutPolicy = stripReadonlyPolicy(existing)
  const beforePolicy: AgentPermissionRule[] = []
  const afterPolicy: AgentPermissionRule[] = []
  for (const rule of withoutPolicy) {
    if (rule.effect === "deny" || (rule.effect === "ask" && PLAN_SAFE_ACTIONS.has(rule.action))) {
      afterPolicy.push(rule)
    } else {
      beforePolicy.push(rule)
    }
  }
  const permissions = [...beforePolicy, ...PLAN_READONLY_RULES, ...uniqueRules(afterPolicy)]
  return hasReadonlyPolicy(existing) ? existing : permissions
}

function hasReadonlyPolicy(permissions: readonly AgentPermissionRule[]): boolean {
  for (let start = permissions.length - PLAN_READONLY_RULES.length; start >= 0; start -= 1) {
    if (!matchesAt(permissions, start, PLAN_READONLY_RULES)) continue
    const suffix = permissions.slice(start + PLAN_READONLY_RULES.length)
    if (suffix.every((rule) => rule.effect === "deny" || PLAN_SAFE_ACTIONS.has(rule.action))) return true
  }
  return false
}

function stripReadonlyPolicy(permissions: readonly AgentPermissionRule[]): AgentPermissionRule[] {
  const result: AgentPermissionRule[] = []
  for (let index = 0; index < permissions.length;) {
    if (matchesAt(permissions, index, PLAN_READONLY_RULES)) {
      index += PLAN_READONLY_RULES.length
      continue
    }
    result.push(permissions[index]!)
    index += 1
  }
  return result
}

function matchesAt(
  permissions: readonly AgentPermissionRule[],
  start: number,
  expected: readonly AgentPermissionRule[],
): boolean {
  return expected.every((rule, offset) => sameRule(permissions[start + offset], rule))
}

function uniqueRules(rules: readonly AgentPermissionRule[]): AgentPermissionRule[] {
  const result: AgentPermissionRule[] = []
  for (const rule of rules) {
    if (!result.some((candidate) => sameRule(candidate, rule))) result.push(rule)
  }
  return result
}

function sameRules(
  left: readonly AgentPermissionRule[],
  right: readonly AgentPermissionRule[],
): boolean {
  return left.length === right.length && left.every((rule, index) => sameRule(rule, right[index]))
}

function sameRule(
  left: AgentPermissionRule | undefined,
  right: AgentPermissionRule | undefined,
): boolean {
  return left?.action === right?.action
    && left?.resource === right?.resource
    && left?.effect === right?.effect
}
