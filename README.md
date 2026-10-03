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

- OpenCode V2 `2.0.18` with `@opencode/plugin` `2.0.18`;
- the native V2 `subagent` tool;
- one enabled, tool-capable model for each tier;
- three project or global V2 agent definitions named `fast`, `medium`, and `heavy`.

V2 plugins can update and remove agents, but the `2.0.18` plugin API cannot add
new agents. The three definitions therefore belong in `opencode.jsonc`; the
plugin supplies the routing protocol and validates the required model mapping,
permissions, and agent modes.

## Quick start

1. Build or install the plugin.
2. Authenticate providers with `/connect`.
3. Confirm the required model IDs and variants are available in `/models`.
4. Add the plugin and three minimal native tier-agent stubs to `opencode.jsonc`.
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

Then configure the package directory and the three native agent stubs:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "agents": {
    "fast": { "mode": "subagent" },
    "medium": { "mode": "subagent" },
    "heavy": { "mode": "subagent" }
  },
  "plugins": [
    { "package": "/home/me/Workspace/opencode-tiered-dispatch" }
  ]
}
```

The checkout is a local plugin directory. Its root `index.js` is the required
OpenCode directory entrypoint and re-exports compiled `dist/`; do not point
`package` at `dist/index.js`.
The plugin fills the three stubs with their model, system instructions,
descriptions, and permission policies at runtime.

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

Use `"package": "opencode-tiered-dispatch"` in the same plugin object and
keep only the three native agent stubs. For a local package archive, use the
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

Custom taxonomy entries extend the defaults and are deduplicated
case-insensitively. Unknown fields are rejected. With `enabled: false`, the
plugin removes the reserved tier agents through the runtime transform and does
not inject routing guidance or validate model availability. The reserved agent
entries remain in `opencode.jsonc` so re-enabling restores them. If the plugin
entry itself is removed, also remove the three reserved agent entries: a plugin
that is no longer loaded cannot transform them away.

## Routing protocol

The primary session receives concise guidance to:

1. use the cheapest reliable tier;
2. handle truly trivial work directly;
3. split separable exploration and implementation phases;
4. serialize overlapping edits;
5. avoid automatic escalation and provider fallback;
6. call the native `subagent` tool with a narrow description and complete prompt.

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
- The plugin owns the routing context-hook and native tier-agent transform;
  unloading it disposes both registrations.
- There is no tier escalation or provider fallback.

## Troubleshooting

- **The plugin is inactive:** run `opencode api get /api/plugin` and check that
  `tiered-dispatch` is `active`. Restart after changing configuration.
- **A tier is missing:** define `fast`, `medium`, and `heavy` with
  `mode: "subagent"` in the same project/global configuration.
- **A model is unavailable:** authenticate with `/connect` and copy the exact
  `provider/model` from `/models`.
- **A variant is unavailable:** remove the variant or use one listed for that
  exact model.
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

The real OpenCode smoke uses the standard `opencode.jsonc` package entry. It
starts a primary session and verifies native foreground calls to all three
agents, their resolved models, the primary routing protocol, and the absence of
that protocol from tier children. It also verifies native cancellation and
provider-error outcomes without fallback:

```bash
npm run smoke:opencode
```

`npm run smoke:opencode:config` is an alias for the same standard-configuration
test. The smoke consumes provider usage and requires credentials for the three
configured models.

## Updates and removal

For a global published installation:

```bash
opencode plugin update opencode-tiered-dispatch
opencode plugin remove opencode-tiered-dispatch
```

For a local checkout, rebuild after pulling updates and restart OpenCode. Remove
the plugin object and the three reserved native agent entries from
`opencode.jsonc` to remove the complete routing setup. No generated files or
persistent router state remain.
