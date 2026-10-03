import { isTierName } from "./tiers.js"

export function tierModelOverrideError(input: unknown): string | undefined {
  if (!isRecord(input) || !isTierName(input.agent)) return undefined
  if (typeof input.model !== "string" || input.model.trim() === "") return undefined

  return `Tier agent ${input.agent} owns its model configuration; omit the subagent model override and choose a different tier when you need a different model`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
