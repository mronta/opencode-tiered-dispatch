import { describe, expect, it } from "vitest"
import { assertAgentsAvailable, assertModelsAvailable, type AgentCatalogEntry } from "../src/catalog.js"
import { parseOptions } from "../src/options.js"
import { modelCatalog, defaultTierOptions, tierModel } from "./tier-fixtures.js"

const parsed = parseOptions({
  tiers: defaultTierOptions(),
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
  it("accepts available models and matching agents", () => {
    expect(() => assertModelsAvailable(parsed, models)).not.toThrow()
    expect(() => assertAgentsAvailable([
      { id: "build", mode: "primary" },
      { id: "fast", mode: "subagent" },
      { id: "medium", mode: "subagent" },
      { id: "heavy", mode: "subagent" },
    ])).not.toThrow()
    expect(() => assertAgentsAvailable(agents, parsed)).not.toThrow()
  })

  it("normalizes the provider-default variant only when configuration omits it", () => {
    const custom = parseOptions({ tiers: { fast: { model: "provider/custom-fast" } } })
    if (!custom.enabled) throw new Error("test setup")
    const providerDefault = structuredClone(agents) as AgentCatalogEntry[]
    providerDefault[0]!.model = {
      providerID: "provider",
      id: "custom-fast",
      variant: "default",
    }
    expect(() => assertAgentsAvailable(providerDefault, custom)).not.toThrow()

    const explicit = structuredClone(agents) as AgentCatalogEntry[]
    explicit[0]!.model = { ...tierModel("fast"), variant: "default" }
    expect(() => assertAgentsAvailable(explicit, parsed)).toThrow(/model does not match/)
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
    expect(() => assertModelsAvailable(invalid, models)).toThrow(/variant max is unavailable/)
  })

  it("accepts custom mappings when the active catalog satisfies them", () => {
    const custom = parseOptions({
      tiers: {
        fast: { model: "provider/custom-fast", variant: "deliberate" },
        medium: { model: "provider/custom-medium" },
        heavy: { variant: "careful" },
      },
    })
    if (!custom.enabled) throw new Error("test setup")
    const heavyDefault = tierModel("heavy")
    const customModels = [
      {
        providerID: "provider",
        id: "custom-fast",
        enabled: true,
        capabilities: { tools: true },
        variants: [{ id: "deliberate" }],
      },
      {
        providerID: "provider",
        id: "custom-medium",
        enabled: true,
        capabilities: { tools: true },
        variants: [],
      },
      {
        providerID: heavyDefault.providerID,
        id: heavyDefault.id,
        enabled: true,
        capabilities: { tools: true },
        variants: [{ id: "careful" }],
      },
    ]

    expect(() => assertModelsAvailable(custom, customModels)).not.toThrow()
  })

  it("rejects unavailable, disabled, and non-tool-capable configured models", () => {
    const custom = parseOptions({ tiers: { fast: { model: "provider/custom" } } })
    if (!custom.enabled) throw new Error("test setup")
    const unavailable = structuredClone(models)
    expect(() => assertModelsAvailable(custom, unavailable)).toThrow(/provider\/custom is not in the active model catalog/)

    const disabled = [
      {
        providerID: "provider",
        id: "custom",
        enabled: false,
        capabilities: { tools: true },
        variants: [],
      },
    ]
    expect(() => assertModelsAvailable(custom, disabled)).toThrow(/provider\/custom is disabled/)

    const noTools = [{
      providerID: "provider",
      id: "custom",
      enabled: true,
      capabilities: { tools: false },
      variants: [],
    }]
    expect(() => assertModelsAvailable(custom, noTools)).toThrow(/provider\/custom does not support tools/)
  })

  it("rejects models without tools", () => {
    const invalid = structuredClone(models)
    invalid[0]!.capabilities.tools = false
    expect(() => assertModelsAvailable(parsed, invalid)).toThrow(/does not support tools/)
  })
})
