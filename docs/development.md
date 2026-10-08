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

The build stages compiled output and replaces `dist/` only after a successful
compile. A compile failure must leave the last successful output available, but
the failed command is still a failed verification.

Before packaging a local archive, inspect its contents without publishing it:

```bash
npm pack --dry-run
npm run smoke:package
```

The package smoke exercises a temporary packed installation and cleans its
temporary archive and installation when it exits. It is distinct from a
registry publication. Packed source maps must point to source files available in
the packed artifact (expected to include the relevant `src/` sources).

## Native OpenCode smoke

The native smoke uses the normal `opencode.jsonc` plugin entry and does not
require tier-agent stubs. It checks that the host can materialize the three
reserved agents and resolve their configured models and variants. Plan coverage
is behavioral: a real Plan session may dispatch `fast`, `medium`, and `heavy`.
The probe drives this with real prompts, not context-snapshot calls. It checks
the root context-tool filter and `execute.before` guard, then prompt preflight
installs the full child policy before the host's first native child-tool
snapshot; each child context's effective persistent read-only policy,
unsafe-tool filter, and guard are checked as a second layer. Normal Plan-safe
`question`, `skill`, and `subagent` tools remain visible unless user-denied;
the full child policy keeps wildcard `subagent` at `ask` and named tier allows
visible, while the guard rejects custom targets. Switching the same root back
to `Build` must remove only the origin marker: the first Build request has its
normal mutating tools, new Build children are normal, and existing Plan-owned
descendants remain read-only.

It continues to check canonical Build-originated tier permissions, that tier
children do not receive the primary execution protocol, provider-error
outcomes without fallback, and native cancellation. The service deadline is
bounded over HTTP, including response bodies; one overall deadline spans
startup, HTTP, observer work, and result arrival. Cancellation must interrupt
active root and child work and leave diagnostic evidence rather than hanging.
When no output path is supplied, a failed probe retains its diagnostic artifact
under `/tmp/opencode`.

The native host's subagent-depth limit still applies. The default V2.0.19/.22
depth is `1`, so child-nested delegation requires host depth `>=2`; the plugin
does not change host configuration.

Run it with provider credentials and the configured models available:

```bash
npm run smoke:opencode
npm run smoke:opencode:config
```

The second command is an alias for the first. These are provider-consuming
checks; the package and type checks do not require live provider calls.

To manually exercise a custom tier mapping, write a JSON file containing the
tier entries (not an `options` wrapper), then pass it to the native runner:

```json
{
  "fast": { "model": "provider/fast-model", "variant": "balanced" },
  "medium": { "model": "provider/medium-model" },
  "heavy": { "instructions": "Keep high-risk changes narrowly scoped." }
}
```

```bash
node scripts/opencode-native-smoke.mjs --tiers /absolute/path/to/tiers.json
```

The runner resolves this file with the same runtime options parser used by the
plugin; omitted, instructions-only, variant-only, and custom-model-without-
variant entries therefore retain the parser's normal semantics. The parser and
fixture tests cover this plumbing offline. Actual V2 host materialization of a
custom mapping still requires this manual, provider-consuming invocation with
the referenced catalog entries available and is not claimed by the offline
checks.

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
| `discover-implement` | `fast` → `medium` | Discover validation ownership, implement blank/over-limit handling, add meaningful tests, and run `npm test` |
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
uses one fresh `medium` execution child; an explicit verified continuation may
reuse that same child, but two fresh `medium` children fail policy. A
discovery-plus-implementation task must carry concrete discovered paths into
the first fresh execution prompt. An explicit validated continuation of that
same child retains its context and need not repeat the paths; every additional
fresh execution child must receive them. `discover-implement` also
requires meaningful regression evidence for both blank-after-trimming and
over-limit-after-trimming behavior. A useful negative control is to run the
regression suite against the old implementation and require it to fail; when
evidence is asynchronous, wait until it is visible or describe the invariant
being checked rather than relying on a fixed delay. The direct control is
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
child. For evaluator evidence, that child must be owned by the same tier; this
is an evidence-correlation constraint, not a global runtime ban. The linked
child must be a direct child of the root, have a context between dispatch and
completion, and use the expected model and variant. A malformed child
completion or a missing dispatch-to-completion context fails closed. Native
child linkage is validated before fixture verification or reset; malformed
linkage stops the whole batch, and observer cleanup removes all context
children before teardown.

For an allowed primary verification shell command, the native completion shape
contains `output` (string), `truncated` (boolean), `status: "completed"`, and
`exit: 0`; a signal or timeout is invalid. If metadata is present, its
`status`, `exit`, `signal`, and `timeout` values must agree with the output.

### Fixture and command policy

Before each scenario the evaluator restores a pristine fixture manifest. Fixture
snapshots contain only files, directories, and symlinks under the contained
fixture root; relative paths, SHA-256 file hashes, and hashed symlink targets
make outside paths invalid evidence. It allows only immutable `opencode.jsonc`
and `.opencode` infrastructure changes, rejects infrastructure changes, and
runs the behavior/test verifier from a separate control directory. Any verifier
change to that control directory is an evidence failure, even if the verifier
reports success. Handoff checks establish structural file evidence; they do not
prove that every finding was understood.

For headless isolation, the evaluator gives each root session a session-scoped
`permissions` array with a deny rule for external directories using the OpenCode
V2 shape `{ action: "external_directory", resource: "*", effect: "deny" }`.
Native children inherit that control. It is an evaluator control, not the normal
plugin's permission policy:
ordinary use keeps the host's `ask` behavior and does not auto-allow outside
paths. A denied outside read remains tool evidence and an error metric.

The root Plan session uses only a nonrestrictive origin marker; its context-tool
filter and `execute.before` guard enforce root read-only behavior without a
root deny-all session policy. Children inherit the marker at creation, and the
first child context uses the host's native session permission setter to install
persistent read-only rules, filtering, and the guard. If the host cannot expose
a supported setter, the dispatch hook fails closed instead of allowing an
unverified Plan child. Removing the marker from a parentless `Build` context
does not rewrite its original permissions; existing Plan children retain their
child policy.

After a tiered delegation, the primary allowlist is native orchestration,
read/search tools (`read`, `glob`, `grep`, `webfetch`, and `websearch`), and the
exact scenario-declared fixture verification command. Unknown commands fail the
assessment; there is no arbitrary shell or shell-regex allowlist. Mutation
commands remain delegated. The root evaluator permits that declared verification
once, after the final execution delegation; it does not permit repeated or
unrequested root commands. The direct control is intentionally permissive about
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
