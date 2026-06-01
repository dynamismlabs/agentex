# Changelog

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
