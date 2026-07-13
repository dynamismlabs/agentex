# Changelog

## 0.0.29 — Local Claude and Codex history import

### Added

- Claude and Codex expose `provider.localHistory` for bounded, content-free
  presence probes, main-session discovery, normalized historical reads,
  line-aligned checkpoints, and source fingerprints.
- Local history includes human messages alongside the normal `StreamEvent`
  vocabulary. `(eventId, partIndex)` is stable across repeated reads when one
  source record produces several normalized events.
- Codex discovery uses rollout JSONL as its canonical read-only source and
  reads `session_index.jsonl` plus compatible SQLite state databases only for
  optional titles.
- Added `pnpm --filter @agentex/agent diagnose:history`, which reports only
  structural counts and durations from local stores.
- Limited discovery orders candidates using file metadata and stops transcript
  inspection once enough eligible sessions are found.
- `mainSessionsOnly: false` includes Claude nested subagents with stable parent
  identities and inherited project context. Legacy Codex reads retain
  unwrapped tool calls and tool results.

### Changed

- File-backed Codex normalization now preserves its deterministic synthetic
  transcript event id through `codexLineToStreamEvents()` and durable session
  catch-up.
- Strong fingerprints use one file descriptor and verify metadata after
  hashing. Completed transcript reads report `source_changed_during_read` when
  the opened source changes before EOF verification.

## 0.0.28 — OpenCode and Cursor integration contracts

Additive release. OpenCode is now a fully managed session provider and Cursor
is a runtime-probed, exec-backed session provider. Existing provider APIs are
unchanged. New provider and session members are optional so current consumers
remain source-compatible.

### Added

- **OpenCode authenticated session runtime.** `createSession()` owns a pooled
  password-authenticated loopback `opencode serve` process, consumes SSE, maps
  model, variant, and agent independently, resumes provider session IDs, and
  shuts the daemon down when its final handle closes. Runtime generations are
  retired after credential changes so stale processes cannot keep old auth.
- **OpenCode permission and question handling.** Pending requests reconcile at
  startup and while a turn runs. Host decisions are cached across failed reply
  attempts, so a transient HTTP failure does not ask the user twice. Allowed
  permissions reply `once`, never persistent `always`. Observed requests use
  the new `inputRequestTimeoutSec` deadline (300 seconds by default) and
  `unattendedPermissionPolicy` controls the no-callback fallback.
- **OpenCode provider and model management.** `listModels()` returns qualified
  `provider/model` IDs, limits, prices, modalities, tool support, and separate
  provider-native variants. `listModes()` returns primary OpenCode agents.
  `upstreamProviders` lists providers and auth methods, writes API keys, runs
  OAuth, and capability-gates credential removal against the running schema.
- **OpenCode durable service history.** `session.describeHistory()` and
  `provider.attachHistory()` provide chronological, bounded, opaque-cursor
  pagination with stable message/part checkpoints. Event ordinals prevent
  duplicate replay when one OpenCode part normalizes into multiple events.
- **Cursor sessions and discovery.** `createSession()` promotes the session ID
  emitted by one turn into `--resume` for the next. `listModels()` uses the
  installed Cursor catalog, including Grok when Cursor exposes it, while
  `listModes()` only returns modes proven by the selected CLI help profile.
- **Effective runtime probing.** OpenCode and Cursor implement
  `probeCapabilities()` and return binary status, version, protocol profile,
  and per-capability status. Unsupported older Cursor installations report
  `upgrade_required`.
- **Provider-neutral capability growth.** Added optional runtime capability
  reports, model variants, resumability, permission/question support,
  service-backed durable history, session mutation flags, and the upstream
  provider manager types.
- **Legacy durable-history bridge.** Claude and Codex implement
  `attachHistory()` adapters over their existing durable session attachment.

### Changed

- OpenCode `skillDirs` are staged in an isolated `OPENCODE_CONFIG_DIR` seeded
  from native config. One-shot and session execution no longer mutate the
  user's global skill directories.
- OpenCode one-shot and session turns emit exactly one normalized terminal
  `result`. Wire `step_finish` records remain non-terminal unknown events.
- Cursor output is quarantined until the supported `system:init` acceptance
  marker. A failed resume may roll over once only before acceptance. Output is
  never replayed or retried after acceptance, and unsupported marker ordering
  fails explicitly with `protocol_degraded`.
- Cursor authentication checks only `CURSOR_API_KEY` for API billing and uses
  the selected binary's native `status` command for subscription state.

### Review hardening

- OpenCode credential changes now retire every daemon sharing the same
  `XDG_DATA_HOME` or HOME auth store, across projects and config overlays.
  Unrelated isolated auth stores remain running. Abandoned OAuth flows release
  their daemon handle automatically at the advertised expiry time.
- OpenCode model metadata reads the 1.3.2
  `capabilities.input.image` / `capabilities.toolcall` schema while retaining
  compatibility with older modality fields.
- Cursor only reports sessions, resume, and its stream-json protocol profile
  when the selected CLI advertises print, resume, and `stream-json` as an
  explicit output format. A generic `--output-format` flag is not sufficient.
  Runtime output quarantine remains the final per-turn protocol check.
- Every new runtime, history, list-model, and upstream-provider type is exported
  from the package root and covered by a compile-time public-contract test.
- Claude durable records always persist the effective cwd, attachment resumes
  there unless explicitly overridden, and goal hydration completes before the
  session is exposed. Historical hydration cannot overwrite newer live state
  or restart polling after close.
- Claude and Codex attachment reject records owned by another provider and
  classify the latest meaningful raw turn boundary, including user prompts
  and Codex `task_started` records that replay normalization intentionally
  drops. Trailing system, rate-limit, goal, and telemetry records are ignored.
- Rejected goal sentinels now terminate as `blocked` with
  `blockedReason: "sentinel_error"` and an `errorMessage`, rather than escaping
  as an unhandled rejection and leaving the goal active. Codex
  `usageLimited` maps to a budget block.
- Derived durable providers preserve their derived provider ID across
  `describe`, attachment, and history records. Resume reapplies the derived
  env, command, mode, cwd, and session parameters instead of falling through
  to the unmodified base provider. Upstream provider authentication and
  disconnect operations receive the same derived runtime overlays, keeping
  isolated OpenCode credential stores isolated.
- Codex endpoint header names are emitted as quoted TOML path segments, so
  valid names containing dots cannot become nested configuration keys.

### Compatibility and limits

- OpenCode 1.3.2 is the release-tested server schema. Safe disconnect uses
  `DELETE /auth/{providerID}`. A newer credential-ID schema remains disabled
  until its provider-to-credential mapping can be proved.
- OpenCode MCP attachment remains disabled. Agentex does not claim it until it
  can exclude ambient OpenCode MCP configuration reliably.
- Cursor requires a CLI profile with model discovery and the validated
  stream-json `system:init` marker. Older installed binaries remain usable for
  direct one-shot calls where their protocol matches, but runtime probing asks
  the host to upgrade before exposing the new catalog and session UI.
- Cursor has no permission/question bridge and no mid-session model or mode
  mutation. Changing those selections starts a new host session.

## 0.0.27 — Codex session reasoning effort

### Fixed

- **Codex session reasoning effort.** Multi-turn Codex sessions now forward
  `ProviderConfig.effort` through the app-server `turn/start.effort` field.
  The one-shot `execute()` path already mapped effort to
  `model_reasoning_effort`; `createSession()` now honors the same provider
  contract for both fresh and resumed threads.

## 0.0.26 — durable sessions: `describe` / `attachSession` / `catchUp`

Additive, **zero breaking changes**. Every addition is an optional interface
member or a new export; the existing `createSession`/resume flow is untouched
and remains the only spawn path. Upgrading requires no consumer changes.

The agents underneath agentex are disk-durable (Claude transcripts + `--resume`;
Codex SQLite threads + `thread/resume`), but the only session abstraction was a
live in-memory handle — every host had to assemble its own restart-recovery
layer from the raw parts (`sessionCodec`, `transcript` ops, `ctx.sessionParams`).
This release ships that composition as three optional additions.

### Added

- **`SessionRecord`** — one blessed, JSON-serializable session identity a host
  persists (`{version, providerType, params, cwd, displayId, updatedAt}`).
  Produce it with `session.describe()` (new optional `AgentSession` member —
  returns null until the provider assigns a session id) or `createSessionRecord(...)`.
  Helpers `isSessionRecord` / `assertSessionRecord` (throws
  `MalformedSessionRecordError` naming the offending field) validate one, and a
  new `./sessions` subpath exports them all.
- **`provider.attachSession(record, opts?)`** — read-only reattachment (new
  optional `ProviderModule` member; implemented for Claude + Codex). Locates the
  on-disk transcript, classifies how the last turn ended
  (`lastTurn: "completed" | "interrupted" | "unknown"`), and returns a
  `SessionAttachment` with:
  - **`catchUp(opts?)`** — replays normalized `StreamEvent`s from the transcript
    with a byte `offset` per event to checkpoint and pass back as `fromOffset`.
    Claude yields the stable wire `eventId`; Codex yields `null` (no wire id).
  - **`resume(ctx?)`** — continue live. Exactly
    `createSession({ ...ctx, sessionParams: record.params })` — one resume path,
    **never auto-invoked** (a restart must not spontaneously re-run turns).
- **`codexLineToStreamEvents(line, ctx)`** — the library now normalizes Codex
  on-disk rollout lines into `StreamEvent`s (the map/drop table Flow previously
  hand-maintained in `codex-on-disk.ts`), so `catchUp` yields the same event
  vocabulary for both providers. Exported from `@agentex/agent` and
  `@agentex/agent/providers/codex`.
- **`capabilities.durableSessions`** — honest feature detection: `true` for
  claude and codex (they implement `attachSession`), absent everywhere else.
- **`scripts/durable-session-demo.ts`** (`pnpm demo:durable`) — end-to-end
  proof: start a session, crash the host mid-turn in a separate process,
  reattach in a fresh one → `interrupted`, `catchUp` replays, `resume` continues.

### Changed

- **`StreamEvent` union-growth policy documented.** The union grows in minor
  versions (the `goal_status` precedent); consumers MUST keep a `default` branch
  when switching on `type`. Stated in the `StreamEvent` JSDoc — not a code change.

### Documented limitations (not future promises)

- **Pending user-input requests do not survive a restart** — the CLI process and
  its stdio died. Attach reports `lastTurn: "interrupted"` so hosts can re-prompt.
- **Attach for other providers** (acp/gemini/copilot/cursor/opencode/pi/openclaw/
  process) — no durable on-disk transcript contract today, so `durableSessions`
  is simply absent for them.
- **Cross-machine records** — a record references local transcript state; moved
  to another machine it yields `transcript: null, lastTurn: "unknown"` (attach
  still works, `catchUp` yields nothing, `resume` may still succeed).

## 0.0.25 — packaging perf: lazy providers + subpath exports

Non-breaking. **Zero API changes** — every exported signature, event shape, and
session semantic is identical to 0.0.24. This release makes importing the
package cheap: a consumer that only needs one util no longer pays for the whole
provider registry, and the registry no longer eagerly evaluates all nine
providers' heavy machinery.

The lever is that every `ProviderModule` method (`execute`, `createSession`,
`resolveAuth`, `listModels`, `listModes`, `checkQuota`) was already async, so the
laziness lives *inside* each provider's method bodies via dynamic `import()` —
invisible to callers. `getProvider` stays synchronous; only heavy modules
(`session.ts`, `execute.ts`, parsers, the ACP SDK) load on first use.

### Added

- **Subpath exports.** Beyond `"."`, the package now exports `./registry`,
  `./derived`, `./types`, `./goals`, `./utils/*` (wildcard), `./providers/*`
  (wildcard → each light provider index), plus the three blessed deep modules
  `./providers/claude/parse`, `./providers/claude/transcript`,
  `./providers/codex/transcript`, and `./package.json`. This unlocks
  browser-safe entry points — e.g. `@agentex/agent/providers/claude/parse` is
  pure (type-only imports, no `node:*`), so consumers no longer need a
  hand-written client-safe mirror. `_shared/` stays private by convention.
- **`"default"` export condition** on every entry (folds in the old TODO
  "Package exports — CJS consumer ergonomics"): `require(esm)` now resolves on
  Node ≥ 20.19, so a CJS/tsx consumer can `require("@agentex/agent")` without
  the dynamic-`import()` dance. Conditions are ordered `"types"` → `"import"` →
  `"default"` in every block.
- **`scripts/measure-import.ts`** — a tool (not a test) that prints import time
  and dist-module count per entry point. Used to produce the table below.
- **`tests/packaging/`** — five checks that pin this design: `no-tdz`,
  `lazy-graph` (a loader-hook module census proving no heavy module loads from
  the barrel), `exports-map` (every subpath resolves at runtime + under TS
  `bundler`/`node16`), `tree-shake` (esbuild proof), and `utils/uuid`.

### Changed

- **`sideEffects: false`.** Truthful now that the only cross-module side effect
  (the ACP factory registration) is gone (see Fixed). Bundlers can tree-shake
  the package: a one-util import from the barrel bundles to **308 bytes** with
  the entire provider registry shaken out.
- **`engines.node` → `>=20.19.0`** (was `>=18`). Support-matrix honesty for the
  `"default"` / `require(esm)` condition — not a runtime break; the code already
  targeted modern Node.
- **Dropped the `uuid` dependency.** `utils/uuid.ts` is now a local RFC 9562
  UUIDv7 (48-bit ms timestamp + 74 random bits via `crypto.getRandomValues`),
  removing 22 runtime modules and leaving `@agentclientprotocol/sdk` as the sole
  runtime dependency. Callers need uniqueness + rough time-sortability, both
  covered by `tests/utils/uuid.test.ts`.
- **Ship `src` in the package** (`files: ["dist", "src"]`) so the published
  `*.js.map` / `*.d.ts.map` `sources` paths resolve — go-to-definition and
  debugger stepping into the package now work (~0.5 MB larger tarball).
- **`registerAcpFactory` is no longer required before `loadProvidersFromConfig`.**
  The loader defaults to the built-in `acpProvider`; `registerAcpFactory` stays
  exported and honored as an override hook.

### Fixed

- **TDZ crash on direct provider import.** `import("@agentex/agent/providers/gemini")`
  (and `copilot`) threw `ReferenceError: Cannot access 'geminiProvider' before
  initialization` via the cycle `gemini → acp → derived → registry → gemini`.
  Masked previously because the barrel was the only entry point; a hard blocker
  for subpath exports. The cycle is broken by making `derived.ts` import the ACP
  provider directly and dropping the registry's bare ACP side-effect import. All
  ten provider modules now import clean as an entry point.

### Perf (measured via `scripts/measure-import.ts`, Node 24.2, warm FS cache)

| Metric | Before (0.0.24) | After (0.0.25) | Target |
| --- | --- | --- | --- |
| Runtime import, barrel (`.`) | ~80–100 ms | **~26 ms** (min of 5) | ≤ 40 ms |
| Runtime dist-module graph, barrel | ~90 modules | **46 modules** | — |
| Runtime import, `./utils/ask-user-question` | 7 ms (unreachable) | **~8 ms, 1 module, reachable** | ≤ 8 ms |
| esbuild inputs, one-util subpath import | 159 | **2** | ≤ 3 |
| esbuild one-util barrel import (tree-shaken output) | 881 KB | **308 bytes** | — |
| Bundler barrel import with code-splitting (initial chunk) | ~881 KB (one chunk) | **~22 KB** initial + lazy provider chunks | — |
| Direct import of each provider module | 2 crash | **0 crash** | 0 |
| Breaking API changes | — | **0** | 0 |

**Bundler note (per the design's risk analysis).** The runtime and subpath wins
are unconditional. For a bundler that ingests the *whole barrel*, the provider
bodies drop out of the initial load only when the bundler **code-splits**
dynamic `import()` (Next/webpack/turbopack do — see the ~22 KB initial chunk
above) or when the consumer marks the package external
(`serverExternalPackages` in Next). An esbuild bundle with splitting *disabled*
inlines dynamic imports, so its raw `metafile.inputs` count only drops by the
`uuid` modules (~141); split or external, the heavy bodies become lazy.

Additive. Point a provider at a custom, Anthropic/OpenAI-compatible endpoint (BYOK, self-hosted gateway, alternative model) per session, without registering a derived provider. One normalized `ProviderConfig.endpoint` is translated to each CLI's own dialect at spawn — Claude via env vars, Codex via a synthesized `[model_providers.custom]` block. Frozen for the process lifetime, so it is a per-`createSession`/per-`exec` property (resume re-applies it).

### Added

- **`ProviderConfig.endpoint` (`ProviderEndpointConfig`).** `{ baseUrl?, authToken?, apiKey?, headers?, modelMap? }`. Claude maps to `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN`/`ANTHROPIC_API_KEY` + `ANTHROPIC_CUSTOM_HEADERS`, with `modelMap` (tier alias → concrete id) → `ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU,FABLE}_MODEL`. Codex synthesizes a `model_provider="custom"` block (`base_url`, `wire_api="responses"`, `env_key`); `modelMap` is ignored (no tier aliases — pass a concrete `model`). Providers without a custom-endpoint mechanism ignore it, like `allowedTools`.
- **`translateEndpoint(providerType, endpoint)` + `EndpointTranslation`,** exported, plus the `CODEX_CUSTOM_PROVIDER_ID` / `CODEX_CUSTOM_KEY_ENV` / `CODEX_CUSTOM_HEADER_ENV_PREFIX` constants for hosts that need the synthesized names.

### Security

- **No ambient-credential leak to a third party.** When a custom `baseUrl` is set, only the auth declared in `endpoint` reaches it — ambient `ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN` seeded from the host env are cleared, and so is alternate-routing config (`ANTHROPIC_BEDROCK_BASE_URL`, `CLAUDE_CODE_USE_BEDROCK`/`VERTEX`/`FOUNDRY`) so ambient Bedrock/Vertex can't steer Claude off the endpoint or rewrite the model id. General AWS creds are left intact for tool use.
- **Codex header values never hit argv.** `headers` route through Codex `env_http_headers` (header name in argv, value in env), so a secret header (`Authorization`, `X-API-Key`) doesn't leak via `ps` — mirroring how the Claude provider stages MCP headers off the command line.
- **`redactEnvForLogs` masks header carriers.** Added `HEADER` to the sensitive pattern so `ANTHROPIC_CUSTOM_HEADERS` and the generated `CODEX_CUSTOM_HEADER_*` vars are redacted in logs, not just the credential vars.

### Notes for consumers

- **Codex speaks the OpenAI Responses API only.** The Chat Completions (`wire_api="chat"`) protocol was removed from Codex in Feb 2026, so a Codex custom endpoint must implement the Responses API, directly or via a translating gateway (e.g. LiteLLM). A pre-Feb-2026 Codex needing `chat` can override on the `exec` path with `extraArgs: ["-c", 'model_providers.custom.wire_api="chat"']`.
- **`endpoint` is per-spawn.** It's read once at `createSession`/`exec`; there is no per-turn override. Change it by starting a fresh session (resume re-applies it).
- Prefer a derived provider when the same endpoint is reused across many calls; prefer `config.endpoint` when it varies per session and the host owns storage.

## 0.0.23 — Goals: cross-provider session objectives

A session-scoped **goal** primitive. Attach a durable objective and the library tracks it to a terminal state, normalizing Claude Code's Stop-hook sentinel and Codex's thread-goal state behind one event, one capability, and three session methods — with an emulation engine so it works on every provider. Verified end-to-end by driving the real CLIs (claude 2.1.191, codex 0.130.0) through the adapter.

### Added

- **`AgentSession.setGoal(objective, options?)` / `clearGoal(options?)` / `getGoal()`.** Arm a session goal; the library uses native enforcement where the provider has it (Claude's `/goal` Stop-hook + Haiku sentinel; Codex's `thread/goal/*` thread state) and an **emulation loop** (pluggable sentinel + continuation turns + iteration cap) everywhere else. `setGoal` resolves on *arm*, not completion — watch `goal_status` events for that. `objective` is capped at 4,000 chars; `options.enforce` (`provider`/`emulate`/`advisory`) and `options.sentinel` let a host force the engine or supply a deterministic check (e.g. run tests).
- **`goal_status` StreamEvent.** One normalized transition per real change — `status` (`active|paused|met|blocked|cleared`), `met`, `enforced`, `source`, `blockedReason?`, and Codex telemetry (`tokensUsed`/`timeUsedSeconds`/`tokenBudget`). `raw` keeps the provider-native record. One emitter per mode (parser when native, controller when emulated), so no intra-stream double-emit.
- **`ProviderCapabilities.goals` descriptor** — `mechanism` (`sentinel`/`model-tools`/`emulated`), `enforced`, `statuses`, `clears`, `telemetry`. claude = sentinel, codex = model-tools, pi/opencode = emulated.
- **`GoalController` + reconstruction helpers**, exported for hosts: `goalStateFromEvent`, `latestGoalFromEvents`, `normalizeClaudeGoalAttachment`, `normalizeCodexGoalStatus`, `normalizeCodexGoalRecord`, `createDefaultSentinel`, `parseAssessment`, `isTerminalGoalStatus`, `EMULATED_GOAL_CAPABILITY`, `GOAL_OBJECTIVE_MAX`, `CODEX_GOAL_TOOLS`, plus the `GoalState` / `GoalStatus` / `GoalOptions` / `GoalSentinel` / `SetGoalResult` / `ClearGoalResult` types.
- **Native observability + resume.** Claude writes `goal_status` only to the on-disk transcript (never live stdout), so a native goal session tails its transcript to surface `active`→`met` and restores an unmet goal on `--resume`. Codex rehydrates a durable goal on resume via `thread/goal/get`. Both confirmed live.

### Fixed

- **Codex failed turns are no longer reported as success.** codex 0.130 signals failure via `turn/completed` with `turn.status: "failed"` (carrying `turn.error.message`), not only `turn/failed` — agentex hardcoded `isError:false`, so a failed turn (e.g. a 4xx from the model API) looked `completed`. The parser + session now detect the failed status and the trailing `error` notification, reporting `status:"failed"` with the error text. Verified live.
- **Codex app-server turns no longer return a null summary.** v2 assistant items are `agentMessage` (camelCase) but the session only matched legacy `agent_message`, so every app-server turn left `TurnResult.summary` null. Both spellings are accepted now.

### Notes for consumers

- **`AgentSession` gained three required methods** (`setGoal`/`clearGoal`/`getGoal`). Additive for *callers*; only an external *implementer* of `AgentSession` would need to add them — the built-in providers already do.
- **Every Codex session now declares `capabilities.experimentalApi: true`** in its `initialize` handshake. This is required to reach the `thread/goal/*` methods (the app-server rejects them with `-32600 requires experimentalApi capability` otherwise) and is the same capability the official VS Code client declares. It gates access to experimental RPC methods, **not** turn semantics — verified against codex 0.130.0 that a normal turn still streams assistant + result unchanged.
- **Native Codex goals are experimental + opt-in.** They function only when `[features] goals = true` is persisted in `~/.codex/config.toml` (the `thread_goals` SQLite table is migrated at startup); otherwise the arm falls back to emulation. The `thread/goal/*` RPCs are timeout-bounded so an older app-server that ignores them can't hang `setGoal`/`clearGoal`/resume.
- A consumer with an exhaustive `switch` over `StreamEvent.type` will get a TypeScript nudge to handle `goal_status`.

## 0.0.21 — cross-runtime instruction files (`installInstructions`)

Additive. The instruction-file twin of `installSkills`: install an orientation brief into the right per-runtime file(s), with a managed-region merge that preserves user edits.

### Added

- **`installInstructions(content, opts?)`.** Writes a brief into per-runtime instruction files. Every runtime except Claude reads `AGENTS.md`; Claude reads `CLAUDE.md`. Two locations mirror `installSkills`:
  - `workspace` ({cwd}/) — deduped by filename, so the default writes `CLAUDE.md` + `AGENTS.md` once each. `includeNativeFiles: true` also writes Gemini's native `GEMINI.md` (Gemini reads `AGENTS.md` only when configured).
  - `global` — per-runtime home files (`~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md`, `~/.gemini/GEMINI.md`, `~/.config/opencode/AGENTS.md`, `~/.pi/AGENTS.md`). Cursor is omitted — its global config is app User Rules, not a file. There is no universal `~/AGENTS.md`, so global is inherently per-runtime.
- **Managed-region merge.** `content` is wrapped in `<!-- agentex:managed:start hash=… -->` / `…:end` markers; re-install replaces only that region and preserves everything the user wrote outside it. The embedded content hash makes re-installs byte-idempotent (reported `skipped`). `managed: false` overwrites the whole file (escape hatch for fully-owned files). Files are written mode 0644.
- **`removeInstructions(opts?)`.** Strips the managed region (deletes the file if nothing else remains); never touches user-owned files that have no managed region.
- **`resolveInstructionTargets(opts?)`.** Lists which files *would* be written, without touching disk.
- **`upsertManagedBlock` / `stripManagedBlock`.** The low-level merge/strip primitives, exported for hosts with custom layouts.
- **`getDefaultRuntimeHome(runtime, homeDir?)`** now accepts a base-directory override (defaults to `os.homedir()`) for sandboxed and `global` installs.

## 0.0.20 — MCP attachment fix, session controls, typewriter deltas, Codex event identity

Driven by consumer feedback from an embedding host wiring an orchestrator onto agentex sessions. All additive — except the MCP fix, which replaces behavior that never worked in any published version.

### Fixed

- **`config.mcpServers` actually attaches MCP servers now.** It previously emitted `--mcp-server <name> -- <command>…` — a flag that does not exist in Claude Code 2.x — so any run/session setting the field died instantly with `error: unknown option '--mcp-server'` (verified against claude 2.1.165; the field has never worked in any published version, so there is no behavior to migrate from). The config is now staged as a **mode-0600 JSON file** in a temp dir and passed via the real `--mcp-config <path>`, cleaned up with the run/session (including spawn-failure paths). Secrets never touch argv — http `headers` (bearer tokens) live only in the 0600 file; argv is world-readable via `ps`.

### Added

- **`McpServerConfig` http/sse transports.** Now a discriminated union: the stdio shape (`{name, command, args?, env?}`) is unchanged (type defaults to `"stdio"`), plus `{name, type: "http"|"sse", url, headers?}` for hosts embedding a local MCP server.
- **`ProviderConfig.strictMcpConfig`** → `--strict-mcp-config`: the session's MCP surface is *exactly* what you attach — a stray `.mcp.json` in cwd or user-scope servers can't leak into a product-controlled session. Works with or without `mcpServers` (strict + none = no MCP at all).
- **`ProviderConfig.allowedTools` / `disallowedTools`** → `--allowed-tools` / `--disallowed-tools` (comma-joined; patterns like `Bash(rm *)` and `mcp__server__*` pass through verbatim; deny wins). Silently ignored by codex — documented on the fields (its mechanism is permission profiles, not argv).
- **`assistant_delta` + `thinking_delta` stream events (typewriter).** Opt-in via `config.includePartialMessages` (claude `--include-partial-messages`). Purely additive: the consolidated `assistant` event still fires when the block completes; `messageId` on deltas matches it so hosts can reconcile optimistic delta text against the durable event; the wrapper's per-line `uuid` becomes `eventId`. Flag off ⇒ parsing is bit-identical to 0.0.19. `thinking_delta` is best-effort — on current Claude versions it is the **only** place thinking prose appears (the consolidated thinking block is withheld, signature-only). Validated live against claude 2.1.165.
- **Stable Codex event identity.** Transcript reads stamp a replay-stable synthetic `eventId` — `codex:<rolloutSessionId>:<lineStartByteOffset>` — giving hosts an idempotency key for transcript replays. Live v2 session events get `codex:<threadId>:<turnId>:<itemId>:<eventType>` where the components exist (an **upsert** key: repeated updates to one item intentionally share an id). The live and on-disk schemes deliberately differ (different wire vocabularies — `command_execution` vs `exec_command`); cross-shape dedup remains a host concern.

### Notes for consumers

- `extraArgs` remain appended **after** all generated flags (the host-override invariant), so existing `--mcp-config` / `--disallowed-tools` workarounds keep working — and can now be deleted in favor of the typed fields.

## 0.0.19 — Three-tier provider architecture: ACP tier, config-extend, Codex parity, live sessions

> **Note for npm consumers:** 0.0.18 was never published — its changes ship in this release alongside 0.0.19's. The loudest of them: `ProviderConfig.timeoutSec` now also arms a **per-send deadline on sessions** (previously it applied only to `execute()`). Hosts that set `timeoutSec` for exec-style runs will see session turns interrupted at that deadline too — see the 0.0.18 section below.

A three-tier provider architecture (deep-native · ACP · bespoke). The ACP tier and gemini's migration are validated end-to-end against real agents. See [`internal-docs/spec-provider-architecture.md`](../../internal-docs/spec-provider-architecture.md). Nothing here breaks the existing public surface.

### Added

- **Reusable `httpAgent` base for remote gateway agents.** Extracted OpenClaw's HTTP pattern into `runHttpAgent` / `httpAgentProvider({ providerType, defaultBaseUrl, runPath, … })`: gateway-URL resolution (per-call command → saved `sessionParams` → default), session-key round-trip, 401/403 → `auth_required` event, AbortController timeout, and customizable `buildBody`/`extractSummary`/`extractSessionKey` hooks. OpenClaw is refactored onto it with zero behavior change. The shape any "agent behind a URL" reuses.
- **Pi persistent sessions.** `pi` gains `createSession` backed by a long-lived `pi --mode rpc` process: each turn writes a JSONL `prompt` command and streams events (assistant deltas, tool start/end) → `StreamEvent`s, resolving the `TurnResult` on `agent_end`. Strict `\n` framing per Pi's RPC contract, ordered event dispatch, per-send timeout/abort (sends an `abort` command), and file-based resume via `sessionParams`. One-shot `execute()` is unchanged.
- **OpenCode live sessions (HTTP + SSE).** `opencode` gains `createSession` backed by the `opencode serve` daemon: a ref-counted server pool, session create/resume over HTTP, live token/tool streaming off the SSE `/global/event` feed mapped into `StreamEvent`s, and an authoritative `TurnResult` (summary, cost, token usage) from the `POST /message` response. One-shot `execute()` is unchanged. Validated end-to-end against the real `opencode` binary.
- **Gemini is now ACP-backed; Copilot added.** `gemini` moved from its one-shot `--output-format stream-json` stub to `gemini --acp` over the ACP base — it gains real sessions, streaming, tool-call correlation, permission bridging, and mode discovery (validated end-to-end against the real Gemini agent). `copilot` (`copilot --acp`) is a new provider — a handful of lines, because the ACP tier does the work. The bespoke gemini parser/codec/execute and their fixtures are deleted (net code reduction). **Cursor stays on its current transport for now** — the shipping `cursor-agent` exposes no ACP mode; it can move to ACP via `extends: "acp"` once it does.
- **ACP provider tier (Agent Client Protocol).** `acpProvider({ id, command, env, models, modeId, transformers })` builds a provider over the open [ACP](https://agentclientprotocol.com) standard (JSON-RPC over stdio) using `@agentclientprotocol/sdk` — one tested base for the long tail of agents (Gemini, Cursor, Copilot, and any ACP-compatible agent). It spawns the agent, runs the `initialize`/`newSession` handshake, streams `session/update` notifications into agentex `StreamEvent`s (assistant / thinking / tool_call / tool_result, with real tool-call correlation), bridges ACP `requestPermission` to `onUserInputRequest`, discovers modes via `listModes()`, and supports per-agent `transformers` (modes / modeId) to absorb quirks without forking. The SDK is dynamic-imported, so it's only loaded when an ACP session actually runs. Config-extend `extends: "acp"` builds these from a config file.
- **Config-extend / derived providers.** `defineDerivedProvider({ id, extends, env, command, models, modeId })` builds a new provider id that inherits a built-in's behavior with an env/command/model overlay — the canonical use is BYOK gateways (point `extends: "claude"` at `env.ANTHROPIC_BASE_URL` for z.ai / Qwen / a local proxy, no new code). `loadProvidersFromConfig(json)` registers a whole `{ providers: { … } }` map (also accepts Paseo's `agents.providers` nesting and `extends: "acp"`), validated with typed `MalformedProviderConfigError`s. `pnpm smoke --config <path>` loads and exercises them.
- **Operating-modes contract.** New `AgentMode` type and optional `ProviderModule.listModes(options?)`, plus `ProviderConfig.modeId` for selecting a mode and a `capabilities.modes` flag (with optional `capabilities.dynamicCapabilities` for runtime-negotiated providers). Additive — providers that don't support modes omit `listModes` and set `modes: false`.
- **Codex session resume.** `createSession` now honors `ctx.sessionParams` (a prior `sessionId` / `thread_id`) by issuing `thread/resume` to continue the *same* Codex thread with full context — previously every session cold-started a fresh `thread/start` and the saved session id was ignored. On an unknown thread it falls back to a fresh thread with a stderr notice rather than failing the session.
- **Codex collaboration modes.** `codexProvider.listModes()` discovers Codex's collaboration modes via `collaborationMode/list`; `config.modeId` applies a chosen mode to a fresh `thread/start` (a resumed thread keeps its original mode). `capabilities.modes` is now `true` for Codex.
- **Codex structured questions.** The app-server `requestUserInput` (and legacy `tool/requestUserInput`) server→client request is now bridged to `onUserInputRequest` as an `AskUserQuestion`, with answers mapped back into Codex's `{ answers: { [id]: { answers: [] } } }` shape — Codex sessions can answer questions headlessly.

### Fixed

- **Codex tool-approval response shape.** Command/file approval requests are now answered with `{ decision: "accept" | "decline" }` (Codex's actual app-server contract) instead of `{ approved: boolean }`, which the app-server did not honor. Tool-permission gating in Codex sessions now works headlessly.

#### Hardening (from two independent adversarial reviews of the above)

- **ACP session resume.** The ACP provider returned `sessionParams` but never honored them — every turn started fresh while callers thought they were preserving context. `createSession` now reads `ctx.sessionParams` and resumes via ACP `session/load` when the agent advertises `loadSession`, falling back to a fresh session (with a stderr notice) otherwise.
- **Bounded ACP handshake.** `connect()` and `listAcpModes()` now time out (30s) around `initialize`/`newSession`/`loadSession`, so a hung agent binary can't hang session creation or mode discovery forever.
- **OpenCode daemon pooling key.** The server pool keyed only on binary + cwd; sessions with different auth/config (env or flags) could silently share one daemon. The key now includes a hash of the env + prefix args. Spawn failures (ENOENT) are also handled.
- **Config-extend command arrays.** A non-ACP derived provider given a multi-element `command` array silently dropped everything past the binary; it's now rejected with a clear `MalformedProviderConfigError` (use `extends: "acp"` for binary+args).

- **Turn isolation across all session providers (ACP, OpenCode, Pi).** A turn that timed out or was aborted while the agent kept emitting could let those late events bleed into the *next* turn's summary/event stream. Each provider now drains the interrupted turn (awaits the agent's cancel ack, bounded) and drops between-turn stragglers, so a timed-out turn can't contaminate the next. Regression-tested end-to-end.
- **Resource leaks on failed connect.** The OpenCode session leaked its pooled `opencode serve` process if session creation failed after acquiring the server; the ACP session leaked its child on a handshake failure; `listAcpModes` leaked its probe process if `initialize`/`newSession` threw. All now release/kill on every failure path.
- **ACP spawn-error crash.** A failed ACP agent spawn (ENOENT) emitted an unhandled `'error'` event that could crash the host. Now handled.
- **OpenCode error tool-results.** Error tool results read `state.output` (always absent on error) instead of `state.error`, losing the failure message. Fixed against the verified OpenAPI shape.
- **Codex session-state correctness.** A slow approval/question handler could clobber a finished turn's state back to `thinking`; questions now use `waiting_for_input` (vs `waiting_for_approval`), header-only questions are no longer dropped, and the modes-discovery RPC is bounded so it can't hang the handshake.
- **HTTP-agent abort vs timeout.** A caller-signal abort was misreported as a `timeout`; it now returns `aborted`. A transient network error no longer discards the caller's `sessionParams` (so resume survives a recoverable failure).
- **`tool_result.toolName` for ACP** is backfilled from the originating `tool_call` (agents often omit `title` on the terminal update).

### Notes for consumers

- **`ProviderCapabilities` gains a required `modes: boolean` field.** Consumers only read capabilities, so this is additive in practice; only code that *constructs* a `ProviderCapabilities` literal (e.g. a custom provider via `registerProvider`) must add `modes`.

## 0.0.18 — Per-send timeout, tool_result.toolName, drain()

Scheduled / fire-and-forget session runs needed three things the SDK pushed onto every consumer. They now live in the library.

### Added

- **Per-send timeout & abort via `SendOptions`.** `session.send(message, { timeoutSec, signal })`. On `timeoutSec` expiry the library interrupts the active turn and resolves that send's `result` with `status: "timeout"` — no more consumer-side `Promise.race` + `interrupt()`. A per-send `AbortSignal` ends just that turn (resolves `"aborted"`), distinct from `SessionContext.signal` which closes the whole session. `ProviderConfig.timeoutSec` now also acts as the session-level default timeout for `send()` (previously it was read only by `execute()`). Honored by the Claude and Codex session providers.

- **`tool_result.toolName: string | null`** on stream events — mirrors the matching `tool_call.name`, correlated by the library so consumers no longer keep their own `toolCallId → name` cache. Populated on both the session and `execute()` paths for Claude and Codex; set directly by the Codex parser, correlated via a bounded tracker for Claude. Null when no preceding `tool_call` was observed, or on providers not yet enriched (cursor/gemini stubs).

- **`AgentSession.drain(): Promise<void>`** — graceful stop: refuse new `send()` calls, await the in-flight turn's `result`, then `close()`. The right tool for budget gates, `SIGTERM` handlers, and schedule pauses, where `interrupt()` (loses work) and `close()` (kills mid-tool) are both wrong. Idempotent.

- **`SendHandle`, `SendOptions`, `CancelResult`** are now exported from the package entry point (previously only the `AgentSession` interface was).

### Fixed

- **Session `close()` now honors `ProviderConfig.graceSec`** for the SIGTERM → SIGKILL window (was hardcoded to 5s, ignoring the config field that `execute()` already respected). `drain()` uses the same configurable grace.

### Notes for consumers narrowing on the literal types

- `TurnResult.status` gains `"timeout"`. Exhaustive `switch`/narrowing over the old literal set will get a typecheck nudge to handle the new case — the intended outcome.
- `tool_result` events gain a required `toolName`. Consumers only ever *read* events, so this is additive in practice; only code that *constructs* `tool_result` literals needs the field.
- `AgentSession` gains `drain()`. Additive for consumers; only matters if you implement the interface yourself.

## 0.0.17 — Concurrent send + queue cancellation + Codex 0.130.0 compat

### Codex CLI compatibility

This release **requires `codex-cli` 0.130.0 or newer**. The interactive JSON-RPC mode moved from a top-level `--json` flag to the `app-server` subcommand, the `thread/start` response now nests the thread under `params.thread`, `turn/start` now takes `input` as a content-block array (`[{type:"text", text:"…"}]`) instead of a plain string, and responses omit the `jsonrpc:"2.0"` discriminator. All four shifts are reflected in `providers/codex/session.ts`; the one-shot `execute()` path (which uses `codex exec --json`) is unaffected.

### Breaking

- **`AgentSession.send()` return type changed** from `Promise<TurnResult>` to `Promise<SendHandle>`. `SendHandle` is `{ uuid: string; result: Promise<TurnResult> }`. Migrate by destructuring:

  ```ts
  // Before
  const result = await session.send("hello");

  // After
  const { result: resultP } = await session.send("hello");
  const result = await resultP;
  // Or, if you don't need the UUID:
  const { result } = await session.send("hello");
  const turnResult = await result;
  ```

- When multiple `send()` calls are coalesced into one turn by the CLI, the `result` Promises returned by each `send()` resolve with the **same** `TurnResult` object. Callers cannot assume 1:1 correspondence between `send()` calls and `TurnResult`s.

### Added

- **`AgentSession.cancel(uuid): Promise<{cancelled: boolean}>`** — cancel a queued user message before it starts processing. Wired to Claude's `cancel_async_message` control_request; no-op (returns `{cancelled: false}`) on providers without per-message cancel support.

- **`provider.capabilities.concurrentSend: boolean`** — descriptive flag: true when the underlying CLI accepts user messages mid-turn (Claude, Codex). Apps may use this to gate "type while working" UI.

- **`provider.capabilities.cancelQueuedMessage: boolean`** — descriptive flag: true when `cancel(uuid)` is meaningful on this provider (Claude only).

### Changed

- The internal `_state !== "idle"` guard in `ClaudeSessionImpl.send()` and `CodexSessionImpl.send()` is removed. Both providers' CLIs handle concurrent `send()` natively (Claude via its `messageQueueManager` queue + mid-turn drain; Codex via JSON-RPC message queueing). Apps wanting strict serialization can layer their own queue on top.

- `SessionState.state` is now strictly descriptive of the most recent observed lifecycle event. It does **not** gate `send()` callability for `concurrentSend` providers.

### Internal

- `ClaudeSessionImpl` and `CodexSessionImpl` now maintain a list of pending result-resolvers instead of a single `_turnResolve` / `_turnReject` pair. On each `result` / `turn.completed` event, every pending resolver is drained with the same TurnResult.

- New `_pendingControlResponses` map in `ClaudeSessionImpl` correlates outgoing `control_request` writes (currently just `cancel_async_message`) with incoming `control_response` events by `request_id`. `interrupt()` remains fire-and-forget.
