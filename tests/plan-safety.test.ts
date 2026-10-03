import type { Context } from "@opencode/plugin/promise/plugin"
import { describe, expect, it, vi } from "vitest"
import type { AgentPermissionRule } from "../src/agents.js"
import {
  planReadonlyPermissions,
  StatefulPlanSafety,
} from "../src/plan-safety.js"

type Rule = AgentPermissionRule

interface FakeSession {
  id: string
  parentID?: string
  agent?: string
  permissions?: Rule[]
}

function fakeContext(initial: readonly FakeSession[], nativeRules = false) {
  const sessions = new Map(initial.map((session) => [session.id, structuredClone(session)]))
  const updates: Rule[][] = []
  const rules = vi.fn(async ({ sessionID, permissions }: { sessionID: string; permissions: readonly Rule[] }) => {
    updates.push(copyRules(permissions))
    const session = sessions.get(sessionID)
    if (session) session.permissions = copyRules(permissions)
  })
  const get = vi.fn(async ({ sessionID }: { sessionID: string }) => {
    const session = sessions.get(sessionID)
    if (!session) return { id: sessionID }
    return {
      id: session.id,
      ...(session.parentID === undefined ? {} : { parentID: session.parentID }),
      ...(session.agent === undefined ? {} : { agent: session.agent }),
      ...(session.permissions === undefined ? {} : { permissions: session.permissions }),
    }
  })
  const update = vi.fn(async ({ sessionID, permissions }: { sessionID: string; permissions: readonly Rule[] }) => {
    updates.push(copyRules(permissions))
    const session = sessions.get(sessionID)
    if (session) session.permissions = copyRules(permissions)
  })
  const context = {
    session: { get, update },
    ...(nativeRules ? { permission: { rules } } : {}),
  } as unknown as Context
  return { context, sessions, get, update, rules, updates }
}

function copyRules(rules: readonly Rule[]): Rule[] {
  return rules.map((rule) => ({ ...rule }))
}

const userRules: Rule[] = [
  { action: "read", resource: "private.txt", effect: "deny" },
  { action: "edit", resource: "*", effect: "allow" },
  { action: "question", resource: "security", effect: "ask" },
]

describe("StatefulPlanSafety", () => {
  it("round-trips a marker-only root and hardens an old child after root Build", async () => {
    const fixture = fakeContext([
      { id: "root", agent: "build", permissions: userRules },
    ])
    const safety = new StatefulPlanSafety(fixture.context)

    const rootPlan = await safety.inspect("root", "plan")
    expect(rootPlan.owned).toBe(true)
    const inheritedMarker = copyRules(fixture.sessions.get("root")?.permissions ?? [])
    expect(inheritedMarker).toEqual([
      ...userRules,
      { action: "subagent", resource: "tiered-dispatch.plan-origin/v1/start", effect: "deny" },
      { action: "subagent", resource: "tiered-dispatch.plan-origin/v1/end", effect: "deny" },
    ])
    expect(inheritedMarker).not.toContainEqual({ action: "*", resource: "*", effect: "deny" })

    await safety.inspect("root", "plan")
    expect(fixture.updates).toHaveLength(1)

    await safety.inspect("root", "build")
    expect(fixture.sessions.get("root")?.permissions).toEqual(userRules)

    fixture.sessions.set("old-child", {
      id: "old-child",
      parentID: "root",
      agent: "build",
      permissions: inheritedMarker,
    })
    fixture.sessions.set("new-child", {
      id: "new-child",
      parentID: "root",
      agent: "build",
      permissions: structuredClone(userRules),
    })

    const oldChild = await safety.inspect("old-child", "build")
    const newChild = await safety.inspect("new-child", "build")
    expect(oldChild.owned).toBe(true)
    expect(newChild.owned).toBe(false)
    const childRules = fixture.sessions.get("old-child")?.permissions ?? []
    expect(childRules.slice(0, userRules.length)).toEqual(userRules)
    expect(childRules).toEqual(expect.arrayContaining([
      { action: "*", resource: "*", effect: "deny" },
      { action: "question", resource: "*", effect: "allow" },
      { action: "skill", resource: "*", effect: "allow" },
      { action: "subagent", resource: "*", effect: "ask" },
      { action: "subagent", resource: "fast", effect: "allow" },
    ]))
    expect([...childRules].reverse().find((rule) => rule.action === "*" && rule.resource === "*")?.effect)
      .toBe("deny")
    expect([...childRules].reverse().find((rule) => rule.action === "question")?.effect).toBe("ask")

    await safety.dispose()
    expect(fixture.sessions.get("old-child")?.permissions).toEqual(userRules)
  })

  it("uses the event agent over stale session data and removes a persisted marker after restart", async () => {
    const first = fakeContext([{ id: "root", agent: "plan", permissions: userRules }])
    const firstSafety = new StatefulPlanSafety(first.context)
    await firstSafety.inspect("root", "plan")
    const persistedMarker = structuredClone(first.sessions.get("root")?.permissions) as Rule[]

    const restarted = fakeContext([{ id: "root", agent: "plan", permissions: persistedMarker }])
    const restartedSafety = new StatefulPlanSafety(restarted.context)
    const build = await restartedSafety.inspect("root", "build")
    expect(build.owned).toBe(false)
    expect(restarted.sessions.get("root")?.permissions).toEqual(userRules)

    const stale = fakeContext([{ id: "root", agent: "plan", permissions: persistedMarker }])
    const staleSafety = new StatefulPlanSafety(stale.context)
    const normal = await staleSafety.inspect("root", "build")
    expect(normal.owned).toBe(false)
    expect(stale.sessions.get("root")?.permissions).toEqual(userRules)
  })

  it("preserves externally changed prefixes and refuses wholesale replacements", async () => {
    const fixture = fakeContext([{ id: "root", agent: "build", permissions: userRules }])
    const safety = new StatefulPlanSafety(fixture.context)
    await safety.inspect("root", "plan")

    const marker = fixture.sessions.get("root")?.permissions ?? []
    const changedPrefix: Rule[] = [
      { action: "read", resource: "changed.txt", effect: "deny" },
      ...userRules.slice(1),
      ...marker.slice(userRules.length),
    ]
    fixture.sessions.get("root")!.permissions = changedPrefix
    await safety.inspect("root", "plan")
    expect(fixture.sessions.get("root")?.permissions?.slice(0, 1)).toEqual([changedPrefix[0]])
    await safety.inspect("root", "build")
    expect(fixture.sessions.get("root")?.permissions).toEqual(changedPrefix.slice(0, userRules.length))

    await safety.inspect("root", "plan")
    const wholesale: Rule[] = [{ action: "write", resource: "owned-by-user", effect: "allow" }]
    fixture.sessions.get("root")!.permissions = wholesale
    const before = fixture.updates.length
    const plan = await safety.inspect("root", "plan")
    expect(plan.owned).toBe(true)
    await safety.inspect("root", "build")
    expect(fixture.sessions.get("root")?.permissions).toEqual(wholesale)
    expect(fixture.updates).toHaveLength(before)
  })

  it("supports both permission setters and does not rewrite repeated policies", async () => {
    const fallback = fakeContext([{ id: "root", agent: "build" }])
    const fallbackSafety = new StatefulPlanSafety(fallback.context)
    await fallbackSafety.inspect("root", "plan")
    await fallbackSafety.inspect("root", "plan")
    expect(fallback.update).toHaveBeenCalledOnce()

    const current = fakeContext([{ id: "root", agent: "build" }], true)
    const currentSafety = new StatefulPlanSafety(current.context)
    await currentSafety.inspect("root", "plan")
    await currentSafety.inspect("root", "plan")
    expect(current.rules).toHaveBeenCalledOnce()
    expect(current.update).not.toHaveBeenCalled()
  })

  it("retries root and child installs after a transient setter failure", async () => {
    const rootFixture = fakeContext([{ id: "root", agent: "build", permissions: userRules }])
    const rootSafety = new StatefulPlanSafety(rootFixture.context)
    rootFixture.update.mockRejectedValueOnce(new Error("temporary permission write failure"))
    await expect(rootSafety.inspect("root", "plan")).rejects.toThrow("temporary permission write failure")
    await expect(rootSafety.inspect("root", "plan")).resolves.toMatchObject({ owned: true })
    expect(rootFixture.sessions.get("root")?.permissions?.slice(0, userRules.length)).toEqual(userRules)
    expect(rootFixture.update).toHaveBeenCalledTimes(2)

    const inherited = copyRules(rootFixture.sessions.get("root")?.permissions ?? [])
    rootFixture.sessions.set("child", {
      id: "child",
      parentID: "root",
      agent: "medium",
      permissions: inherited,
    })
    rootFixture.update.mockRejectedValueOnce(new Error("temporary child permission write failure"))
    await expect(rootSafety.inspect("child", "medium")).rejects.toThrow("temporary child permission write failure")
    await expect(rootSafety.inspect("child", "medium")).resolves.toMatchObject({ owned: true })
    expect(rootFixture.sessions.get("child")?.permissions?.slice(0, userRules.length)).toEqual(userRules)
    expect(rootFixture.update).toHaveBeenCalledTimes(4)
  })

  it("keeps a known descendant fail-closed when a later ancestry lookup fails", async () => {
    const fixture = fakeContext([{
      id: "child",
      parentID: "root",
      agent: "medium",
      permissions: [
        { action: "subagent", resource: "tiered-dispatch.plan-origin/v1/start", effect: "deny" },
        { action: "subagent", resource: "tiered-dispatch.plan-origin/v1/end", effect: "deny" },
      ],
    }])
    const safety = new StatefulPlanSafety(fixture.context)
    expect((await safety.inspect("child", "medium")).owned).toBe(true)
    fixture.get.mockRejectedValue(new Error("temporary session lookup failure"))
    expect((await safety.inspect("child", "build")).owned).toBe(true)
  })

  it("prefers a fresh persisted child agent over a stale cached tier", async () => {
    const fixture = fakeContext([{
      id: "child",
      parentID: "root",
      agent: "medium",
      permissions: [
        { action: "subagent", resource: "tiered-dispatch.plan-origin/v1/start", effect: "deny" },
        { action: "subagent", resource: "tiered-dispatch.plan-origin/v1/end", effect: "deny" },
      ],
    }])
    const safety = new StatefulPlanSafety(fixture.context)
    expect((await safety.inspect("child", "medium")).effectiveAgent).toBe("medium")
    fixture.sessions.get("child")!.agent = "custom"
    const continuation = await safety.inspect("child")
    expect(continuation.effectiveAgent).toBe("custom")
  })

  it("does not strip a partial namespaced marker and keeps restrictive rules in the full block", () => {
    const full = planReadonlyPermissions(userRules)
    expect(full.slice(0, userRules.length)).toEqual(userRules)
    expect(full).toEqual(expect.arrayContaining([
      { action: "read", resource: "*.env", effect: "ask" },
      { action: "question", resource: "*", effect: "allow" },
      { action: "skill", resource: "*", effect: "allow" },
    ]))
    expect(full.at(-1)).toEqual({
      action: "subagent",
      resource: "tiered-dispatch.plan-origin/v1/end",
      effect: "deny",
    })
  })

  it("replays a user subagent wildcard denial after the tier visibility rules", () => {
    const full = planReadonlyPermissions([
      { action: "subagent", resource: "*", effect: "deny" },
    ])

    expect(full).toEqual(expect.arrayContaining([
      { action: "subagent", resource: "*", effect: "ask" },
      { action: "subagent", resource: "fast", effect: "allow" },
    ]))
    expect([...full].reverse().find((rule) => rule.action === "subagent" && rule.resource === "*")?.effect)
      .toBe("deny")
  })

  it("aggregates permission restore failures while restoring other touched sessions", async () => {
    const fixture = fakeContext([
      { id: "root", agent: "build" },
      { id: "child", parentID: "root", agent: "medium", permissions: [
        { action: "subagent", resource: "tiered-dispatch.plan-origin/v1/start", effect: "deny" },
        { action: "subagent", resource: "tiered-dispatch.plan-origin/v1/end", effect: "deny" },
      ] },
    ])
    const safety = new StatefulPlanSafety(fixture.context)
    await safety.inspect("root", "plan")
    await safety.inspect("child", "medium")
    fixture.get.mockImplementation(async ({ sessionID }: { sessionID: string }) => {
      if (sessionID === "child") throw new Error("child lookup failed")
      const session = fixture.sessions.get(sessionID)
      return {
        id: sessionID,
        ...(session?.agent === undefined ? {} : { agent: session.agent }),
        ...(session?.permissions === undefined ? {} : { permissions: session.permissions }),
      }
    })

    await expect(safety.dispose()).rejects.toBeInstanceOf(AggregateError)
    expect(fixture.sessions.get("root")?.permissions).toEqual([])
  })

  it("does not turn an already deleted session into a cleanup failure", async () => {
    const fixture = fakeContext([{ id: "root", agent: "build" }])
    const safety = new StatefulPlanSafety(fixture.context)
    await safety.inspect("root", "plan")
    fixture.get.mockRejectedValue(Object.assign(new Error("session not found"), { status: 404 }))
    await expect(safety.preflight("root")).resolves.toBeUndefined()
    await expect(safety.dispose()).resolves.toBeUndefined()
  })

  it("does not suppress structured 404 setter failures during preflight or disposal", async () => {
    for (const nativeRules of [true, false]) {
      const fixture = fakeContext([{ id: "root", agent: "build" }], nativeRules)
      const safety = new StatefulPlanSafety(fixture.context)
      await safety.inspect("root", "plan")

      const setter = nativeRules ? fixture.rules : fixture.update
      const failure = Object.assign(new Error("permission restore failed"), { status: 404 })
      setter.mockRejectedValue(failure)

      await expect(safety.preflight("root")).rejects.toBe(failure)
      await expect(safety.dispose()).rejects.toBeInstanceOf(AggregateError)
    }
  })
})
