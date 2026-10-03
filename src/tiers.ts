import { ConfigurationError } from "./errors.js"

export const TIER_NAMES = ["fast", "medium", "heavy"] as const

export type TierName = (typeof TIER_NAMES)[number]

export function isTierName(value: unknown): value is TierName {
  return typeof value === "string" && (TIER_NAMES as readonly string[]).includes(value)
}

export interface RequiredTierModel {
  model: string
  variant?: string
}

export const REQUIRED_TIER_MODELS: Record<TierName, RequiredTierModel> = {
  fast: { model: "openai/gpt-6-luna", variant: "medium" },
  medium: { model: "openai/gpt-5.6-luna", variant: "max" },
  heavy: { model: "openai/gpt-5.6-sol", variant: "medium" },
}

export function assertRequiredTierModel(
  tier: TierName,
  model: string,
  variant: string | undefined,
  path = `options.tiers.${tier}`,
): void {
  const required = REQUIRED_TIER_MODELS[tier]
  if (model === required.model && variant === required.variant) return
  const requiredReference = required.variant === undefined
    ? required.model
    : `${required.model}#${required.variant}`
  throw new ConfigurationError(`${path} must use model ${requiredReference}`)
}
