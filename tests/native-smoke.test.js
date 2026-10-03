import { EventEmitter } from "node:events"
import { describe, expect, it, vi } from "vitest"
import {
  fetchJsonWithDeadline,
  fetchWithDeadline,
  waitForDeadline,
} from "../scripts/native-http.mjs"
import {
  NATIVE_PLAN_POLICY_RULES,
  NATIVE_PLAN_SAFE_TOOLS,
  effectiveNativePermission,
  verifyNativePlanEvidence,
} from "../scripts/opencode-native-smoke.mjs"

describe("native smoke HTTP deadlines", () => {
  it("aborts a fetch that never resolves", async () => {
    let requestSignal
    const fetchImpl = vi.fn((_input, init) => {
      requestSignal = init.signal
      return new Promise((_, reject) => {
        init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true })
      })
    })

    await expect(fetchWithDeadline("http://native-smoke.test/hang", {}, { timeoutMs: 25, fetchImpl }))
      .rejects.toMatchObject({ code: "NATIVE_DEADLINE_EXCEEDED" })
    expect(fetchImpl).toHaveBeenCalledOnce()
    expect(requestSignal?.aborted).toBe(true)
  })

  it("returns an immediate response before its deadline", async () => {
    let requestSignal
    const response = { ok: true, status: 200 }
    const result = await fetchWithDeadline("http://native-smoke.test/ready", {}, {
      timeoutMs: 500,
      fetchImpl: vi.fn((_input, init) => {
        requestSignal = init.signal
        return Promise.resolve(response)
      }),
    })

    expect(result).toBe(response)
    expect(requestSignal?.aborted).toBe(false)
  })

  it("keeps the deadline active while decoding a stalled JSON body", async () => {
    let requestSignal
    const fetchImpl = vi.fn((_input, init) => {
      requestSignal = init.signal
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => new Promise((_, reject) => {
          init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true })
        }),
      })
    })

    await expect(fetchJsonWithDeadline("http://native-smoke.test/stalled-body", {}, { timeoutMs: 25, fetchImpl }))
      .rejects.toMatchObject({ code: "NATIVE_DEADLINE_EXCEEDED" })
    expect(requestSignal?.aborted).toBe(true)
  })

  it("retries connection-refused startup failures until the endpoint is ready", async () => {
    let attempts = 0
    const fetchImpl = vi.fn(async () => {
      attempts += 1
      if (attempts < 3) throw new Error("ECONNREFUSED")
      return { ok: true, status: 200 }
    })

    await waitForDeadline(
      async (signal, deadline) => (await fetchWithDeadline(
        "http://native-smoke.test/starting",
        { signal },
        { deadline, fetchImpl },
      )).ok,
      500,
      () => "startup logs",
      { intervalMs: 1 },
    )

    expect(attempts).toBe(3)
  })

  it("retains the original predicate failure on timeout", async () => {
    const original = new Error("connection refused by the test endpoint")
    let failure
    try {
      await waitForDeadline(() => Promise.reject(original), 25, () => "captured logs", {
        nativeTimeout: true,
        intervalMs: 1,
      })
    } catch (error) {
      failure = error
    }

    expect(failure).toMatchObject({ code: "NATIVE_SMOKE_TIMEOUT", lastPredicateError: original })
    expect(failure.cause).toBe(original)
    expect(failure.message).toContain("captured logs")
  })
})

describe("native Plan smoke oracle", () => {
  it("checks effective session policy, safe context tools, and Build restoration", () => {
    const customDeny = { action: "read", resource: "native-smoke-private.txt", effect: "deny" }
    const grepDeny = { action: "grep", resource: "*", effect: "deny" }
    const permissions = [{ action: "*", resource: "*", effect: "allow" }, ...NATIVE_PLAN_POLICY_RULES, grepDeny, customDeny, { action: "subagent", resource: "heavy", effect: "deny" }]
    const originalBuildPermissions = [
      { action: "*", resource: "*", effect: "allow" },
      grepDeny,
      customDeny,
      { action: "edit", resource: "native-smoke-protected.txt", effect: "deny" },
      { action: "subagent", resource: "heavy", effect: "deny" },
      { action: "subagent", resource: "fast", effect: "allow" },
    ]
    const rootPermissions = [
      ...originalBuildPermissions,
      { action: "subagent", resource: "plugin-root-marker/a", effect: "deny" },
      { action: "subagent", resource: "plugin-root-marker/b", effect: "deny" },
    ]
    const context = (isChild) => ({
      toolNames: [...NATIVE_PLAN_SAFE_TOOLS.filter((tool) => tool !== "grep"), "subagent"],
      hasPlanInstruction: isChild,
    })
    const evidence = {
      root: { id: "plan-root", agent: "plan", permissions: rootPermissions, context: context(false) },
      child: { id: "plan-child", parentID: "plan-root", agent: "fast", permissions, context: context(true) },
      buildBefore: { id: "plan-root", agent: "build", context: { toolNames: ["read", "edit", "patch", "shell"], hasPlanInstruction: false } },
      buildPermissionsBefore: originalBuildPermissions,
      buildPermissionsAfter: originalBuildPermissions.map((rule) => ({ ...rule })),
      restoredBuild: { id: "plan-root", agent: "build", permissions: originalBuildPermissions, context: { toolNames: ["read", "edit", "patch", "shell"], hasPlanInstruction: false } },
      restoredBuildChild: { id: "build-child", parentID: "plan-root", agent: "fast", permissions: [], context: { toolNames: ["read"], hasPlanInstruction: false } },
      userDenied: [grepDeny, { action: "subagent", resource: "heavy", effect: "deny" }],
      guardToolEvents: [{ tool: "shell", status: "error", result: { status: "error" } }],
      guardErrorText: "Plan read-only guard rejected shell",
      toolEvents: [],
    }

    expect(effectiveNativePermission(permissions, "read", "native-smoke-private.txt")?.effect).toBe("deny")
    expect(effectiveNativePermission(permissions, "subagent", "unknown-agent")?.effect).toBe("ask")
    expect(effectiveNativePermission(permissions, "grep", "*")?.effect).toBe("deny")
    expect(verifyNativePlanEvidence(evidence)).toBe(evidence)

    const rootWithChildPolicy = structuredClone(evidence)
    rootWithChildPolicy.root.permissions = [...originalBuildPermissions, ...NATIVE_PLAN_POLICY_RULES]
    expect(() => verifyNativePlanEvidence(rootWithChildPolicy)).toThrow(/full\/restrictive child policy/u)

    const shellOnlyBuild = structuredClone(evidence)
    shellOnlyBuild.buildBefore.context.toolNames = ["shell"]
    shellOnlyBuild.restoredBuild.context.toolNames = ["shell"]
    expect(() => verifyNativePlanEvidence(shellOnlyBuild)).toThrow(/required mutating tools/u)

    const missingPatchAfterRestore = structuredClone(evidence)
    missingPatchAfterRestore.restoredBuild.context.toolNames = ["read", "edit", "shell"]
    expect(() => verifyNativePlanEvidence(missingPatchAfterRestore)).toThrow(/mutating tool set/u)

    const customTargetGuard = structuredClone(evidence)
    customTargetGuard.guardToolEvents = [{
      tool: "subagent",
      status: "error",
      result: { error: "Plan can orchestrate only the fast, medium, and heavy plugin tiers" },
    }]
    customTargetGuard.guardErrorText = ""
    expect(verifyNativePlanEvidence(customTargetGuard)).toBe(customTargetGuard)
  })
})

describe("native process cleanup", () => {
  it("does not require an exit event after forced termination", async () => {
    const child = new EventEmitter()
    child.exitCode = null
    child.signalCode = null
    child.kill = vi.fn((signal) => {
      if (signal === "SIGKILL") child.signalCode = "SIGKILL"
      return true
    })

    // Import lazily so this test documents the owned-process contract without
    // starting the smoke runner module during collection.
    const { stopProcess } = await import("../scripts/opencode-native-smoke.mjs")
    await expect(stopProcess(child, { timeoutMs: 10 })).resolves.toMatchObject({ stopped: true, forced: true })
    expect(child.kill).toHaveBeenCalledWith("SIGTERM")
    expect(child.kill).toHaveBeenCalledWith("SIGKILL")
  })
})
