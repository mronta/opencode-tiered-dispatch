import type { TierName } from "./tiers.js"

export const DEFAULT_TAXONOMY: Record<TierName, readonly string[]> = {
  fast: [
    "search and grep",
    "file discovery and focused reads",
    "documentation lookup and web research",
    "fact collection and repository mapping",
  ],
  medium: [
    "implementation and refactoring",
    "tests and ordinary bug fixes",
    "code review and configuration changes",
    "build fixes",
  ],
  heavy: [
    "architecture and cross-system trade-offs",
    "security analysis",
    "difficult root-cause analysis after repeated failures",
    "performance strategy and high-risk reasoning",
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
