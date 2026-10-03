import type { ModelCatalogEntry } from "../src/catalog.js"
import { modelSelection } from "../src/options.js"
import { REQUIRED_TIER_MODELS, TIER_NAMES, type RequiredTierModel, type TierName } from "../src/tiers.js"

export function requiredTierOptions(): Record<TierName, RequiredTierModel> {
  return Object.fromEntries(
    TIER_NAMES.map((tier) => [tier, { ...REQUIRED_TIER_MODELS[tier] }]),
  ) as Record<TierName, RequiredTierModel>
}

export function tierModel(tier: TierName) {
  const configured = REQUIRED_TIER_MODELS[tier]
  return modelSelection(configured.model, configured.variant)
}

export function modelCatalog(): ModelCatalogEntry[] {
  return TIER_NAMES.map((tier) => {
    const configured = REQUIRED_TIER_MODELS[tier]
    return {
      ...tierModel(tier),
      enabled: true,
      capabilities: { tools: true },
      variants: configured.variant === undefined ? [] : [{ id: configured.variant }],
    }
  })
}
