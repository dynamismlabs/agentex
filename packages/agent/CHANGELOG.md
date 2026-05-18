# Changelog

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
