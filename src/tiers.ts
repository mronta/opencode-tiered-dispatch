export const TIER_NAMES = ["fast", "medium", "heavy"] as const

export type TierName = (typeof TIER_NAMES)[number]

export const TIER_AGENTS: Record<TierName, "explore" | "general"> = {
  fast: "explore",
  medium: "general",
  heavy: "general",
}

export const DEFAULT_TIER_INSTRUCTIONS: Record<TierName, string> = {
  fast: [
    "Act as a focused, read-only investigator.",
    "Search only as far as needed to answer the delegated question.",
    "Return concrete findings with file paths, line references, and a concise conclusion.",
    "Do not edit files, run mutating commands, or delegate further.",
  ].join(" "),
  medium: [
    "Act as an implementation specialist.",
    "Match existing project patterns, make the requested changes, and run targeted verification.",
    "Report files changed, key decisions, and verification results.",
    "Do not delegate further; return if the task needs an architectural decision.",
  ].join(" "),
  heavy: [
    "Act as a senior architecture and difficult-debugging specialist.",
    "Analyze evidence carefully, state trade-offs, and give a concrete recommendation or requested implementation.",
    "Do not delegate further; identify missing evidence explicitly instead of inventing it.",
  ].join(" "),
}
