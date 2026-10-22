# Inference speed: Standard, Fast, and Ultrafast

`ProviderConfig.serviceTier` selects inference speed independently of the model
and reasoning effort. It works with `execute()`, new sessions, and resumed
sessions. Omitting it preserves native defaults; `"default"` explicitly selects
Standard. Agent Ex never enables a paid tier automatically.

| Provider | Tier IDs | Minimum CLI for this integration |
| --- | --- | --- |
| Codex | `default`, `priority` (`fast` alias), `ultrafast`, and future catalog IDs | 0.163.0 |
| Claude Code | `default`, `fast` | 2.1.205 |

Paid-tier availability depends on the model, account, organization settings, and
capacity. Fast and Ultrafast have different usage costs. Check the provider's
current terms: [Codex speed](https://learn.chatgpt.com/docs/agent-configuration/speed),
[OpenAI API Fast](https://developers.openai.com/api/docs/guides/fast-mode),
[OpenAI API Ultrafast](https://developers.openai.com/api/docs/guides/ultrafast-mode),
and [Claude Code Fast](https://code.claude.com/docs/en/fast-mode).

## Selecting a tier

```ts
import { getProvider } from "@agentex/agent";

const codex = getProvider("codex");
const fast = await codex.execute({
  cwd: "/path/to/project",
  prompt: "Explain the failing test",
  config: { serviceTier: "fast" },
});

// Change an existing thread to Standard, preserving its identity and history.
const standard = await codex.execute({
  cwd: "/path/to/project",
  prompt: "Now fix it",
  sessionParams: fast.sessionParams,
  config: { serviceTier: "default" },
});

// Claude Fast requires an explicit supported Opus model.
const claude = getProvider("claude");
const session = await claude.createSession!({
  cwd: "/path/to/project",
  config: { model: "opus", serviceTier: "fast" },
});
try {
  const turn = await (await session.send("Explain the failing test")).result;
  console.log(turn.serviceTier);
} finally {
  await session.close();
}
```

A session's configured tier applies to all its turns. To change it, close and
resume the session with a new config. `SendOptions` does not offer a tier override:
concurrent messages can join an already running inference turn, whose speed
cannot be changed by steering it.

Other providers do not implement this field. Check
`provider.capabilities.serviceTiers` before offering a speed control.
`probeCapabilities()` checks the installed CLI version; it does not establish
account entitlement.

## Discovering choices

```ts
const models = await codex.listModels!({
  cwd: "/path/to/project",
  config: { extraArgs: ["--profile", "work"] },
  cacheTtlMs: 30_000,
});
for (const model of models) {
  console.log(model.id, model.defaultServiceTier, model.serviceTiers);
}
```

`ProviderModel.serviceTiers` contains `{ id, name, description?, availability?,
reason? }`. `defaultServiceTier` preserves Codex's advertised default. Missing
metadata means unknown, and an empty native tier list permits only Standard.
Codex catalog IDs are retained, with Fast normalized to `priority`.

`availability` is `available`, `unavailable`, or `unknown`. A model advertising
Fast is not proof that this account can use it; paid tiers normally report
`unknown`. Disabled Codex feature flags or a disabled Claude Fast environment
report `unavailable`. Discovery honors the selected binary, effective environment,
endpoint, supplied Claude settings, and Codex config/profile. Cache keys include
those inputs and hash credential values rather than keeping them in the key.
Native credential-file metadata also participates, so an in-place login change
does not reuse the previous account's catalog. OS keychain changes are not
observed by this file fingerprint. Use `cacheTtlMs: 0` to refresh; the native CLI
may still maintain its own catalog cache.

Claude offers Fast for the supported Opus families (5.5, 5, 4.8), including the
`opus` and `opus[1m]` aliases and their endpoint/environment mappings. An implicit model, Sonnet,
Haiku, or an unrecognized model ID fails Fast validation before inference. This
prevents Claude Code from silently upgrading the model when Fast is enabled.
Claude does not offer Ultrafast. Known Bedrock (including Mantle), Vertex/Agent
Platform, Foundry, and Claude Platform on AWS routing marks Fast unavailable and
rejects an explicit Fast request. These checks use the effective environment,
including endpoint overrides and supplied `--settings` environment values.

## Observing what actually happened

`ExecutionResult.serviceTier`, `TurnResult.serviceTier`, and
`AgentSession.serviceTier` expose the same state:

```ts
interface ServiceTierState {
  requested: string | null; // explicit config, e.g. "fast"
  selected: string | null;  // native configuration, e.g. Codex "priority"
  effective: string | null; // observed processing speed, otherwise null
  reason: string | null;    // native fallback notification, when supplied
}
```

Updates arrive as `{ type: "service_tier", update: Partial<ServiceTierState> }`
stream events. Effective speed resets each turn; results retain that turn's
snapshot even when another send starts. Subagent speed reports do not overwrite
the root session's state.

Codex start/resume and settings notifications establish `selected`. They do not
prove processing speed. `effective` remains null unless the runtime forwards an
actual API `response.completed.service_tier` report. Claude's `usage.speed`
reports `fast` or `standard` (normalized to `default`); Fast-mode notifications
surface their explanation without guessing the actual tier. A run may request
Fast and report Standard after a native fallback. No speed observation means
unknown, not Standard. These observations are not a billing receipt.

## Validation, settings, and transport

Explicit invalid or unsupported selections throw `ServiceTierConfigurationError`
before inference. Its `code` is `invalid_tier`, `unsupported_runtime`,
`unsupported_model`, `conflicting_settings`, `unavailable`, or `discovery_failed`.
Provider errors encountered during inference still follow the usual execution
and turn error paths. Unset tiers preserve compatibility with older runtimes.

Codex passes the canonical tier through startup config and explicitly through
`thread/start`, `thread/resume`, and `turn/start`. It checks feature flags and the
actual selected model's catalog before starting a turn. A policy rejection on
resume is never retried as a new conversation. Explicit `default` suppresses a
saved or catalog-selected paid tier.

When `execute()` has an explicit `serviceTier`, it runs one bounded turn through
`app-server`, including timeout/cancellation, output, usage, session identity,
and workspace handling. This is necessary because native `codex exec resume`
restores the saved tier over a startup `-c` override. With no `serviceTier`,
existing execution routing is preserved: app-server for `skillDirs`, otherwise
native `codex exec`. Explicit tiers also preserve process-scoped skill isolation.
For typed-tier executions, raw
`extraArgs` must be valid for `app-server`/root config; exec-only flags do not
apply. Prefer the typed options.

Typed-tier executions preserve the cross-directory resume guard: changing `cwd`
or preparing a worktree starts a fresh thread and reports `clearSession: true`.
Direct `createSession()` resumes explicitly select the requested `cwd`. Both
paths verify the native working directory before inference. Cancellation covers
the startup handshake; each startup RPC also has a 30-second bound independent
of the execution deadline. Native cumulative token notifications are converted
to per-turn input, output, and cached-token usage, excluding resumed history and
child threads. The fallback log scanner honors the child's Codex home.

Claude translates the selection to `fastMode: true/false`. If `extraArgs` already
contains `--settings`, Agent Ex reads the final settings argument (inline JSON or
file, matching CLI precedence) and preserves its other fields. The merged JSON
is staged in a private file with mode `0600` and removed when execution ends or
the session closes/exits. Existing settings contents are not copied into argv.
Global settings files are never rewritten. Native organization policy and
fallback behavior remain in force.

Contradictory explicit raw settings are rejected: Codex `service_tier` must agree
with `config.serviceTier`, and Claude's supplied `fastMode` must agree. Known
Fast-disabling environment and per-session settings also fail validation rather
than being overridden.

Gateway configs accept the same field on both the default `agent` and named
`agents` entries:

```yaml
agent:
  provider: claude
  cwd: /path/to/project
  model: opus
  serviceTier: fast
```

## Verification and upstream references

The integration was checked against Codex CLI 0.163.0 and Claude Code 2.1.305 on
2026-10-22. Regression tests cover execution, fresh/resumed sessions, discovery,
configuration conflicts, unsupported runtimes/models, fallback reporting,
concurrent-turn snapshots, cancellation during initialization and execution,
working-directory verification, usage accounting, credential-file changes,
unsupported Claude transports, model aliases, and temporary-file cleanup.

Run `pnpm --dir packages/agent smoke:service-tiers` with both CLIs installed to
exercise them against a local fake HTTP API with isolated CLI homes. It checks
Codex Fast → Standard → Ultrafast on the same resumed thread, and Claude
Fast → Standard across resumed executions and persistent sessions, including
request fields and reported speed. It also checks Codex usage parity with native
exec, per-turn cached tokens on resume, changed directories, isolated worktrees,
and the Claude `opus[1m]` alias. It makes no paid model requests.
The synthetic Codex catalog and local Claude availability bypass are confined to
that test; this verifies wire behavior, not live entitlement or latency.

The inspected public Codex source is pinned to
[`9a8a85bc539325f2819dd0717f88b6ba6286495e`](https://github.com/openai/codex/tree/9a8a85bc539325f2819dd0717f88b6ba6286495e):

- [Config normalization and feature gates](https://github.com/openai/codex/blob/9a8a85bc539325f2819dd0717f88b6ba6286495e/codex-rs/core/src/config/mod.rs)
- [Exec resume configuration](https://github.com/openai/codex/blob/9a8a85bc539325f2819dd0717f88b6ba6286495e/codex-rs/exec/src/lib.rs)
- [Thread resume protocol](https://github.com/openai/codex/blob/9a8a85bc539325f2819dd0717f88b6ba6286495e/codex-rs/app-server-protocol/schema/typescript/v2/ThreadResumeParams.ts)
- [Turn protocol](https://github.com/openai/codex/blob/9a8a85bc539325f2819dd0717f88b6ba6286495e/codex-rs/app-server-protocol/schema/typescript/v2/TurnStartParams.ts)
- [Model tier metadata](https://github.com/openai/codex/blob/9a8a85bc539325f2819dd0717f88b6ba6286495e/codex-rs/app-server-protocol/schema/typescript/v2/Model.ts)

Claude transport and fallback behavior follow its
[Fast-mode documentation](https://code.claude.com/docs/en/fast-mode) and
[Messages API speed reporting](https://platform.claude.com/docs/en/build-with-claude/fast-mode).
