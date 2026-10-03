import { ConfigurationError } from "./errors.js"
import { assertRequiredTierModel, TIER_NAMES, type TierName } from "./tiers.js"

export interface ModelReference {
  providerID: string
  id: string
}

export interface TierOptions {
  model: string
  modelRef: ModelReference
  variant?: string
  instructions?: string
}

export interface EnabledRouterOptions {
  enabled: true
  tiers: Record<TierName, TierOptions>
  taxonomy: Partial<Record<TierName, string[]>>
  directThreshold: "never" | "trivial"
  logging: boolean
}

export interface DisabledRouterOptions {
  enabled: false
}

export type RouterOptions = EnabledRouterOptions | DisabledRouterOptions

const TOP_LEVEL_FIELDS = new Set(["enabled", "tiers", "taxonomy", "directThreshold", "logging"])
const TIER_FIELDS = new Set(["model", "variant", "instructions"])

function objectAt(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ConfigurationError(`${path} must be an object`)
  }
  return value as Record<string, unknown>
}

function rejectUnknownFields(value: Record<string, unknown>, allowed: Set<string>, path: string): void {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key))
  if (unknown.length > 0) {
    throw new ConfigurationError(`${path} contains unknown field${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}`)
  }
}

function nonEmptyString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ConfigurationError(`${path} must be a non-empty string`)
  }
  return value.trim()
}

export function parseModelReference(value: string, path = "model"): ModelReference {
  const separator = value.indexOf("/")
  if (separator <= 0 || separator === value.length - 1) {
    throw new ConfigurationError(`${path} must use the form provider/model`)
  }
  const providerID = value.slice(0, separator).trim()
  const id = value.slice(separator + 1).trim()
  if (!providerID || !id) {
    throw new ConfigurationError(`${path} must use the form provider/model`)
  }
  return { providerID, id }
}

function parseTier(value: unknown, tier: TierName, enforceRequiredModel = true): TierOptions {
  const path = `options.tiers.${tier}`
  const input = objectAt(value, path)
  rejectUnknownFields(input, TIER_FIELDS, path)
  const model = nonEmptyString(input.model, `${path}.model`)
  const variant = input.variant === undefined ? undefined : nonEmptyString(input.variant, `${path}.variant`)
  const instructions = input.instructions === undefined
    ? undefined
    : nonEmptyString(input.instructions, `${path}.instructions`)
  if (enforceRequiredModel) {
    assertRequiredTierModel(tier, model, variant, path)
  }
  return {
    model,
    modelRef: parseModelReference(model, `${path}.model`),
    ...(variant === undefined ? {} : { variant }),
    ...(instructions === undefined ? {} : { instructions }),
  }
}

function validateOptionalTiers(value: unknown): void {
  if (value === undefined) return
  const input = objectAt(value, "options.tiers")
  rejectUnknownFields(input, new Set(TIER_NAMES), "options.tiers")
  for (const tier of TIER_NAMES) {
    if (input[tier] !== undefined) parseTier(input[tier], tier, false)
  }
}

function parseTaxonomy(value: unknown): Partial<Record<TierName, string[]>> {
  if (value === undefined) return {}
  const input = objectAt(value, "options.taxonomy")
  rejectUnknownFields(input, new Set(TIER_NAMES), "options.taxonomy")
  const output: Partial<Record<TierName, string[]>> = {}
  for (const tier of TIER_NAMES) {
    const entries = input[tier]
    if (entries === undefined) continue
    if (!Array.isArray(entries)) {
      throw new ConfigurationError(`options.taxonomy.${tier} must be an array of strings`)
    }
    output[tier] = entries.map((entry, index) =>
      nonEmptyString(entry, `options.taxonomy.${tier}[${index}]`),
    )
  }
  return output
}

export function parseOptions(value: unknown): RouterOptions {
  const input = objectAt(value ?? {}, "options")
  rejectUnknownFields(input, TOP_LEVEL_FIELDS, "options")

  if (input.enabled !== undefined && typeof input.enabled !== "boolean") {
    throw new ConfigurationError("options.enabled must be a boolean")
  }

  const directThreshold = input.directThreshold ?? "trivial"
  if (directThreshold !== "never" && directThreshold !== "trivial") {
    throw new ConfigurationError('options.directThreshold must be "never" or "trivial"')
  }
  if (input.logging !== undefined && typeof input.logging !== "boolean") {
    throw new ConfigurationError("options.logging must be a boolean")
  }
  const taxonomy = parseTaxonomy(input.taxonomy)

  if (input.enabled === false) {
    validateOptionalTiers(input.tiers)
    return { enabled: false }
  }

  const tiersInput = objectAt(input.tiers, "options.tiers")
  rejectUnknownFields(tiersInput, new Set(TIER_NAMES), "options.tiers")

  return {
    enabled: true,
    tiers: {
      fast: parseTier(tiersInput.fast, "fast"),
      medium: parseTier(tiersInput.medium, "medium"),
      heavy: parseTier(tiersInput.heavy, "heavy"),
    },
    taxonomy,
    directThreshold,
    logging: input.logging ?? false,
  }
}
