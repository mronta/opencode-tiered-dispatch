# OpenCode Tiered Dispatch

`opencode-tiered-dispatch` is an OpenCode V2 plugin that brings the V1 router's
native subagent workflow to V2. It teaches the primary agent to choose the
cheapest adequate tier, then call that tier through OpenCode's normal
`subagent` tool:

- **fast** — focused exploration, search, reads, and research;
- **medium** — implementation, refactoring, tests, and ordinary fixes;
- **heavy** — architecture, security, difficult debugging, and high-risk reasoning.

The user-facing calls are native agent calls such as `subagent(agent: "fast", ...)`.
There is no plugin-owned dispatch tool, custom child-session protocol, generated
agent file, fallback chain, or persistent routing state.

## Requirements

- OpenCode V2 `2.0.19` with `@opencode/plugin` `2.0.19` (the tested
  host/API combination);
- the native V2 `subagent` tool;
- one enabled, tool-capable model for each tier;
- a plugin entry in the project or global OpenCode configuration.

The V2 `AgentEditor` exposes `update` rather than `add`. On the tested
OpenCode `2.0.19` host, updating a missing agent materializes it, so the plugin
owns the complete tier-agent definitions without configuration stubs. Hosts
that do not provide this upsert behavior should use the compatibility fallback
described below.

## Quick start

1. Build or install the plugin.
2. Authenticate providers with `/connect`.
3. Confirm the required model IDs and variants are available in `/models`.
4. Add the plugin to `opencode.jsonc`.
5. Restart OpenCode and start a new session.
6. Ask the primary agent to delegate a small task and verify that the child is
   shown as `fast`, `medium`, or `heavy` rather than as `explore` or `general`.

## Local checkout configuration

Build the checkout first:

```bash
cd /home/me/Workspace/opencode-tiered-dispatch
npm install
npm run build
```

Then configure the package directory:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    { "package": "/home/me/Workspace/opencode-tiered-dispatch" }
  ]
}
```

The checkout is a local plugin directory. Its root `index.js` is the required
OpenCode directory entrypoint and re-exports compiled `dist/`; do not point
`package` at `dist/index.js`. The plugin materializes and configures the three
tier agents with their model, system instructions, descriptions, and
permission policies at runtime.

The plugin's default OpenAI mapping is:

```text
fast   → openai/gpt-6-luna#medium
medium → openai/gpt-5.6-luna#max
heavy  → openai/gpt-5.6-sol#medium
```

GPT-6 Luna's model ID is `gpt-6-luna` with explicit `medium` reasoning effort.
There is no `medium-fast` model variant. This exact mapping is required by the plugin;
confirm that these exact models and variants are available with `/models` before
connecting providers.

The canonical packaged mapping lives in the root `tiers.json`; `src/tiers.ts`
validates and loads it for runtime use. Tests, native smoke checks, and the
packed plugin all consume that same file.

## Published or packed installation

For a published package:

```bash
opencode plugin add opencode-tiered-dispatch
```

Use `"package": "opencode-tiered-dispatch"` in the same plugin object. For a
local package archive, use the
archive or installed package directory as the `package` value. Credentials and
provider subscriptions are never bundled.

## Configuration

```ts
interface RouterOptions {
  enabled?: boolean
  tiers?: Partial<Record<"fast" | "medium" | "heavy", TierOptions>>
  taxonomy?: Partial<Record<"fast" | "medium" | "heavy", string[]>>
  directThreshold?: "never" | "trivial"
  logging?: boolean
}

interface TierOptions {
  model?: string // optional; defaults to the required mapping
  variant?: string
  instructions?: string
}
```

When omitted, the plugin uses this exact mapping:

```text
fast   → openai/gpt-6-luna#medium
medium → openai/gpt-5.6-luna#max
heavy  → openai/gpt-5.6-sol#medium
```

It validates all three references against the active catalog. The native agent
definitions are the execution interface, so their model and variant must match
the corresponding plugin option. `medium` and `heavy` must retain `edit`,
`write`, and `shell` permissions; `fast` must remain read-only.

The optional `tiers` entries are mainly useful for adding tier-specific
`instructions`; explicit `model` and `variant` values must still match the
required mapping.

`directThreshold: "trivial"` permits the primary agent to handle genuinely
trivial one-step work directly. `directThreshold: "never"` instructs it to
delegate every executable task and reserve itself for classification,
delegation, integration, and the final answer. These are model-facing routing
instructions, not a hard block on the primary agent's native tools.

Custom taxonomy entries extend the defaults and are deduplicated
case-insensitively. Unknown fields are rejected. With `enabled: false`, the
plugin removes the reserved tier agents through the runtime transform and does
not inject routing guidance or validate model availability. If the plugin entry
itself is removed, its transform is disposed and the generated tier agents
disappear; no generated agent files or persistent router state remain.

## Routing protocol

The primary session receives model-facing guidance to classify and route work;
OpenCode still gives the primary agent its normal tools, so this is not a
deterministic task graph and the plugin cannot guarantee that every request
creates multiple child sessions. The intended decision is:

| Request shape | Preferred route |
|---|---|
| Truly trivial one-step work | Handle directly when `directThreshold` is `"trivial"` |
| Unknown repository context | `fast` |
| Known-scope implementation | `medium` |
| Difficult judgment or high-risk reasoning | `heavy` |
| Discovery followed by implementation | `fast`, then `medium` |
| Discovery followed by difficult reasoning | `fast`, then `heavy` |

The primary is responsible for classification, decomposition, delegation,
integration, and the final answer. Tier agents perform the delegated work.
Independent delegations may run in parallel; dependent phases are serialized.

The compact protocol treats discovery as execution: batch related questions in
one `fast` request, then pass findings, file paths and unresolved questions to
the implementation or analysis tier. Examples: trace auth then refactor is
`fast → medium`; map trust boundaries then assess security is `fast → heavy`.
Already-scoped work stays one delegation; splitting is not a goal by itself.

Tier instructions provide model-facing handoffs:

- `fast`: stop once the ask is satisfied; report evidence and unresolved questions,
  or `NEED MORE:` with missing evidence.
- `medium`: use supplied findings; return `NEED CONTEXT:` rather than doing broad
  reconnaissance. Report attempts and blockers when repeated failures prevent progress.
- `heavy`: use supplied evidence; return `SCOPE GROWTH:` when more discovery is
  needed. Implement only when requested.

The primary decides whether to send a focused `fast` follow-up and resume the
original tier. These labels are instructions, not machine-parsed results or
automatic escalation. Targeted local reads and verification remain allowed.

The protocol tells the primary to:

1. use the cheapest reliable tier;
2. handle truly trivial work directly when `directThreshold` is `"trivial"`;
3. split separable exploration and implementation phases;
4. serialize overlapping edits;
5. avoid automatic escalation and provider fallback;
6. call the native `subagent` tool with a self-contained prompt containing the
   goal, relevant paths or boundaries when known, constraints, required
   verification, and the exact result to return.
7. omit per-call model overrides because each tier owns its validated model and
   variant;
8. integrate delegated results and remain responsible for the final answer;
9. delegate before nontrivial discovery and avoid repeated broad exploration.

Tier agents do not receive this orchestration protocol. Their own `system`
instructions and permissions remain focused on execution, so they cannot recurse
into another subagent call.

## Safety and lifecycle

- `fast` is configured as read-only through native V2 permissions.
- `medium` and `heavy` must retain `edit`, `write`, and `shell` implementation
  permissions.
- All tier agents deny the `subagent` action, preventing recursion.
- Native OpenCode owns child-session creation, foreground waiting, cancellation,
  provider errors, metadata, and inspectability.
- The plugin owns the routing context-hook, native tier-agent transform, and
  model-override guard; unloading it disposes all registrations.
- The routing context callback reads the current agent catalog on every
  callback, so it revalidates the effective primary/child mode, model/variant,
  and permissions instead of relying on a stale setup-time snapshot.
- Setup is transactional: if a later registration fails, earlier registrations
  are rolled back; cleanup attempts every registration and reports failures.
- Tier invocations must not pass a per-call `subagent.model` override. The
  selected tier owns its validated model and variant; choose another tier when
  a different capability level is needed.
- There is no tier escalation or provider fallback.

## Troubleshooting

- **The plugin is inactive:** run `opencode api get /api/plugin` and check that
  `tiered-dispatch` is `active`. Restart after changing configuration.
- **A tier is missing:** restart OpenCode and verify that the host provides the
  tested `2.0.19` behavior where `agent.update` creates missing entries. On an
  older host whose agent transform only updates existing entries, add these
  temporary compatibility stubs and restart:

  ```jsonc
  "agents": {
    "fast": { "mode": "subagent" },
    "medium": { "mode": "subagent" },
    "heavy": { "mode": "subagent" }
  }
  ```
- **A model is unavailable:** authenticate with `/connect` and copy the exact
  `provider/model` from `/models`.
- **A variant is unavailable:** the packaged mapping requires `fast#medium`,
  `medium#max`, and `heavy#medium`; authenticate or configure the provider so those exact
  variants are available. The plugin does not substitute another variant.
- **A tier call is rejected:** remove the per-call `model` field from the native
  `subagent` invocation and select `fast`, `medium`, or `heavy` according to
  the required capability level.
- **Fast can mutate files:** inspect the final `fast.permissions` rules; the
  broad deny must appear before the read-only allows, and no later rule may
  allow `edit`, `shell`, or `subagent`.
- **No routing guidance appears:** confirm the plugin is configured for the
  project you opened, `enabled` is not false, and start a new session.
- **No tier agents appear:** run `opencode debug agents` and inspect the
  OpenCode log for a configuration-normalization warning. A malformed global
  `opencode.jsonc` causes the plugin entry to be ignored; fix the JSONC and
  restart the OpenCode service.

## Development and verification

```bash
npm run typecheck
npm test
npm run build
npm pack --dry-run
npm run smoke:package
```

The package smoke removes its temporary installation and generated archive when
it exits.

The real OpenCode smoke uses the standard `opencode.jsonc` package entry with no
tier-agent stubs. It verifies materialization and permissions from the native
agent catalog, exercises each tier directly, and runs one primary-to-medium
routing scenario to verify model resolution and the absence of the primary
protocol from tier children. It also verifies native cancellation and
provider-error outcomes without fallback. The direct checks avoid making all
structural assertions depend on the primary model choosing to delegate:

```bash
npm run smoke:opencode
```

`npm run smoke:opencode:config` is an alias for the same standard-configuration
test. The smoke consumes provider usage and requires credentials for the three
configured models.

### Spontaneous routing evaluation

```bash
npm run eval:routing
# Optional direct arm and machine-readable artifact (the default arm is tiered).
npm run eval:routing -- --arm direct --output /tmp/opencode/routing-direct.json
# Optional single-scenario diagnosis with an explicit timeout.
node scripts/opencode-native-smoke.mjs --routing-eval --arm tiered \
  --scenario discover-implement --timeout-ms 240000 \
  --output /tmp/opencode/routing-discover-implement.json
```

This optional, provider-consuming evaluation uses ordinary requests without
asking the model to delegate: trivial arithmetic, a known-scope edit, discovery
followed by implementation, and discovery followed by security analysis. It
records native call order/completion, structured child-session/model evidence,
shared file-path evidence in handoffs, primary and repeated-read categories,
latency and reported token usage, and checks fixture behavior/tests immediately
after each edit scenario. Focused discovery/resume cycles are accepted only
when the native result identifies the same child session and returns a
completed foreground structured result. Each call must expose `result.output`
with the child session ID, `status`, and text, plus matching per-call
`result.metadata`; a `running` or background result is not evidence that
delegated work finished. A resume is valid only with an explicit continuation
`sessionID` for an already established child owned by the same tier.

Before each scenario the observer restores a pristine fixture manifest. It
preserves only immutable `opencode.jsonc` and `.opencode` infrastructure,
rejects infrastructure changes, runs the behavior/test verifier from a
separate control directory, and checks that the verifier itself did not modify
either workspace. No-edit snapshots cover the fixture workspace, not external
paths or a security sandbox; the recorded manifests use relative paths with
SHA-256 file hashes (and hashed symlink targets). Handoff checks are
structural, not proof that all findings were understood. Repeated reads are
diagnostic: a cache-freshness lookup or a read after an edit can be necessary,
so repeated-read counts are overhead signals rather than an automatic defect.
For headless fixture isolation, every root session in both the tiered and direct
arms receives the native session-scoped
`{ permission: "external_directory", pattern: "*", action: "deny" }` rule;
the V2 session rule is inherited by native children after the tier definitions
are materialized. This is an evaluator control only: ordinary native smoke and
the normal plugin keep the host's `ask` behavior, and the harness does not
overwrite tier definitions or auto-allow external paths. A denied outside read
is retained as tool evidence and an error metric; the structural assessment
does not silently discard failed tool completions.
It exits nonzero when observed routing misses the expected route, the primary
uses a tool before its first nontrivial delegation, or the primary executes a
disallowed tool after delegation. After delegation, the primary allowlist is
limited to native `subagent`/`skill` orchestration, read/search tools (`read`,
`glob`, `grep`, `webfetch`, and `websearch`), and the exact scenario-declared
fixture verification command. For an accepted command, omitted `cwd`/`workdir`
means the fixture workspace and relative values resolve beneath it; conflicting
cwd/workdir aliases or an outside directory fail the assessment. Unknown
commands fail the assessment; there is no safe arbitrary-script or shell-regex
allowlist. Mutation commands and other command execution remain delegated. The
report also shows all primary reads, including integration verification, so
over-exploration can be distinguished from final verification.
This restriction applies to the tiered assessment. The direct control is
deliberately permissive about ordinary primary-native tools (including shell)
and only rejects child delegation plus its trivial-control overuse check; it is
not a shell-safety measurement.
It is intentionally separate from the smoke test: nondeterministic model
compliance is not a structural plugin test. Passing examples do not guarantee
general splitting or establish net cost savings. It inherits the host's global
configuration and credentials; its files live in a temporary fixture workspace.

Any prior passing evaluation output is historical evidence for that particular
provider/configuration snapshot, not proof of current routing behavior or cost
savings.

### Matched routing benchmark

```bash
# Builds once, then runs each arm in a fresh foreground native process.
npm run benchmark:routing -- --runs 1 --output /tmp/opencode/routing-benchmark.json
```

The runner interleaves and counterbalances `tiered,direct` then
`direct,tiered`; it never runs provider calls in parallel and never retries a
failed run. Each arm executes the same four scenario prompts with the same
medium root model. The **direct** control explicitly passes plugin
`options.enabled:false`, denies the root `build` agent's `subagent` permission,
and the independent `.opencode/plugins` observer hides that tool as a final
guard. This is a deliberate control difference: it measures direct completion
without tier routing, not an assertion that tier permissions block a root
implementation. Unrelated global plugin configuration remains a host-level
caveat.

The native evaluator writes one machine-readable artifact per arm containing
the arm, root/tier model references, host version when obtainable, startup
time, reports, results/raw traces, and errors. Failed artifacts are written
before temporary evaluator cleanup; the benchmark keeps them under
`<output>.runs/<unique-run-id>/` and exits nonzero if any arm attempt fails.
Timeout artifacts retain the pre-shutdown progress checkpoint separately from
any post-SIGTERM state, including completed scenarios, active phase/root ID,
bounded context/tool events, and a best-effort partial trace. If artifact
serialization itself fails, the temporary control/workspace evidence is copied
to a sibling `.evidence-*` directory instead of being destroyed.
Previous invocation directories are retained; a child that fails before
writing cannot reuse an older arm artifact. The output distinguishes requested
repetitions, arm attempts, completed/failed arm attempts, attempted pairs, and
completed pairs (both arms successful for the same repetition). It measures startup,
scenario execution, verifier time, harness overhead, and total time separately.
The verifier requires root outcomes/contexts (the routing protocol is present
for tiered and explicitly absent for direct), complete tool identity tuples and
successful completions, objective fixture behavior/isolation, and exactly four
scenario results for both arms. Direct assessment bypasses tier-route and
primary orchestration policy checks, except that the trivial control remains a
natural at-most-one-tool check; tiered checks are not loosened.

`routing-metrics.mjs` keeps input/output/reasoning/cache-read/cache-write
components separate and treats missing token fields and missing/non-numeric
`Money.USD` costs as unknown (`null`); a captured numeric zero remains zero.
Reasoning is not added to output
tokens as a billing estimate. It also reports root versus child usage, model
call counts, time to first delegation, per-dispatch durations, handoff
character counts and `o200k_base` tokenizer-proxy tokens, plus primary and
repeated-read categories, and actual usage/cost attribution by captured
provider/model/variant and request identity; missing identities remain in an
explicit `unknown` bucket. Matched performance quantiles and ratios use only
successful, same-repetition direct/tiered pairs with valid metrics. Raw arm
sample counts, failures, errors, and usage totals still include failed runs, so
a failed run's reported cost is not silently dropped from accounting. Costs
are reported `Money.USD` values from the host, not a price-list or savings
calculation; a subscription/free model may legitimately report `0`, and an
unavailable value remains unknown.

The default `--runs 1` is a small smoke comparison. Use at least 10 repetitions
for meaningful tail quantiles; p95 with a small sample is provisional. Provider
variance, warm caches, fixed scenario order within an arm, process startup, and
the lack of a separate warm-up phase limit causal interpretation. The benchmark
does not turn a small artifact into a live-provider reliability, performance, or
cost claim.

One retained one-pair observation was generated at
`2026-10-03T06:23:45.930Z` and is available at
`/tmp/opencode/tiered-dispatch-final-benchmark.json` (raw arm artifacts are in
its `.runs/` directory):

| Scenario | Direct execution ms | Tiered execution ms |
|---|---:|---:|
| trivial | 1,844 | 2,041 |
| known-scope | 14,492 | 54,670 |
| discover-implement | 96,331 | 138,705 |
| discover-analyze | 111,593 | 208,675 |

All recorded roots and tier children ended with `succeeded`, but the tiered
arm's evaluator report still rejected three unknown primary verification
commands in `known-scope` and two in `discover-analyze`; therefore the pair did
not pass the quality gate. This was `n=1`, not p95 evidence. Every reported
host cost was numeric `Money.USD` zero, so it cannot compare prices or savings.
The metrics code applies no `10^12` scaling: captured session costs are direct
`MoneyUSD` (`Money.USD`) values. Model catalog price fields are the separate
`MoneyUSDPerMillionTokens` type, and this benchmark does not derive cost from
them.

### Prompt token budgets

```bash
npm run measure:prompts
```

The default plugin-added primary protocol measures 346 tokens; tier instructions
measure 62–68 tokens with `o200k_base`. The previous primary protocol was 440
tokens with the same encoding (~18% reduction despite added handoff contracts).
Tests budget 380 primary tokens and 85 per tier. Custom taxonomy/instructions
can increase these sizes. The encoding is a reproducible proxy, not a verified
tokenizer for every configured model, the full host prompt, or provider billing.
No numeric subagent caps, runtime counters or provider-specific prompt overrides
are added to the plugin.

## Updates and removal

For a global published installation:

```bash
opencode plugin update opencode-tiered-dispatch
opencode plugin remove opencode-tiered-dispatch
```

For a local checkout, rebuild after pulling updates and restart OpenCode. Remove
the plugin object from `opencode.jsonc` to remove the complete routing setup. No
generated agent files or persistent router state remain.
