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
fast   → openai/gpt-5.6-luna-fast
medium → openai/gpt-5.6-luna#max
heavy  → openai/gpt-5.6-sol#medium
```

`gpt-5.6-luna-fast` is a model ID, not a `medium-fast` variant. This mapping is
required by the plugin; confirm that these exact models and variants are
available with `/models` before connecting providers.

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
fast   → openai/gpt-5.6-luna-fast
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
9. keep direct discovery to two read-only calls and avoid repeated broad exploration.

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
- **A variant is unavailable:** the packaged mapping requires `medium#max` and
  `heavy#medium`; authenticate or configure the provider so those exact
  variants are available. The plugin does not substitute another variant.
- **A tier call is rejected:** remove the per-call `model` field from the native
  `subagent` invocation and select `fast`, `medium`, or `heavy` according to
  the required capability level.
- **Fast can mutate files:** inspect the final `fast.permissions` rules; the
  broad deny must appear before the read-only allows, and no later rule may
  allow `edit`, `shell`, or `subagent`.
- **No routing guidance appears:** confirm the plugin is configured for the
  project you opened, `enabled` is not false, and start a new session.

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
```

This optional, provider-consuming evaluation uses ordinary requests without
asking the model to delegate: trivial arithmetic, a known-scope edit, discovery
followed by implementation, and discovery followed by security analysis. It
records native call order/completion, shared file-path evidence in handoffs, primary read
counts, exact repeated-read inputs across tiers, latency and reported token usage,
and checks fixture behavior/tests immediately after each edit scenario. Focused
discovery/resume cycles are accepted. No-edit snapshots cover workspace files
outside `.git` and `node_modules`, not external paths or a security sandbox.
Handoff checks are structural, not proof that all findings were understood.
Repeated reads are diagnostic, not necessarily
redundant (for example, rereading after an edit can be necessary).
It exits nonzero when observed routing misses the expected route or read budget.
The read-budget flag conservatively counts all primary read-only calls, including
integration verification; the report separately shows reads before the first
delegation so over-exploration can be distinguished from final verification.
It is intentionally separate from the smoke test: nondeterministic model
compliance is not a structural plugin test. Passing examples do not guarantee
general splitting or establish net cost savings. It inherits the host's global
configuration and credentials; its files live in a temporary fixture workspace.

Initial live evaluation with a medium-tier primary produced both composite
routes (`fast → medium` and `fast → heavy`), but performed the known-scope edit
directly and exceeded primary read budgets. A later run executed both composites
directly too: decomposition is not repeatable yet. This remains an advisory-routing
limitation; the evaluator reports it rather than forcing a passing outcome.

### Prompt token budgets

```bash
npm run measure:prompts
```

The default plugin-added primary protocol measures 361 tokens; tier instructions
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
