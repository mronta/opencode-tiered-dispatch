export const TIER_NAMES = ["fast", "medium", "heavy"] as const

export type TierName = (typeof TIER_NAMES)[number]
