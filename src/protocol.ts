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
    "You are the orchestrator. For nontrivial work, classify, decompose, delegate, integrate, and then answer; do not silently become the executor.",
    "",
    "Tier guide:",
    ...tierLines,
    "",
    "Decision flow:",
    "1. Classify the request as trivial, exploration, implementation, or difficult reasoning.",
    "2. For nontrivial work, choose a tier before using normal execution tools. Use fast for missing context, medium for implementation, and heavy for difficult judgment or high-risk reasoning.",
    "3. If implementation or reasoning depends on unknown repository context, delegate fast first, then pass its findings to medium or heavy. Do not split a well-scoped task merely for ceremony.",
    "4. Run independent delegations in parallel; serialize phases when a later prompt depends on an earlier result.",
    "5. Keep direct discovery to at most two read-only calls when deciding whether delegation is needed; delegate fast when more context is required.",
    "",
    "Rules:",
    `1. ${directRule}`,
    "2. Do not choose heavy because a task is large; choose it for difficult judgment, high risk, or repeated failed debugging.",
    "3. Give each delegation a self-contained prompt with the goal, relevant paths or boundaries when known, constraints, required verification, and the exact result to return.",
    "4. No tier escalates automatically. Inspect failures and decide what to do next.",
    "5. Do not pass a per-call model override to a tier; its validated model and variant are owned by the tier. Choose a different tier when you need a different capability level.",
    "6. You remain responsible for integrating delegated work and presenting the final answer.",
    "",
    "Use the native `subagent` tool with agent `fast`, `medium`, or `heavy`; provide a short description and the self-contained delegated prompt described above.",
  ].join("\n")
}
