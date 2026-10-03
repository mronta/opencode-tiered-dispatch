import type { EnabledRouterOptions } from "./options.js"
import { mergeTaxonomy } from "./taxonomy.js"
import { TIER_NAMES } from "./tiers.js"

export function buildRoutingProtocol(options: EnabledRouterOptions): string {
  const taxonomy = mergeTaxonomy(options.taxonomy)
  const directRule = options.directThreshold === "never"
    ? "Delegate every executable task, including trivial work."
    : "Trivial (≤1 tool call, no expected follow-up)→direct; edit+verification→medium even when scope is known."

  const tierLine = `R: ${TIER_NAMES.map((tier) => `${tier}→${taxonomy[tier].join("/")}`).join(" ")}`

  return [
    "## Tiered Dispatch Protocol — MANDATORY",
    "Role: primary orchestrates; tiers execute. Classify→decompose→delegate→integrate→answer. Information gathering is execution.",
    tierLine,
    "Hard route: read/search/docs→fast; edit/write/tests/build/config→medium; architecture/security/perf/RCA→heavy.",
    directRule,
    "Nontrivial→first tool MUST be native `subagent`; no direct reads/edits/broad analysis. Heavy=difficult judgment/high risk/repeated debugging failures, not task size.",
    "Split: missing context + edits→fast then medium; missing context + difficult analysis→fast then heavy; known scope→one delegation; no ceremonial discovery. After fast, execute; stop only for discovery-only requests.",
    "Batch related discovery in one fast request; pass findings, paths and unresolved questions; no broad repeat.",
    "Parallelize independent work; serialize dependent phases and overlapping edits.",
    "Handoff: NEED CONTEXT / SCOPE GROWTH→focused fast request, then resume medium/heavy; no automatic escalation/fallback.",
    "Native `subagent`, agent fast|medium|heavy; prompt: goal, paths/scope, constraints, verification, expected result. No per-call model override.",
    "Integrate, verify, answer; you own the outcome.",
  ].join("\n")
}
