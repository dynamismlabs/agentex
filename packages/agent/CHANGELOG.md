# Changelog

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
