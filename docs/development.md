# Development and verification

This document is for maintaining the local checkout. It does not describe a
published package or a release process.

## Local checks

Use Node.js `>=22.19.0` and the checked-in lockfile. A normal local setup is:

```bash
npm ci
npm run build
```

The focused static and unit checks are:

```bash
npm run typecheck
npm test
npm run build
```

Before packaging a local archive, inspect its contents without publishing it:

```bash
npm pack --dry-run
npm run smoke:package
```

The package smoke exercises a temporary packed installation and cleans its
temporary archive and installation when it exits. It is distinct from a
registry publication.

## Native OpenCode smoke

The native smoke uses the normal `opencode.jsonc` plugin entry and does not
require tier-agent stubs. It checks that the host can materialize the three
reserved agents, resolve their configured models and variants, and expose the
intended permissions. It also invokes each tier directly, exercises one
primary-to-`medium` native call, confirms that tier children do not receive the
primary execution protocol, and checks native cancellation and provider-error
outcomes without fallback.

Plan dispatch is covered structurally by the unit suite: Plan may target any
reserved tier, while its session-scoped read-only rules and inherited child
context prevent edit, write, patch, and shell tools. The canonical `medium` and
`heavy` permissions remain unchanged for Build-originated children.

Run it with provider credentials and the configured models available:

```bash
npm run smoke:opencode
npm run smoke:opencode:config
```

The second command is an alias for the first. These are provider-consuming
checks; the package and type checks do not require live provider calls.

## Routing evaluation

The optional evaluation sends ordinary prompts through a fixture workspace. It
is separate from the structural native smoke because model compliance is
nondeterministic:

```bash
npm run eval:routing
npm run eval:routing -- --arm direct --output /tmp/opencode/routing-direct.json
node scripts/opencode-native-smoke.mjs --routing-eval --arm tiered \
  --scenario discover-implement --timeout-ms 240000 \
  --output /tmp/opencode/routing-discover-implement.json
```

The evaluator's default native deadline is `600000` ms. The explicit command
above demonstrates a `240000` ms single-scenario deadline. The four standard
scenarios are:

| Scenario | Expected route | Task |
|---|---|---|
| `trivial` | Direct | Answer a one-step arithmetic question |
| `known-scope` | `medium` | Make a specified edit and run its exact test command |
| `discover-implement` | `fast` → `medium` | Discover validation ownership, implement it, add tests, and run `npm test` |
| `discover-analyze` | `fast` → `heavy` | Map authentication boundaries and provide a security assessment without editing |

### Task success and policy success

The evaluator keeps three results separate:

- **Task** checks objective fixture behavior and tests.
- **Policy** checks the expected route, primary tool-use rules, allowed
  verification commands, and handoff behavior.
- **Evidence** checks that native sessions, contexts, tool events, and fixture
  snapshots are complete and correlated.

A scenario can complete its requested task and still fail policy or evidence.
Conversely, a clean route trace does not prove that the requested task was
correct. The aggregate status combines these categories, while retaining the
individual `taskProblems`, `policyProblems`, and `evidenceProblems` fields.

For a nontrivial tiered scenario, the evaluator expects the primary's first
tool to be native `subagent`; it rejects mutation by the primary before or
after the delegated execution when the policy disallows it. A known-scope task
uses one `medium` dispatch, and a discovery-plus-implementation task must carry
concrete discovered paths into the next prompt. The direct control is
deliberately permissive about ordinary primary tools, except that it cannot
create a child session and the trivial control has its natural one-tool guard.

### Native result fields

Every observed native delegation must have a completed foreground result with
structured `result.output` containing:

```json
{
  "sessionID": "child-session-id",
  "status": "completed",
  "output": "child text"
}
```

Matching `result.metadata` must agree on `sessionID` and `status`. A
`running`/background result is not evidence that delegated work finished. A
continuation must provide the explicit `sessionID` of an already established
child owned by the same tier. The linked child must be a direct child of the
root, have a context between dispatch and completion, and use the expected
model and variant.

For an allowed primary verification shell command, the native completion shape
contains `output` (string), `truncated` (boolean), `status: "completed"`, and
`exit: 0`; a signal or timeout is invalid. If metadata is present, its
`status`, `exit`, `signal`, and `timeout` values must agree with the output.

### Fixture and command policy

Before each scenario the evaluator restores a pristine fixture manifest. It
allows only immutable `opencode.jsonc` and `.opencode` infrastructure changes,
rejects infrastructure changes, and runs the behavior/test verifier from a
separate control directory. Workspace manifests use relative paths, SHA-256
file hashes, and hashed symlink targets. Handoff checks establish structural
file evidence; they do not prove that every finding was understood.

For headless isolation, the evaluator gives each root session a
session-scoped deny rule for external directories. Native children inherit that
control. It is an evaluator control, not the normal plugin's permission policy:
ordinary use keeps the host's `ask` behavior and does not auto-allow outside
paths. A denied outside read remains tool evidence and an error metric.

The plugin uses the host's native session permission setter for Plan sessions
before dispatch, merging the current rules rather than replacing them. If the
host cannot expose a supported setter, the dispatch hook fails closed instead of
allowing an unverified Plan child.

After a tiered delegation, the primary allowlist is native orchestration,
read/search tools (`read`, `glob`, `grep`, `webfetch`, and `websearch`), and the
exact scenario-declared fixture verification command. Unknown commands fail the
assessment; there is no arbitrary shell or shell-regex allowlist. Mutation
commands remain delegated. The direct control is intentionally permissive about
ordinary primary-native tools and is not a shell-safety measurement.

## Prompt-size proxy

To inspect the plugin-added prompt budgets without calling a provider, run:

```bash
npm run measure:prompts
```

The report uses the `o200k_base` tokenizer as a reproducible proxy for protocol
and tier-instruction size. It is not a tokenizer or billing estimate for every
configured model, the full host prompt, or a provider. Reasoning tokens are not
silently added to output tokens, and the plugin does not add numeric provider
caps or prompt overrides.

## What these checks establish

The checks establish package shape, host integration, permission boundaries,
native result correlation, and behavior for the selected fixture prompts. They
do not establish deterministic delegation for all user requests, a security
sandbox, or a general performance or cost improvement. Use the separate
[benchmarking guide](benchmarking.md) for matched measurements and
their metric rules.
