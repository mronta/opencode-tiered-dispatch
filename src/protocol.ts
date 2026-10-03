import type { EnabledRouterOptions } from "./options.js"
import { mergeTaxonomy } from "./taxonomy.js"
import { TIER_NAMES } from "./tiers.js"

export function buildRoutingProtocol(options: EnabledRouterOptions): string {
  const taxonomy = mergeTaxonomy(options.taxonomy)
  const directRule = options.directThreshold === "never"
    ? "Delegate every executable task; do not bypass dispatch merely because it looks trivial."
    : "Handle truly trivial one-step work directly when delegation would cost more than the work."

  const tierLines = TIER_NAMES.map((tier) => `- ${tier}: ${taxonomy[tier].join("; ")}`)

  return [
    "## Tiered Dispatch Protocol",
    "You are the orchestrator. Use the cheapest model tier likely to complete each task reliably.",
    "",
    "Tier guide:",
    ...tierLines,
    "",
    "Rules:",
    `1. ${directRule}`,
    "2. Split separable work: collect context with fast, then implement with medium or reason with heavy.",
    "3. Do not choose heavy because a task is large; choose it for difficult judgment, high risk, or repeated failed debugging.",
    "4. Give each delegation a narrow prompt and an explicit expected result.",
    "5. Serialize medium/heavy delegations that may edit overlapping files. Parallelize only independent work.",
    "6. No tier escalates automatically. Inspect failures and decide what to do next.",
    "7. You remain responsible for integrating delegated work and presenting the final answer.",
    "",
    "Call tiered_dispatch with tier, a short description, and the complete delegated prompt.",
  ].join("\n")
}
