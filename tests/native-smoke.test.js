import { EventEmitter } from "node:events"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it, vi } from "vitest"
import {
  fetchJsonWithDeadline,
  fetchWithDeadline,
  waitForDeadline,
} from "../scripts/native-http.mjs"
import {
  buildNativePluginEntry,
  NATIVE_PLAN_POLICY_RULES,
  NATIVE_PLAN_SAFE_TOOLS,
  effectiveNativePermission,
  parseNativeOptions,
  readNativeTierMapping,
  resolveNativeTierOptions,
  serializeNativeTierModels,
  verifyNativePlanEvidence,
} from "../scripts/opencode-native-smoke.mjs"
import { parseOptions } from "../src/options.js"
import { DEFAULT_TIER_MODELS } from "../src/tiers.js"

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

describe("native smoke custom tier mapping", () => {
  it("uses the runtime parser and preserves custom model variant semantics", () => {
    const directory = mkdtempSync(join("/tmp", "native-smoke-tier-mapping-"))
    const filename = join(directory, "tiers.json")
    const mapping = {
      fast: { model: "provider/custom-fast", variant: "deliberate" },
      medium: { model: "provider/custom-medium" },
    }
    writeFileSync(filename, JSON.stringify(mapping))
    try {
      expect(parseNativeOptions(["--tiers", filename]).tiers).toBe(filename)
      const supplied = readNativeTierMapping(filename)
      const resolved = resolveNativeTierOptions(supplied, parseOptions)
      const effective = serializeNativeTierModels(resolved)

      expect(effective).toMatchObject({
        fast: { model: "provider/custom-fast", variant: "deliberate" },
        medium: { model: "provider/custom-medium" },
        heavy: DEFAULT_TIER_MODELS.heavy,
      })
      expect(effective.medium).not.toHaveProperty("variant")
      expect(buildNativePluginEntry("/checkout", { tiers: supplied })).toEqual({
        package: "/checkout",
        options: { tiers: mapping },
      })
      expect(buildNativePluginEntry("/checkout", {
        routingEval: true,
        arm: "direct",
        tiers: supplied,
      })).toEqual({
        package: "/checkout",
        options: { enabled: false, tiers: mapping },
      })
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it("retains omitted, instructions-only, and variant-only mappings", () => {
    const resolved = resolveNativeTierOptions({
      medium: { instructions: "Keep the patch small" },
      heavy: { variant: "careful" },
    }, parseOptions)
    const effective = serializeNativeTierModels(resolved)

    expect(effective.fast).toEqual(DEFAULT_TIER_MODELS.fast)
    expect(effective.medium).toEqual({
      ...DEFAULT_TIER_MODELS.medium,
      instructions: "Keep the patch small",
    })
    expect(effective.heavy).toEqual({
      model: DEFAULT_TIER_MODELS.heavy.model,
      variant: "careful",
    })
  })

  it("rejects missing files, malformed JSON, and invalid tier fields", () => {
    expect(() => readNativeTierMapping("/tmp/native-smoke-tiers-does-not-exist.json"))
      .toThrow(/could not read --tiers file/u)

    const directory = mkdtempSync(join("/tmp", "native-smoke-invalid-tiers-"))
    const malformed = join(directory, "malformed.json")
    const array = join(directory, "array.json")
    writeFileSync(malformed, "not json")
    writeFileSync(array, "[]")
    try {
      expect(() => readNativeTierMapping(malformed)).toThrow(/could not parse --tiers file/u)
      expect(() => readNativeTierMapping(array)).toThrow(/must contain a JSON object/u)
      expect(() => resolveNativeTierOptions({ fast: { cost: 1 } }, parseOptions))
        .toThrow(/invalid --tiers mapping: options\.tiers\.fast contains unknown field/u)
      expect(() => parseNativeOptions(["--tiers"])).toThrow(/requires a value/u)
      expect(() => parseNativeOptions(["--tiers", "--routing-eval"])).toThrow(/requires a value/u)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
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
