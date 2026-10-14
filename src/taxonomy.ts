import type { TierName } from "./tiers.js"

export const DEFAULT_TAXONOMY: Record<TierName, readonly string[]> = {
  fast: [
    "search/grep",
    "file reads",
    "docs/research",
    "file/search repository mapping",
  ],
  medium: [
    "implementation",
    "tests/bug fixes",
    "review/config",
    "build",
  ],
  heavy: [
    "architecture/trade-offs",
    "security",
    "difficult RCA/repeated failures",
    "performance/high-risk",
  ],
}

export function mergeTaxonomy(
  additions: Partial<Record<TierName, readonly string[]>>,
): Record<TierName, string[]> {
  return {
    fast: mergeEntries(DEFAULT_TAXONOMY.fast, additions.fast),
    medium: mergeEntries(DEFAULT_TAXONOMY.medium, additions.medium),
    heavy: mergeEntries(DEFAULT_TAXONOMY.heavy, additions.heavy),
  }
}

function mergeEntries(defaults: readonly string[], additions: readonly string[] | undefined): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const raw of [...defaults, ...(additions ?? [])]) {
    const value = raw.trim()
    const key = value.toLocaleLowerCase()
    if (!value || seen.has(key)) continue
    seen.add(key)
    result.push(value)
  }
  return result
}
