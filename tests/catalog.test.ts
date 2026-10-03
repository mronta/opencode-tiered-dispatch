import { describe, expect, it } from "vitest"
import { assertAgentsAvailable, assertModelsAvailable, type AgentCatalogEntry } from "../src/catalog.js"
import { parseOptions } from "../src/options.js"
import { modelCatalog, requiredTierOptions, tierModel } from "./tier-fixtures.js"

const parsed = parseOptions({
  tiers: requiredTierOptions(),
})
if (!parsed.enabled) throw new Error("test setup")

const models = modelCatalog()

const agents = [
  {
    id: "fast",
    mode: "subagent",
    model: tierModel("fast"),
    permissions: [
      { action: "*", resource: "*", effect: "deny" as const },
      { action: "read", resource: "*", effect: "allow" as const },
      { action: "subagent", resource: "*", effect: "deny" as const },
    ],
  },
  {
    id: "medium",
    mode: "subagent",
    model: tierModel("medium"),
    permissions: [
      { action: "*", resource: "*", effect: "allow" as const },
      { action: "subagent", resource: "*", effect: "deny" as const },
    ],
  },
  {
    id: "heavy",
    mode: "subagent",
    model: tierModel("heavy"),
    permissions: [
      { action: "*", resource: "*", effect: "allow" as const },
      { action: "subagent", resource: "*", effect: "deny" as const },
    ],
  },
]

describe("catalog validation", () => {
  it("accepts available models and required agents", () => {
    expect(() => assertModelsAvailable(parsed, models)).not.toThrow()
    expect(() => assertAgentsAvailable([
      { id: "build", mode: "primary" },
      { id: "fast", mode: "subagent" },
      { id: "medium", mode: "subagent" },
      { id: "heavy", mode: "subagent" },
    ])).not.toThrow()
    expect(() => assertAgentsAvailable(agents, parsed)).not.toThrow()

    const nativeDefault = structuredClone(agents) as AgentCatalogEntry[]
    nativeDefault[0]!.model = { ...tierModel("fast"), variant: "default" }
    expect(() => assertAgentsAvailable(nativeDefault, parsed)).toThrow(/model does not match/)
  })

  it("rejects a native tier whose model or recursion guard does not match", () => {
    const invalid = structuredClone(agents)
    invalid[0]!.model.id = "other"
    expect(() => assertAgentsAvailable(invalid, parsed)).toThrow(/model does not match/)

    const withoutGuard = structuredClone(agents)
    withoutGuard[1]!.permissions = [{ action: "*", resource: "*", effect: "allow" }]
    expect(() => assertAgentsAvailable(withoutGuard, parsed)).toThrow(/must deny the subagent permission/)

    const resourceBypass = structuredClone(agents) as AgentCatalogEntry[]
    resourceBypass[1]!.permissions = [
      ...(resourceBypass[1]!.permissions ?? []),
      { action: "subagent", resource: "heavy", effect: "allow" },
    ]
    expect(() => assertAgentsAvailable(resourceBypass, parsed)).toThrow(/enable subagent recursion/)

    const noImplementation = structuredClone(agents) as AgentCatalogEntry[]
    noImplementation[1]!.permissions = [
      { action: "*", resource: "*", effect: "deny" },
      { action: "subagent", resource: "*", effect: "deny" },
    ]
    expect(() => assertAgentsAvailable(noImplementation, parsed)).toThrow(/must allow the edit permission/)
  })

  it("rejects fast permissions that allow mutation after the deny-all rule", () => {
    const invalid = structuredClone(agents)
    invalid[0]!.permissions.push({ action: "edit", resource: "*", effect: "allow" })
    expect(() => assertAgentsAvailable(invalid, parsed)).toThrow(/non-read action/)

    const approval = structuredClone(agents) as AgentCatalogEntry[]
    approval[0]!.permissions = [
      ...(approval[0]!.permissions ?? []),
      { action: "edit", resource: "*", effect: "ask" },
    ]
    expect(() => assertAgentsAvailable(approval, parsed)).toThrow(/non-read action/)
  })

  it("rejects an unavailable variant", () => {
    const invalid = structuredClone(parsed)
    invalid.tiers.fast.variant = "max"
    expect(() => assertModelsAvailable(invalid, models)).toThrow(/must use model/)
  })

  it("rejects models without tools", () => {
    const invalid = structuredClone(models)
    invalid[0]!.capabilities.tools = false
    expect(() => assertModelsAvailable(parsed, invalid)).toThrow(/does not support tools/)
  })
})
