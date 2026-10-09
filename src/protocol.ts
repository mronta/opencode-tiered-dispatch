import type { EnabledRouterOptions } from "./options.js"
import { mergeTaxonomy } from "./taxonomy.js"
import { TIER_NAMES } from "./tiers.js"

export function buildRoutingProtocol(options: EnabledRouterOptions): string {
  const taxonomy = mergeTaxonomy(options.taxonomy)
  const directRule = options.directThreshold === "never"
    ? "Delegate every executable task, including trivial work."
    : "Trivial ≤1 tool/no follow-up→direct; edit+verification→medium always."

  const tierLine = `R: ${TIER_NAMES.map((tier) => `${tier}→${taxonomy[tier].join("/")}`).join(" ")}`

  return [
    "## Tiered Dispatch Protocol — MANDATORY",
    "Classify→decompose→delegate→integrate→answer; primary orchestrates; tiers execute; gathering executes.",
    tierLine,
    "Fast read/glob/grep/webfetch/websearch only, no shell; file/search/docs→fast; shell read-only git status/diff/log/show/rev-parse/merge-base→medium; edits/tests/build/config→medium; architecture/security/perf/RCA→heavy.",
    "Before dispatch, match tier permissions; report actual missing tools; never repeat impossible assignments. Review: collect git baseline/status/diff/log/show once; share with review children; no repeated repository discovery.",
    directRule,
    "Nontrivial→first tool MUST be native `subagent`; no direct reads/edits/broad analysis. Heavy=difficult/high risk/repeated failures, not size.",
    "Split: missing context + edits→fast then medium; missing context + difficult analysis→fast then heavy; known scope→one delegation; no ceremony/discovery-only. After fast, execute. Reuse same child for execution follow-ups.",
    "Batch related discovery→fast; pass findings, paths and unresolved questions; integrate returned evidence.",
    "Parallelize independent; serialize dependent phases and overlapping edits.",
    "NEED CONTEXT / SCOPE GROWTH→focused fast; then medium/heavy; no automatic escalation/fallback.",
    "agent fast|medium|heavy; prompt: goal, paths/scope, constraints, verification, expected result. No per-call model override.",
    "Root ONLY requested root verification ONCE; children may run tests; read/search, not arbitrary shell.",
    "Verify; own outcome.",
  ].join("\n")
}
