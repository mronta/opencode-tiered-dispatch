import type { Context } from "@opencode/plugin/promise/plugin"
import type { AgentPermissionRule } from "./agents.js"
import { TIER_NAMES } from "./tiers.js"

/** Tools which a Plan-originated session may use without orchestration. */
export const PLAN_READONLY_TOOLS: ReadonlySet<string> = new Set([
  "read",
  "glob",
  "grep",
  "webfetch",
  "websearch",
  "question",
  "skill",
])

/** The only agents a Plan-originated session may invoke through native subagent. */
export const PLAN_ORCHESTRATION_TIERS: ReadonlySet<string> = new Set(TIER_NAMES)

export const PLAN_READONLY_INSTRUCTION =
  "This is a Plan-originated child. Read-only policy is enforced: use only read/search tools, question/skill tools, or the explicitly permitted plugin tier orchestration; do not edit, write, patch, run shell commands, or otherwise mutate the workspace. Do not delegate unless the Plan-origin read-only instruction explicitly permits tier orchestration; never self-escalate. Return findings and verification guidance instead of making changes."

type SessionInfo = Awaited<ReturnType<Context["session"]["get"]>>
type SessionPermissionRule = NonNullable<SessionInfo["permissions"]>[number]
type SessionKind = "root" | "descendant"

interface ManagedPermissions {
  readonly original: readonly AgentPermissionRule[]
  applied: readonly AgentPermissionRule[]
  readonly kind: SessionKind
  externallyEdited: boolean
  readonly setter?: "native" | "session"
}

interface OwnedPolicyBlock {
  readonly kind: "marker" | "full"
  readonly start: number
  readonly end: number
  readonly baseline: readonly AgentPermissionRule[]
}

export interface PlanSessionLookup {
  readonly owned: boolean
  readonly session: SessionInfo
  readonly kind: SessionKind
  /** The effective agent used for classification, when one was available. */
  readonly effectiveAgent?: string
}

/*
 * Permission actions are strings in the SDK, but the core evaluator treats
 * them as tool actions. Use a real action for the marker rather than relying
 * on an unknown action being accepted by every host version. The namespaced
 * resources make the two marker rules unambiguous and harmless.
 */
const POLICY_MARKER_ACTION = "subagent"
const POLICY_MARKER_START: AgentPermissionRule = {
  action: POLICY_MARKER_ACTION,
  resource: "tiered-dispatch.plan-origin/v1/start",
  effect: "deny",
}
const POLICY_MARKER_END: AgentPermissionRule = {
  action: POLICY_MARKER_ACTION,
  resource: "tiered-dispatch.plan-origin/v1/end",
  effect: "deny",
}

const PLAN_SAFE_ACTION_ORDER = [
  "grep",
  "glob",
  "webfetch",
  "websearch",
  "read",
  "question",
  "skill",
] as const

/** The validated full block installed on descendants only. */
const PLAN_POLICY_CORE = [
  POLICY_MARKER_START,
  { action: "*", resource: "*", effect: "deny" },
  ...PLAN_SAFE_ACTION_ORDER.map((action) => ({ action, resource: "*", effect: "allow" as const })),
  { action: "read", resource: "*.env", effect: "ask" },
  { action: "read", resource: "*.env.*", effect: "ask" },
  { action: "read", resource: "*.env.example", effect: "allow" },
  { action: "subagent", resource: "*", effect: "ask" },
  ...TIER_NAMES.map((tier) => ({ action: "subagent", resource: tier, effect: "allow" as const })),
] as const satisfies readonly AgentPermissionRule[]

/**
 * Stateful ownership and permission lifetime for Plan sessions.
 *
 * A parentless Plan session carries only a bounded marker. It is deliberately
 * not a real deny-all policy: the host takes its tool snapshot before the
 * session context hook, and a root policy would therefore make the first
 * Build request lose tools before this plugin could restore them. Descendants
 * replace the inherited marker with the full reversible read-only policy.
 */
export class StatefulPlanSafety {
  private readonly ownedDescendants = new Set<string>()
  private readonly managedPermissions = new Map<string, ManagedPermissions>()
  private readonly effectiveAgents = new Map<string, string>()
  private readonly knownSessions = new Map<string, SessionInfo>()
  private readonly queues = new Map<string, Promise<void>>()
  private disposed = false

  public constructor(private readonly ctx: Context) {}

  /** Inspect a session and reconcile descendant policy before callers use it. */
  public async inspect(sessionID: string, effectiveAgent?: string): Promise<PlanSessionLookup> {
    return this.enqueue(sessionID, async () => {
      if (effectiveAgent !== undefined) this.effectiveAgents.set(sessionID, effectiveAgent)
      let session: SessionInfo
      try {
        session = await this.getSession(sessionID)
      } catch (error) {
        // A previously verified descendant remains fail-closed even if a
        // transient lookup failure occurs. The cached session shape is enough
        // to retain the tool filter and execute guard; no permission rewrite
        // is attempted without a current server snapshot.
        const cached = this.knownSessions.get(sessionID)
        if (cached !== undefined && this.ownedDescendants.has(sessionID)) {
          const agent = effectiveAgent ?? this.effectiveAgents.get(sessionID) ?? cached.agent
          return lookup(cached, true, "descendant", agent)
        }
        throw error
      }
      this.knownSessions.set(sessionID, session)

      const kind: SessionKind = session.parentID === undefined ? "root" : "descendant"
      const agent = kind === "root"
        // A parentless session is owned only by the effective agent supplied
        // by the current hook. Do not let a prior Plan observation stick to
        // a later root lookup with no authoritative event agent.
        ? effectiveAgent
        // For an eventless continuation lookup, trust the fresh persisted
        // session agent before an older in-memory observation. The cache is
        // only a fallback when the server snapshot has no agent.
        : effectiveAgent ?? session.agent ?? this.effectiveAgents.get(sessionID)

      if (kind === "root") {
        if (agent === "plan") {
          await this.reconcileRootMarker(sessionID, session)
          return lookup(session, true, kind, agent)
        }

        // This also handles a restart: a proven marker (or a proven legacy
        // full block) is safe to remove, but it must never make a stale Build
        // root Plan-owned.
        await this.restore(sessionID, session)
        return lookup(session, false, kind, agent)
      }

      const owned = await this.isOwnedDescendant(sessionID, session, agent)
      if (!owned) return lookup(session, false, kind, agent)

      await this.enforce(sessionID, session)
      this.ownedDescendants.add(sessionID)
      return lookup(session, true, kind, agent)
    })
  }

  /** Reconcile root cleanup or descendant policy before the host snapshots tools. */
  public async preflight(sessionID: string): Promise<void> {
    return this.enqueue(sessionID, async () => {
      let session: SessionInfo
      try {
        session = await this.getSession(sessionID)
      } catch (error) {
        // A prompt for a session deleted between host callbacks needs no
        // permission restoration. Keep this catch immediately around the
        // lookup: setter failures below must still abort prompt admission.
        if (isMissingSessionError(error)) return
        throw error
      }
      const kind: SessionKind = session.parentID === undefined ? "root" : "descendant"
      if (kind === "root") {
        // Preserve root cleanup behavior: roots carry only the inheritance
        // marker, so prompt admission must remove it before the host's tool
        // snapshot without installing a descendant deny-all policy.
        await this.restore(sessionID, session)
        return
      }

      // Child prompts are also before the host's tool snapshot. Reconcile the
      // inherited marker into the full read-only policy now; context runs too
      // late to make question/skill/subagent visible to the first model turn.
      const agent = session.agent ?? this.effectiveAgents.get(sessionID)
      if (!await this.isOwnedDescendant(sessionID, session, agent)) return
      await this.enforce(sessionID, session)
      this.ownedDescendants.add(sessionID)
    })
  }

  /** Restore every permission set touched by this plugin instance. */
  public async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true

    // Let callbacks already admitted to a per-session queue finish before
    // taking the touched-session snapshot. Hook disposal prevents new host
    // work, but an in-flight callback may still be recording its first write.
    for (const sessionID of [...this.queues.keys()]) {
      await this.enqueue(sessionID, async () => undefined)
    }

    const sessionIDs = new Set(this.managedPermissions.keys())
    const failures: unknown[] = []
    for (const sessionID of sessionIDs) {
      try {
        await this.enqueue(sessionID, async () => {
          let session: SessionInfo
          try {
            session = await this.getSession(sessionID)
          } catch (error) {
            // A deleted session has no state left to restore. This is scoped
            // to the lookup only; any restore/setter failure is aggregated.
            if (isMissingSessionError(error)) return
            throw error
          }
          await this.restore(sessionID, session)
        })
      } catch (error) {
        failures.push(error)
      }
    }

    this.ownedDescendants.clear()
    this.managedPermissions.clear()
    this.effectiveAgents.clear()
    this.knownSessions.clear()

    if (failures.length > 0) {
      throw new AggregateError(failures, "Tiered Dispatch could not restore every Plan permission set")
    }
  }

  private async reconcileRootMarker(sessionID: string, session: SessionInfo): Promise<void> {
    const current = cloneRules(session.permissions ?? [])
    const parsed = ownedPolicyBlock(current)
    const managed = this.managedPermissions.get(sessionID)

    if (parsed?.kind === "marker") {
      if (managed === undefined) {
        this.managedPermissions.set(sessionID, {
          original: cloneRules(parsed.baseline),
          applied: cloneRules(current),
          kind: "root",
          externallyEdited: false,
        })
        return
      }
      if (sameRules(current, managed.applied)) return

      const desired = markerPermissions(parsed.baseline)
      if (sameRules(current, desired)) {
        managed.externallyEdited = true
        managed.applied = cloneRules(current)
        return
      }
      await this.setPermissions(sessionID, desired)
      managed.externallyEdited = true
      managed.applied = cloneRules(desired)
      return
    }

    if (parsed?.kind === "full") {
      // This is a safe cleanup of the unpublished earlier full-root shape.
      // Only the exact bounded plugin block is removed/replaced; arbitrary
      // named or partial rules are not treated as ours.
      const desired = markerPermissions(parsed.baseline)
      if (managed === undefined) {
        const next: ManagedPermissions = {
          original: cloneRules(parsed.baseline),
          applied: cloneRules(desired),
          kind: "root",
          externallyEdited: false,
          setter: this.permissionSetterKind(),
        }
        if (!sameRules(current, desired)) await this.setPermissions(sessionID, desired)
        this.managedPermissions.set(sessionID, next)
      } else {
        if (sameRules(current, desired)) {
          managed.externallyEdited = true
          managed.applied = cloneRules(current)
          return
        }
        await this.setPermissions(sessionID, desired)
        managed.externallyEdited = true
        managed.applied = cloneRules(desired)
      }
      return
    }

    if (managed !== undefined) {
      // A wholesale replacement or malformed/partial marker belongs to the
      // caller. Never overwrite it with a stale snapshot.
      // A few hosts expose permission.rules before session.get reflects the
      // write. Trust that exact original-baseline read only for a successful
      // native setter; a different replacement remains fail-closed.
      if (
        managed.kind === "root"
        && managed.setter === "native"
        && !managed.externallyEdited
        && sameRules(current, managed.original)
      ) return
      return
    }

    const desired = markerPermissions(current)
    const next: ManagedPermissions = {
      original: cloneRules(current),
      applied: cloneRules(desired),
      kind: "root",
      externallyEdited: false,
      setter: this.permissionSetterKind(),
    }
    await this.setPermissions(sessionID, desired)
    this.managedPermissions.set(sessionID, next)
    return
  }

  private async enforce(sessionID: string, session: SessionInfo): Promise<void> {
    const current = cloneRules(session.permissions ?? [])
    const parsed = ownedPolicyBlock(current)
    const managed = this.managedPermissions.get(sessionID)

    if (parsed !== undefined) {
      if (managed === undefined) {
        const desired = parsed.kind === "full" ? current : planReadonlyPermissions(parsed.baseline)
        const next: ManagedPermissions = {
          original: cloneRules(parsed.baseline),
          applied: cloneRules(desired),
          kind: "descendant",
          externallyEdited: false,
          setter: this.permissionSetterKind(),
        }
        if (!sameRules(current, desired)) await this.setPermissions(sessionID, desired)
        this.managedPermissions.set(sessionID, next)
        return
      }

      if (sameRules(current, managed.applied)) return
      const desired = planReadonlyPermissions(parsed.baseline)
      if (sameRules(current, desired)) {
        managed.externallyEdited = true
        managed.applied = cloneRules(current)
        return
      }

      // Only rebuild the valid bounded block. Rules before/after it are
      // external state and remain in the baseline in their original form.
      await this.setPermissions(sessionID, desired)
      managed.externallyEdited = true
      managed.applied = cloneRules(desired)
      return
    }

    if (managed !== undefined) {
      // The valid marker is gone or was edited. Do not clobber a wholesale
      // replacement with the previous plugin snapshot.
      return
    }

    const desired = planReadonlyPermissions(current)
    const next: ManagedPermissions = {
      original: cloneRules(current),
      applied: cloneRules(desired),
      kind: "descendant",
      externallyEdited: false,
      setter: this.permissionSetterKind(),
    }
    if (!sameRules(current, desired)) await this.setPermissions(sessionID, desired)
    this.managedPermissions.set(sessionID, next)
  }

  private async restore(sessionID: string, session: SessionInfo): Promise<void> {
    const current = cloneRules(session.permissions ?? [])
    const parsed = ownedPolicyBlock(current)
    const managed = this.managedPermissions.get(sessionID)

    if (parsed === undefined) {
      // The marker is absent, so there is no safe plugin-owned range to
      // remove. In particular, do not replace a user's wholesale update.
      // A native permission setter may be ahead of session.get; writing the
      // exact original baseline is harmless and closes that write-behind
      // lifetime before the root changes agent or the plugin unloads.
      if (
        managed?.setter === "native"
        && !managed.externallyEdited
        && sameRules(current, managed.original)
      ) await this.setPermissions(sessionID, managed.original)
      this.managedPermissions.delete(sessionID)
      return
    }

    const restored = managed !== undefined
      && !managed.externallyEdited
      && sameRules(current, managed.applied)
      ? managed.original
      : parsed.baseline
    if (!sameRules(current, restored)) await this.setPermissions(sessionID, restored)
    this.managedPermissions.delete(sessionID)
  }

  private async isOwnedDescendant(
    sessionID: string,
    session: SessionInfo,
    effectiveAgent: string | undefined,
  ): Promise<boolean> {
    const policy = ownedPolicyBlock(session.permissions ?? [])
    let owned = this.ownedDescendants.has(sessionID) || policy !== undefined || effectiveAgent === "plan"
    if (!owned) owned = await this.hasOwnedAncestor(session)
    return owned
  }

  private async hasOwnedAncestor(session: SessionInfo): Promise<boolean> {
    let ancestorID = session.parentID
    const visited = new Set<string>([String(session.id)])
    while (ancestorID !== undefined) {
      const ancestorKey = String(ancestorID)
      if (visited.has(ancestorKey)) throw new Error("Tiered Dispatch could not verify Plan session ancestry: cycle")
      visited.add(ancestorKey)

      if (this.ownedDescendants.has(ancestorKey)) return true
      const ancestor = await this.getSession(ancestorKey)
      const ancestorKind: SessionKind = ancestor.parentID === undefined ? "root" : "descendant"
      const effectiveAgent = this.effectiveAgents.get(ancestorKey) ?? ancestor.agent
      if (effectiveAgent === "plan") return true
      if (ancestorKind === "descendant" && ownedPolicyBlock(ancestor.permissions ?? []) !== undefined) {
        return true
      }
      ancestorID = ancestor.parentID
    }
    return false
  }

  private async getSession(sessionID: string): Promise<SessionInfo> {
    return this.ctx.session.get({ sessionID })
  }

  private async setPermissions(
    sessionID: string,
    permissions: readonly AgentPermissionRule[],
  ): Promise<void> {
    const permissionContext = this.ctx.permission as unknown as {
      rules?: (input: {
        sessionID: string
        permissions: readonly SessionPermissionRule[]
      }) => Promise<void> | void
    } | undefined
    if (typeof permissionContext?.rules === "function") {
      await permissionContext.rules({ sessionID, permissions })
      return
    }

    if (typeof this.ctx.session.update !== "function") {
      throw new Error("Tiered Dispatch cannot manage Plan permissions: the host exposes no session rule setter")
    }
    await this.ctx.session.update({ sessionID, permissions })
  }

  private permissionSetterKind(): "native" | "session" {
    const permissionContext = this.ctx.permission as unknown as { rules?: unknown } | undefined
    return typeof permissionContext?.rules === "function" ? "native" : "session"
  }

  private async enqueue<T>(sessionID: string, task: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(sessionID)
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const tail = (previous ?? Promise.resolve()).catch(() => undefined).then(() => gate)
    this.queues.set(sessionID, tail)

    try {
      if (previous !== undefined) await previous.catch(() => undefined)
      return await task()
    } finally {
      release()
      if (this.queues.get(sessionID) === tail) this.queues.delete(sessionID)
    }
  }
}

/** Build a reversible, bounded full Plan policy without mutating the input. */
export function planReadonlyPermissions(
  existing: readonly AgentPermissionRule[],
): readonly AgentPermissionRule[] {
  const parsed = ownedPolicyBlock(existing)
  const baseline = parsed?.baseline ?? existing
  const restrictive = baseline.filter((rule) => rule.effect === "deny" || rule.effect === "ask")
  return [
    ...baseline,
    ...cloneRules(PLAN_POLICY_CORE),
    ...cloneRules(restrictive),
    { ...POLICY_MARKER_END },
  ]
}

function markerPermissions(existing: readonly AgentPermissionRule[]): readonly AgentPermissionRule[] {
  const parsed = ownedPolicyBlock(existing)
  const baseline = parsed?.baseline ?? existing
  return [...baseline, { ...POLICY_MARKER_START }, { ...POLICY_MARKER_END }]
}

/** Parse only the exact marker-only or full bounded block emitted by us. */
function ownedPolicyBlock(permissions: readonly AgentPermissionRule[]): OwnedPolicyBlock | undefined {
  const starts = permissions
    .map((rule, index) => sameRule(rule, POLICY_MARKER_START) ? index : -1)
    .filter((index) => index >= 0)
  const ends = permissions
    .map((rule, index) => sameRule(rule, POLICY_MARKER_END) ? index : -1)
    .filter((index) => index >= 0)
  const candidates: OwnedPolicyBlock[] = []
  for (const start of starts) {
    for (const end of ends) {
      if (start >= end) continue
      if (end === start + 1) {
        candidates.push({
          kind: "marker",
          start,
          end,
          baseline: [
            ...permissions.slice(0, start),
            ...permissions.slice(end + 1),
          ],
        })
        continue
      }

      if (!matchesAt(permissions, start, PLAN_POLICY_CORE)) continue
      const replayStart = start + PLAN_POLICY_CORE.length
      if (replayStart > end) continue
      if ([...permissions.slice(replayStart, end)].some((rule) => (
        (rule.effect !== "deny" && rule.effect !== "ask")
        || sameRule(rule, POLICY_MARKER_START)
        || sameRule(rule, POLICY_MARKER_END)
      ))) continue
      candidates.push({
        kind: "full",
        start,
        end,
        baseline: [
          ...permissions.slice(0, start),
          ...permissions.slice(end + 1),
        ],
      })
    }
  }

  // Multiple valid bounded blocks are ambiguous. Refuse to remove any of
  // them rather than risking a user-authored namespaced rule.
  return candidates.length === 1 ? candidates[0] : undefined
}

function lookup(
  session: SessionInfo,
  owned: boolean,
  kind: SessionKind,
  effectiveAgent: string | undefined,
): PlanSessionLookup {
  return {
    owned,
    session,
    kind,
    ...(effectiveAgent === undefined ? {} : { effectiveAgent }),
  }
}

function cloneRules(rules: readonly AgentPermissionRule[]): AgentPermissionRule[] {
  return rules.map((rule) => ({ ...rule }))
}

function matchesAt(
  permissions: readonly AgentPermissionRule[],
  start: number,
  expected: readonly AgentPermissionRule[],
): boolean {
  return expected.every((rule, offset) => sameRule(permissions[start + offset], rule))
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

function isMissingSessionError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false
  const candidate = error as {
    status?: unknown
    statusCode?: unknown
    code?: unknown
    name?: unknown
    reason?: unknown
    cause?: unknown
  }
  const cause = typeof candidate.cause === "object" && candidate.cause !== null
    ? candidate.cause as { status?: unknown }
    : undefined
  return candidate.status === 404
    || candidate.statusCode === 404
    || candidate.code === "NOT_FOUND"
    || candidate.code === "SESSION_NOT_FOUND"
    || candidate.name === "NotFoundError"
    || candidate.name === "SessionNotFoundError"
    || (candidate.reason === "UnexpectedStatus" && cause?.status === 404)
}
