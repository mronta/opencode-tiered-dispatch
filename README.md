# OpenCode Tiered Dispatch

`opencode-tiered-dispatch` is a local OpenCode V2 plugin that lets a user-selected
primary model classify, decompose, delegate, and integrate work across three
configured model tiers. The primary remains responsible for the final answer;
the tiers perform bounded work so the primary does less expensive execution and
total cost may be lower, without promising the cheapest or fastest result.

This package is not published yet and is intended for local use only. Install it
from a local checkout by using the absolute checkout directory in the
configuration below.

## Requirements

- Node.js `>=22.19.0`. The runtime dependency graph includes `undici`, whose
  runtime package metadata requires this floor; this is not only a dev-tool
  requirement.
- npm.
- OpenCode V2 in the supported range `>=2.0.19 <3`. Hosts specifically tested
  here are `2.0.19` and `2.0.22`; that is not a promise that every future host
  release has been tested.
- An enabled, tool-capable provider model for every exact model and variant in
  the [canonical tier table](#canonical-tiers).

## Install from this local checkout

Run these commands from the actual checkout. Replace the placeholder with its
absolute path; do not point OpenCode at a `dist` file.

```bash
cd /absolute/path/to/opencode-tiered-dispatch
npm ci
npm run build
```

OpenCode can read a project configuration from `opencode.jsonc` in the project
root or a global configuration from `~/.config/opencode/opencode.jsonc`. It also
supports `.opencode` project configuration locations; for a first setup, use
one of the two explicit paths above and follow the host's configuration
precedence if you later move the entry.

Add the checkout to the existing `plugins` array rather than replacing other
plugin entries:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    // Keep any existing entries.
    { "package": "/absolute/path/to/opencode-tiered-dispatch" }
  ]
}
```

The `package` value is the checkout directory. The root `index.js` loads the
compiled plugin; do not use `dist/index.js` as the package value.

After adding the entry or rebuilding the checkout, reload the OpenCode service
and start a new session:

```bash
opencode service restart
```

To inspect the resulting agent catalog, use:

```bash
opencode debug agents
```

Confirm that `fast`, `medium`, and `heavy` are present.

The provider must expose each exact model below as enabled and tool-capable.
Choose a capable primary model in your normal OpenCode configuration. The
primary/root model remains user-selected; this plugin does not replace it, does
not require a particular pricey model, and does not guarantee that the primary
never executes work.

## Canonical tiers

The defaults are pinned in [`tiers.json`](tiers.json). The provider/model and
variant must match exactly; the provider also needs to make tools available.

| Tier | Model and variant | Intended work | Permissions |
|---|---|---|---|
| `fast` | `openai/gpt-6-luna#medium` | Discovery, focused reads, search, and research | Read-only |
| `medium` | `openai/gpt-5.6-luna#max` | Implementation, refactoring, tests, and ordinary fixes | Edits allowed |
| `heavy` | `openai/gpt-5.6-sol#medium` | Architecture, security, difficult debugging, and high-risk reasoning | Edits allowed |

The plugin validates these references against the active model catalog. It does
not substitute another model or variant when one is unavailable.

## What a normal request looks like

The plugin supplies model-facing guidance to eligible primary sessions. It is an
advisory orchestration policy using native OpenCode capabilities, not a
deterministic task graph or a security sandbox.

| Request shape | Expected route |
|---|---|
| One trivial step with no expected follow-up | Primary handles it directly when the default threshold is enabled |
| Unknown repository or problem context | `fast` |
| Known-scope implementation | `medium` |
| Difficult judgment, security, or high-risk reasoning | `heavy` |
| Discovery followed by implementation | `fast` then `medium` |

For example, an ordinary request such as “Find how display-name validation is
currently handled, then reject blank and over-limit names after trimming and add
focused tests” is expected to use `fast` for discovery and `medium` for
implementation. The user does not need to write “delegate this” or name a tier.
A request such as “Update the already
identified error message and run its focused test” is expected to use `medium`.
“What is 2 + 2?” is a direct trivial request.

The primary classifies, decomposes, delegates, integrates results, verifies the
outcome, and answers. Independent work can run in parallel; dependent phases
and overlapping edits should remain ordered. A route is guidance, not a
guarantee that every request creates a child session.

## Runtime boundaries

- With `enabled: false`, the plugin is a no-op: it leaves the user's agents and
  their configuration untouched.
- While enabled, `fast`, `medium`, and `heavy` are reserved names. The plugin
  applies their canonical hidden/step/request behavior, model, instructions,
  and permissions, overwriting user values in those behavioral fields.
  Cosmetic `color` configuration is preserved.
- The built-in `Plan` agent receives no execution protocol and can invoke all
  three plugin tiers. A Plan root carries a nonrestrictive origin marker;
  context-tool filtering and an execution guard enforce its read-only behavior.
  Plan-originated sessions may use native read/search, `question`, `skill`, and
  safe tier orchestration. Children inherit the marker at creation; the first
  child context installs the persistent read-only session policy and guard for
  that child and its descendants. Unsafe tools are filtered; edit, write,
  patch, shell, and other workspace mutation remain unavailable. `question` and
  `skill` are safe native actions, but tools requested by skill contents remain
  subject to the same guard. Normal Plan-safe `question`, `skill`, and
  `subagent` tools remain visible unless the user denies them; the child policy
  keeps wildcard `subagent` at `ask` and named tier allows visible, while the
  guard rejects custom targets.
- If the same root session switches back to `Build`, its pre-Plan root
  permissions remain unchanged and its Plan origin marker is removed, so its
  first Build request has normal mutating tools. Descendants already owned by
  `Plan` remain read-only, while new Build-originated children keep the host's
  normal custom permissions.
- `fast` is read-only. `medium` and `heavy` retain their canonical edit, write,
  and shell permissions when invoked from `Build`; the Plan session policy does
  not globally change those tier definitions. Native permissions constrain tool
  use but are not a security sandbox; the primary still has its normal host
  tools.
- Tier prompts prohibit ordinary delegation and self-escalation. Safe tier
  orchestration from a Plan-originated read-only session is the controlled
  exception. The evaluator's same-tier continuation check is evidence
  correlation only, not a global runtime ban.
- Native host subagent-depth limits still apply. The default V2.0.19/.22 depth
  is `1`, so nested child delegation requires host depth `>=2`; the plugin does
  not change host configuration.

## Configuration

Put options on the plugin object:

```jsonc
{
  "package": "/absolute/path/to/opencode-tiered-dispatch",
  "options": {
    "directThreshold": "trivial",
    "logging": false,
    "tiers": {
      "medium": {
        "instructions": "Prefer the repository's existing validation patterns."
      }
    }
  }
}
```

Defaults are:

| Option | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Apply tier agents and primary guidance |
| `directThreshold` | `"trivial"` | Permit genuinely trivial one-step work directly; use `"never"` to request delegation for every executable task |
| `logging` | `false` | Disable plugin diagnostic logging |
| `taxonomy` | Built-in categories | Add category phrases to the classification guidance |
| `tiers` | The canonical table above | Add tier instructions |

Tier `instructions` are additive. Keep the canonical `model` and `variant`; the
plugin validates and owns those values, so changing them is not a supported
customization. Taxonomy entries extend the defaults and are deduplicated. The
threshold is model-facing guidance, not a hard block on the primary's native
tools; the options parser rejects unknown fields.

## Lifecycle

When the local files change, update the checkout using the method by which you
obtained it—no remote or `git pull` is assumed—then run `npm run build` and
restart the OpenCode service. Set `"enabled": false` for a no-op, or remove
only this checkout's plugin object to remove it; leave other plugin entries in
place. The package is not published yet, so keep the plugin configured with the
absolute checkout directory.

## Further reading

- [Development and verification](docs/development.md) — local checks,
  package/native smoke tests, and routing-evaluation evidence.
- [Benchmarking](docs/benchmarking.md) — matched direct/tiered measurements,
  metric schemas, and their limitations.
