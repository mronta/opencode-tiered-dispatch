import type { ModelCatalogEntry } from "../src/catalog.js"
import { modelSelection } from "../src/options.js"
import { DEFAULT_TIER_MODELS, TIER_NAMES, type DefaultTierModel, type TierName } from "../src/tiers.js"

export function defaultTierOptions(): Record<TierName, DefaultTierModel> {
  return Object.fromEntries(
    TIER_NAMES.map((tier) => [tier, { ...DEFAULT_TIER_MODELS[tier] }]),
  ) as Record<TierName, DefaultTierModel>
}

export function tierModel(tier: TierName) {
  const configured = DEFAULT_TIER_MODELS[tier]
  return modelSelection(configured.model, configured.variant)
}

export function modelCatalog(): ModelCatalogEntry[] {
  return TIER_NAMES.map((tier) => {
    const configured = DEFAULT_TIER_MODELS[tier]
    return {
      ...tierModel(tier),
      enabled: true,
      capabilities: { tools: true },
      variants: configured.variant === undefined ? [] : [{ id: configured.variant }],
    }
  })
}

export function customTierOptions(fastVariant = "deliberate") {
  return {
    fast: { model: "provider/custom-fast", variant: fastVariant },
    medium: { model: "provider/custom-medium" },
    heavy: { variant: "careful" },
  }
}

export function customModelCatalog(fastVariant = "deliberate"): ModelCatalogEntry[] {
  const heavyDefault = tierModel("heavy")
  return [
    {
      providerID: "provider",
      id: "custom-fast",
      enabled: true,
      capabilities: { tools: true },
      variants: [{ id: fastVariant }],
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
}
