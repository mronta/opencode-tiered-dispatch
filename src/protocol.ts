import type { EnabledRouterOptions } from "./options.js"
import { mergeTaxonomy } from "./taxonomy.js"
import { TIER_NAMES } from "./tiers.js"

export function buildRoutingProtocol(options: EnabledRouterOptions): string {
  const taxonomy = mergeTaxonomy(options.taxonomy)
  const directRule = options.directThreshold === "never"
    ? "Delegate every executable task, including trivial work."
    : "Trivial (one step, no expected follow-up)→direct when delegation costs more."

  const tierLines = TIER_NAMES.map((tier) => `- ${tier}: ${taxonomy[tier].join("; ")}`)

  return [
    "## Tiered Dispatch Protocol",
    "Orchestrate: classify, decompose, delegate, integrate, answer. Discovery is execution, not orchestration.",
    ...tierLines,
    directRule,
    "Nontrivial→delegate cheapest adequate tier BEFORE execution; do not implement or perform broad analysis yourself. Heavy is for difficult judgment/high risk/repeated debugging failures, not task size.",
    "Split: missing context + edits→fast then medium; missing context + difficult analysis→fast then heavy; known scope→one delegation, no ceremonial discovery.",
    "Examples: trace auth then refactor→fast→medium; map trust boundaries then assess security→fast→heavy; supplied patch scope→medium.",
    "Batch related discovery. Pass findings, paths and unresolved questions forward; do not repeat broad exploration. At most two direct read-only discovery calls; more→fast.",
    "Parallelize independent work; serialize phases with dependencies and serialize overlapping edits.",
    "Handoff: NEED CONTEXT / SCOPE GROWTH→inspect missing evidence, send a focused fast request, then resume medium/heavy with findings. No automatic escalation or fallback.",
    "Use native `subagent` with agent `fast`, `medium` or `heavy`, short description and self-contained prompt: goal, paths/scope, constraints, verification, expected result. No per-call model override.",
    "Integrate results, check verification, answer; you own the outcome.",
  ].join("\n")
}
