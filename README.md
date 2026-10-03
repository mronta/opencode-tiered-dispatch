# OpenCode Tiered Dispatch

`opencode-tiered-dispatch` is an OpenCode V2 plugin that teaches a primary
agent to use the cheapest adequate model tier:

- **fast** — focused exploration, search, reads, and research;
- **medium** — implementation, refactoring, tests, and ordinary fixes;
- **heavy** — architecture, security, difficult debugging, and high-risk reasoning.

The plugin registers one `tiered_dispatch` tool and injects a short routing
protocol into primary-agent model requests. It does not generate agent files,
persist routing state, switch presets, or fall back silently to another model.

## Requirements

- OpenCode V2 `2.0.18` (the version tested by this release) with
  `@opencode/plugin` `2.0.18`;
- the built-in `explore` and `general` subagent agents;
- one available, tool-capable model for each configured tier.

## Install from a local checkout

Build the package first:

```bash
npm install
npm run build
```

Then add it to `opencode.jsonc`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "/home/me/Workspace/opencode-tiered-dispatch",
      "options": {
        "tiers": {
          "fast": {
            "model": "opencode/gpt-6-luna",
            "variant": "low"
          },
          "medium": {
            "model": "opencode/gpt-5.6-luna",
            "variant": "medium"
          },
          "heavy": {
            "model": "opencode/gpt-5.6-sol",
            "variant": "high"
          }
        }
      }
    }
  ]
}
```

Model IDs and variants are workstation-specific. Check the active catalog with
`opencode api get /api/model` and replace the examples when necessary. Authenticate
each required provider through the normal OpenCode provider setup on every
workstation; credentials and subscriptions are not bundled with this package.

For an npm installation, publish or pack this project and use the resulting
package name in the plugin entry. The package exports compiled `dist/` output.
No agent Markdown files or project files are generated.

For a published package, install it globally through OpenCode and add the same
configuration entry:

```bash
opencode plugin add opencode-tiered-dispatch
```

For a project-local installation, keep the plugin entry in that project's
`opencode.jsonc` and point `package` at the installed package or checkout.
Set `"enabled": false` to keep the package configured but inactive, or remove
the entry to unload it completely. Update a global installation with
`opencode plugin update opencode-tiered-dispatch`; remove it with
`opencode plugin remove opencode-tiered-dispatch`.

## Configuration

```ts
interface RouterOptions {
  enabled?: boolean
  tiers: {
    fast: TierOptions
    medium: TierOptions
    heavy: TierOptions
  }
  taxonomy?: Partial<Record<"fast" | "medium" | "heavy", string[]>>
  directThreshold?: "never" | "trivial"
  logging?: boolean
}

interface TierOptions {
  model: string // provider/model
  variant?: string
  instructions?: string
}
```

Custom taxonomy entries are appended to the defaults and deduplicated
case-insensitively. Unknown fields are rejected. With `enabled: false`, the
plugin is a no-op and does not validate model availability.

## Safety and lifecycle

- `fast` delegation runs through `explore` and is independently restricted to
  read-only tools.
- `medium` and `heavy` run through `general`.
- Caller agent and session permission rules are carried into the delegation
  session, so a read-only or plan-mode caller cannot gain write access.
- Delegations cannot recursively invoke `tiered_dispatch`.
- Delegation sessions are created at the caller's project location and remain
  inspectable after completion.
- Cancelling the tool interrupts its delegation session.
- Unloading the plugin interrupts in-flight delegations and disposes the tool
  and context hook.
- Provider failures and unavailable models are surfaced; there is no automatic
  tier escalation or provider fallback.

OpenCode V2.0.18 does not expose parent-linked session creation through the
plugin session domain. Delegation sessions are therefore standalone sessions,
with caller location and permissions explicitly copied into them.

## Development

```bash
npm run typecheck
npm test
npm run build
npm pack --dry-run
npm run smoke:package
```

`npm run smoke:package` installs the packed tarball into a clean temporary npm
project and imports its plugin export. The OpenCode V2 registration/session
smoke is explicit and requires three model references from the active catalog:

```bash
TIERED_DISPATCH_FAST_MODEL=provider/model \
TIERED_DISPATCH_MEDIUM_MODEL=provider/model \
TIERED_DISPATCH_HEAVY_MODEL=provider/model \
npm run smoke:opencode
```

Set `TIERED_DISPATCH_*_VARIANT` variables when the configured models require a
variant. The registration smoke does not send a provider prompt. Optional
provider-consuming checks are available when stronger verification is needed:

```bash
npm run smoke:opencode:delegate          # real child session and result
npm run smoke:opencode:permissions       # fast read-only; medium/heavy edits
npm run smoke:opencode:packed:delegate  # activate the packed tarball itself
npm run eval:routing                     # fast/medium/heavy/direct/split cases
```

These checks consume provider usage and require credentials for the configured
models. `eval:routing` is deliberately opt-in because model responses can vary;
it fails if the observed choices do not match the expected routing taxonomy.
