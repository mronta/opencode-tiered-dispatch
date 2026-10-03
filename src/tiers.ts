import { readFileSync } from "node:fs"
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

const TIER_CONFIG_FIELDS = new Set(["model", "variant"])

export const REQUIRED_TIER_MODELS: Record<TierName, RequiredTierModel> = loadRequiredTierModels()

function loadRequiredTierModels(): Record<TierName, RequiredTierModel> {
  let value: unknown
  try {
    value = JSON.parse(readFileSync(new URL("../tiers.json", import.meta.url), "utf8"))
  } catch (error) {
    throw new ConfigurationError("could not load packaged tiers.json", { cause: error })
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ConfigurationError("tiers.json must contain an object")
  }

  const input = value as Record<string, unknown>
  const unknownTiers = Object.keys(input).filter((tier) => !TIER_NAMES.includes(tier as TierName))
  if (unknownTiers.length > 0) {
    throw new ConfigurationError(`tiers.json contains unknown tier${unknownTiers.length === 1 ? "" : "s"}: ${unknownTiers.join(", ")}`)
  }

  const output = {} as Record<TierName, RequiredTierModel>
  for (const tier of TIER_NAMES) {
    const entry = input[tier]
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new ConfigurationError(`tiers.json.${tier} must be an object`)
    }
    const config = entry as Record<string, unknown>
    const unknownFields = Object.keys(config).filter((field) => !TIER_CONFIG_FIELDS.has(field))
    if (unknownFields.length > 0) {
      throw new ConfigurationError(`tiers.json.${tier} contains unknown field${unknownFields.length === 1 ? "" : "s"}: ${unknownFields.join(", ")}`)
    }
    if (typeof config.model !== "string" || config.model.trim() === "") {
      throw new ConfigurationError(`tiers.json.${tier}.model must be a non-empty string`)
    }
    if (config.variant !== undefined && (typeof config.variant !== "string" || config.variant.trim() === "")) {
      throw new ConfigurationError(`tiers.json.${tier}.variant must be a non-empty string when provided`)
    }
    output[tier] = {
      model: config.model.trim(),
      ...(config.variant === undefined ? {} : { variant: config.variant.trim() }),
    }
  }
  return output
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
