# Benchmarking

Benchmarking is optional and provider-consuming. It is not needed for a first
local setup. The runner compares a tiered arm with a direct control using the
same four fixture scenarios and writes a generated JSON artifact; no artifact
is shipped with this checkout.

## Run it

The package script builds once, then starts a fresh native process for each arm:

```bash
npm run benchmark:routing -- --runs 1 \
  --output /tmp/opencode/routing-benchmark.json
```

`--runs 1` is a smoke comparison. Use at least `10` repetitions for meaningful
tail quantiles:

```bash
npm run benchmark:routing -- --runs 10 \
  --output /tmp/opencode/routing-benchmark.json
```

The output path is only an example for generated local output. The benchmark
does not require a root-model flag for first use. The current runner uses the
`medium` model as the root for both arms. That makes the comparison useful for
matched behavior and overhead, but it does **not** measure the economics of a
powerful primary orchestrating the configured tiers. A single run, and a run
whose provider reports zero cost, cannot support a cost or savings conclusion.

## Matched method

For each repetition, the runner executes:

1. `tiered`, then `direct`;
2. `direct`, then `tiered`.

The order alternates between repetitions, provider calls never run in parallel,
and a failed arm is not retried. Both arms receive the same four prompts:

- `trivial`: one-step arithmetic;
- `known-scope`: a specified edit and exact test using one fresh `medium`
  execution child; an explicit verified continuation may reuse that same child,
  but two fresh `medium` children fail policy;
- `discover-implement`: discovery, blank/over-limit implementation,
  meaningful regression tests, and `npm test`;
- `discover-analyze`: authentication-boundary discovery and security analysis.

The direct control explicitly disables the plugin, denies the root `build`
agent's `subagent` permission, and uses an independent observer that hides that
tool as a final guard. This is a deliberate direct-completion control, not a
claim that native permissions prevent an ordinary root implementation.
Unrelated global configuration and provider state remain host-level caveats.

Each arm gets a fresh foreground process. The generated artifact records the
arm, repetition, root and tier model references, host version when available,
startup time, scenario reports, raw results/traces, errors, and completion
counts. Failed artifacts are retained before temporary evaluator cleanup. The
summary distinguishes requested repetitions, arm attempts, completed and
failed attempts, attempted pairs, and pairs where both arms completed. It
measures startup, scenario execution, verifier time, harness overhead, and
total time separately.

The native evaluator's default per-process deadline is `600000` ms and spans
startup, HTTP response bodies, observer work, and result arrival. A focused
evaluation can override it with `--timeout-ms`; the benchmark command itself
passes the default to each fresh native process.

## Verification and quality fields

The evaluator verifies root outcomes and contexts, complete tool identity
tuples and successful completions, fixture behavior and isolation, and exactly
four scenario results for each arm. The tiered arm verifies the expected route,
first-delegation policy, child linkage, handoff evidence, and exact fixture
verification commands. The direct arm bypasses tier-route and primary
orchestration-policy checks except for the no-child rule and the trivial
one-tool check.

Handoff evidence requires discovered paths in the first fresh execution prompt;
an explicit successfully linked continuation of that same child retains context
and need not repeat them. A second fresh execution still requires the paths,
even when route validation separately rejects the extra dispatch. The root may
run the declared fixture verification only once, after the final execution.

Fixture snapshot evidence is confined to paths under the contained fixture root;
the separate verifier-control directory has its own before/after snapshot. A
malformed child completion or a missing child execution context fails closed
before fixture verification/reset; observer cleanup removes all context
children before teardown. Any malformed linkage fails the whole batch. Any
verifier-control tamper is an evidence failure, even when the task itself
appears successful. For
`discover-implement`, meaningful regression evidence must cover both trimmed
blank and trimmed over-limit inputs; an old-implementation mutant/negative
control is useful evidence, while asynchronous observations should wait until
visible or state the invariant being checked.

Task completion and policy compliance are separate dimensions. A report can
contain:

```json
{
  "status": "failed",
  "taskSuccess": true,
  "policySuccess": false,
  "evidenceValid": true,
  "taskProblems": [],
  "policyProblems": ["..."],
  "evidenceProblems": []
}
```

Unknown primary verification commands are policy failures even when the
fixture task itself completed. A shell verification command must be the exact
scenario-declared command, run in the fixture workspace, after the relevant
delegation for a tiered arm, and return the native completion shape:

```json
{
  "output": "...",
  "truncated": false,
  "status": "completed",
  "exit": 0
}
```

Before/after snapshot evidence must be present for that command. Native
delegations require structured `result.output` with `{sessionID,status,output}`
and matching `result.metadata`; pending `running` results, unobserved children,
nested children, mismatched ownership, or unexpected model/variant are not
valid completion evidence. These checks are why a process that exits cleanly or
a task that says it succeeded is not automatically an accepted sample.

## Metrics and units

The metrics module keeps these token components separate:

- `input`
- `output`
- `reasoning`
- `cacheRead`
- `cacheWrite`

Missing or non-numeric components remain unknown (`null`) rather than being
invented or zero-filled. Partial usage therefore keeps each unavailable
component `null`; an observed numeric zero remains zero. Reasoning is not
added to output tokens as a billing estimate. Usage is reported for the root,
each tier, the total, and attribution by captured provider/model/variant and
request identity; missing identity is retained in an explicit `unknown` bucket.

Captured numeric session costs are direct `Money.USD` values. The report exposes
the same numeric unit as `costUSD` and its `cost` alias: there is no `10^12`
scaling, price-list lookup, or cost derived from catalog token prices. A numeric
zero remains zero; a missing or non-numeric value remains unknown. Catalog price
fields, when present, are a separate per-million-token type and are not used by
this benchmark.

Raw sample counts, failures, errors, and usage totals include failed runs. Time
and cost quantiles/ratios use only successful direct/tiered pairs from the same
repetition with valid metrics. The artifact retains both counts so a missing
metric is not confused with a zero observation.

## Reading the result

Per-arm summaries include requested samples, successes, failures, completion
counts, and unknown metrics. Matched comparisons include the number of attempted
pairs and successful pairs; p50/p95 fields also report the number of valid
metric samples and unknown values. A small `n` makes p95 provisional. Provider
variance, warm caches, fixed scenario order within each arm, process startup,
and the absence of a separate warm-up phase limit causal interpretation.

Ratios are descriptive matched measurements, not an improvement claim. In
particular, benchmark output cannot establish that delegation is always cheaper,
faster, or higher quality, and the current medium-root method cannot answer how
the plugin changes economics for a powerful primary. Use a new, explicitly
chosen root configuration when that question matters; do not treat a generated
artifact as published evidence.
