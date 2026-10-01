# Changelog

## 0.0.40 — Codex local history reads current rollouts

Codex 0.142 and later write paginated rollouts (`session_meta.history_mode: "paginated"`), which never contain the `event_msg` `user_message` that discovery used to find the person's messages. Every current rollout looked like it had no user message, so `localHistory.discover()` returned nothing: 0 sessions on a machine with 154 real ones. Checked against 561 real rollouts from Codex 0.142 to 0.159 and against the upstream persistence policy.

### Fixed

- **Codex discovery and read find user messages in paginated rollouts.** The person's words are read from the completed `UserMessage` item. Legacy rollouts never persist that item and paginated rollouts never persist `user_message`, so each message is read exactly once. The `response_item` user message beside it, which also carries injected context, is still not read as a human message.
- **Codex `exec` and `apply_patch` tool calls replay.** Current Codex runs shell work through freeform tools, written as `custom_tool_call` / `custom_tool_call_output`, which were dropped entirely (most tool activity in a current rollout). They now map to `tool_call` (`input` is the script or patch string the model wrote) and `tool_result`. This applies to `localHistory.read()` and `attachSession().catchUp()`.
- **Tool output written as content parts keeps its text.** Codex now also writes `function_call_output` / `custom_tool_call_output` output as a list of `input_text` / `input_image` parts. Text parts are joined one per line, and images stay in `raw`. Before, such a `tool_result` had empty `content`.
- **Failed and interrupted Codex turns replay as such.** A `task_complete` with `error` becomes a `result` with `isError: true`, `terminalReason: "failed"`, and the API's message as `text`. A `turn_aborted` becomes a `result` with `terminalReason: "interrupted"`, matching a live `turn/completed` with that status. Results carry `durationMs` from `duration_ms`. `attachSession().lastTurn` still reports an aborted last turn as `"interrupted"`.
- **JSONL records containing U+2028 or U+2029 are no longer dropped.** `node:readline` also splits lines at these separators, which JSON (and so both Claude Code and Codex) writes raw inside strings, usually in text copied from web pages. The record was cut in two, both halves failed to parse, and every later byte offset was 2 bytes short per separator, so a resume offset could land mid-record. Claude and Codex transcript reads, local history, attach classification, and the Codex usage scanner now share `utils/jsonl-lines`, which splits on `\n` only and reports exact byte offsets. CRLF offsets are now exact too. Codex event ids are offset-based, so in a rollout that has such a record, ids after it move to their correct offsets, and a host that already replayed that file may see those later records once more. Claude ids come from record `uuid`s and do not change.

### Changed

- The barrel-import module budget in `tests/packaging/lazy-graph.test.ts` is re-pinned from 53 to 54 for `utils/jsonl-lines`, a dependency-free leaf that replaces the builtin `node:readline`.

## 0.0.39 — Antigravity provider (Google's successor to Gemini CLI)

Gemini CLI stopped serving free, Google AI Pro, and Google AI Ultra sign-ins on 2026-06-18 ("This client is no longer supported for Gemini Code Assist for individuals"). Google moved those accounts to the Antigravity CLI, `agy`. This release adds it as a first-class provider. Wire behavior follows the documented headless protocol and was checked against `agy` 1.2.14.

### Added

- **`antigravity` provider** (`getProvider("antigravity")`). Drives `agy --input-format stream-json --output-format stream-json`.
  - **Sessions.** One `agy` process per session. Each `send()` writes one NDJSON user message and resolves on that turn's `result`. Sessions resume with `--conversation`. `sessionParams` are `{ sessionId, cwd }`, because Antigravity scopes conversations to a directory. Params saved for another directory start a new conversation instead of resuming the wrong one.
  - **One-shot `execute()`.** Writes the prompt over stdin and closes it, so prompts are never argv-limited or visible in `ps`. It waits for the process to exit.
  - **Interrupts.** The CLI has no control protocol, so `interrupt()`, timeouts, and abort signals SIGINT the process group (Ctrl+C). If `agy` exits instead of reporting `INTERRUPTED`, the next `send()` resumes the conversation in a new process. A message sent to a process that exits without acknowledging it is re-run once on a fresh one.
  - **Events.** `system/init`, `assistant` (with `assistant_delta` under `includePartialMessages`), `thinking`, correlated `tool_call`/`tool_result` (`toolCallId` = `<conversationId>:<stepIndex>`, subagent steps included), `result`, `turn_start`/`turn_end`, `auth_required`, and `unknown` for future step types.
  - **Usage.** agy reports cumulative usage per process. agentex reports each turn's share, with `cachedInputTokens` from `cache_read_tokens`.
  - **Config mapping.** `model` → `--model`. `effort` → `--effort` (`low|medium|high|max`). `modeId`/`mode` → `--mode` (`default`, `accept-edits`, `plan`). `planMode` → `--mode plan`, which wins over `skipPermissions` → `--dangerously-skip-permissions`. `sandbox` → `--sandbox`. `instructionsFile` is prepended to a new conversation's first message. `skillDirs` are linked into `~/.gemini/antigravity-cli/skills`.
  - **Permissions.** Headless agy cannot ask. Tools needing approval are soft-denied by policy and surface on `ExecutionResult.permissionDenials`. `capabilities.permissionRequests` is `false`.
  - **Errors.** `AGY_ERROR` stderr reports map to `rate_limited`, `invalid_model`, `waiting_for_input` (status `blocked`), or `agent_error`.
  - **Discovery.** `listModels()` reads `agy models`. `listModes()` is static and spawns nothing. `probeCapabilities()` checks `--help` for the stream-json flags (profile `agy-stream-json-v1`) and reports "not signed in" as `missing` rather than `upgrade_required`.
- **Fast sign-in failure.** An unsigned headless `agy` prints a login URL and blocks for 60 seconds waiting for a pasted code. agentex stops it as soon as the prompt appears, emits `auth_required` with `loginCommand: "agy"`, and fails with `errorCode: "auth_required"`. Against the real CLI this takes about 0.5s instead of 60.
- **Auth.** `resolveAuthForProvider("antigravity")` reports the sign-in from `agy models` (there is no status subcommand). `GEMINI_API_KEY` counts only when `~/.gemini/antigravity-cli/settings.json` sets `"modelProvider": "gemini"`, because the CLI ignores the variable otherwise. `detectAuth` and `loginCommandFor` (`"agy"`) follow the same rules.
- **`SkillRuntime` gains `"antigravity"`.** Workspace skills use the standard `.agents/skills` channel. Global skills go to `~/.gemini/antigravity-cli/skills`. Instructions use `AGENTS.md`, and the global native file is the `~/.gemini/GEMINI.md` it shares with Gemini CLI.
- `findBinary("agy")` also checks `~/.local/bin/agy`, where the official installer puts it and which GUI apps usually lack on `PATH`. It also checks `/usr/local/bin`, `/opt/homebrew/bin`, and on Windows `%LOCALAPPDATA%\agy\bin`.

### Changed

- `installSkills`/`removeSkills`/`listInstalledSkills` with `includeNativeDirs` skip a runtime folder that is already a standard channel, so nothing is installed or reported twice.
- Global `resolveInstructionTargets`/`installInstructions` merge runtimes that share a file. Gemini CLI and Antigravity both read `~/.gemini/GEMINI.md`, so it becomes one target serving both.
- The `gemini` provider documents the personal-account retirement and points to `antigravity`. It still works with paid API keys and Gemini Code Assist Standard/Enterprise.
- The barrel-import module budget in `tests/packaging/lazy-graph.test.ts` is re-pinned from 51 to 53. The new provider adds the same light `index` + `codec` pair every provider ships, and no heavy modules.

## 0.0.38 — AGENTS.md is the workspace instruction file for every runtime

Claude Code reads `AGENTS.md` since 2.1.277, loaded exactly where `CLAUDE.md` would be, but only in a folder with no `CLAUDE.md`. A `CLAUDE.md`, a `CLAUDE.local.md`, or one in a parent folder hides `AGENTS.md` completely (verified against 2.1.281). Not yet on Bedrock, Vertex or Foundry.

### Changed (breaking)

- **`installInstructions` writes `AGENTS.md` only by default.** Claude's workspace file is now `AGENTS.md`, like every other runtime. `CLAUDE.md` is Claude's native file, written only with `includeNativeFiles: true`, and then as a one-line `@AGENTS.md` pointer in the managed region instead of a second copy of the brief. A copy would have made anything the user writes in `AGENTS.md` invisible to Claude. Opt in for Claude Code before 2.1.277 or on a third-party API provider. `includeNativeFiles` still writes Gemini's `GEMINI.md` as a copy.
- **An existing workspace `CLAUDE.md` is reconciled** whenever `claude` is among the runtimes and the opt-in is off, because it would hide `AGENTS.md`: one holding nothing but this installer's managed region (for example the full brief 0.0.37 and earlier wrote) is deleted, and one the user wrote keeps their content and gains `@AGENTS.md` in the managed region. `managed: false` leaves it alone.
- **`removeInstructions` always checks native files** (`CLAUDE.md`, `GEMINI.md`), so an opt-in install is fully removable. It still only strips the managed region.

### Added

- `InstructionStatus` gains `"removed"`, and `InstructionInstallResult` a `removed` count.
- `InstructionTarget.importsFile` marks a pointer file (`"AGENTS.md"` on an opt-in `CLAUDE.md`).

### Migration

A host that relied on the default `CLAUDE.md` gets `AGENTS.md` only. Nothing else is needed on Claude Code 2.1.277+ with first-party auth: the next install deletes the old managed-only `CLAUDE.md`. Elsewhere, pass `includeNativeFiles: true`.

## 0.0.37 — Turn liveness and background-task identity (Claude)

Claude Code starts turns by itself. When a background task finishes, the CLI
enqueues the notification as user input, which opens a fresh turn with no host
involvement. A host that tracks "is the agent working" from its own `send()`
cannot see those turns — `send()` already resolved — so the session reads as
finished while the agent is visibly working. Verified against Claude Code
2.1.241, where one user message produced two `result` events with a
self-started turn between them.

### Added

- **`turn_start` StreamEvent.** Pairs with `result`, which closes a turn.
  Carries `trigger: "send" | "resume"` — `resume` meaning the provider opened
  the turn on its own. Emitted for host-initiated turns too, so `turn_start` →
  `result` describes turn liveness straight off the stream rather than by
  inference from dispatch.

  It deliberately does not name the background task behind a `resume`. Claude
  delivers a task's result and opens the turn as two unlinked records, and with
  several tasks in flight the pairing is not recoverable from the wire; every
  attempt to infer it produced a plausible id that was sometimes wrong.
  Correlate through `background_task.report` and `toolUseId`, which the
  provider does state.

  Attribution is exact, not inferred. A host message carries a uuid and a
  provider-initiated continuation does not: every dequeued input with a uuid
  emits `command_lifecycle` naming it, while the task-notification continuation
  is enqueued without one. So a turn opened by a `started` naming an
  outstanding message *is* that message's turn. A build that has never emitted
  `command_lifecycle` falls back to the oldest unclaimed send; once one has
  been seen, the fallback is disabled, because guessing there would mislabel
  twice.

- **`turn_end` StreamEvent.** Every `turn_start` is followed by exactly one,
  carrying the same `turnId` and a `reason`. `result` cannot serve as the close
  signal on its own: a message the CLI cancels, discards, or refuses opens a
  turn and produces no result, so a host pairing `turn_start` with `result`
  would stay busy forever on those paths. `result` remains the outcome payload
  and is ordered before the `turn_end` that follows it.

- **`background_task.report`.** The task's delivered output (`summary`,
  `outputFile`, `usage`), present only on the event that hands the result
  back. Claude emits *both* `task_updated` and `task_notification` for a single
  completion; they are different records, not duplicates, and only the
  notification carries the result. Collapsing them into one indistinguishable
  `phase: "completed"` event made hosts render every finished task twice, once
  with its report and once empty. A task that was stopped or killed delivered
  nothing and carries no report. Codex applies the identical rule at every
  emitter, so "one row per delivered result" holds across providers.

- **`background_task.toolUseId`.** The tool call that launched the task — the
  same id Claude writes into a subagent's `meta.json`, and the only structured
  task-to-tool_call link the wire provides. It was being discarded.

### Changed

- Turn, command, and task state is now reduced from the ordered wire in one
  place, rather than held in mutable fields updated across `await` boundaries.
  Each turn's settlement batch is captured synchronously before any suspension
  point, so a turn that opens while an earlier handler is still draining cannot
  have its sends resolved by that handler — the failure that made two
  back-to-back results resolve both callers with the first result.

- A turn owns a *set* of command uuids. The CLI coalesces: a host message
  dequeued while a turn is running joins that turn instead of starting its own.
  Modelling one command per turn left every coalesced message permanently
  unsettled.

### Fixed

- A background task's `taskType` and `description` survive its whole lifetime.
  `task_started` is the only record that names them; the patches and the
  completion notification that follow identify the task by id alone, so every
  finished subagent normalized to `taskType: "unknown"` and hosts rendered
  "Background task completed" for what was plainly a subagent. A completion for
  a task the session never saw start still reports `unknown` rather than
  guessing. The cache is bounded at 512 entries, oldest evicted.

- A detached subagent's own output no longer drives the parent session. Claude
  streams a child's assistant text, thinking, and tool calls onto the parent
  stream while the root turn is already over. Anything carrying
  `parent_tool_use_id` is the child working, not the session: it does not open
  a turn, does not move `session.state`, and a child's permission prompt no
  longer parks the parent in `waiting_for_approval` with nothing able to clear
  it.

- `session.state` and `turn_start`/`result` agree. A host turn took `thinking`
  from `send()`; a provider-initiated one had nothing to set it, so `state`
  read `idle` for the whole head of every resume turn while `turn_start` had
  already fired.

- Turn settling is synchronous with the `result` line. The CLI can flush a
  result and the next turn's opening line in one chunk; deferring the close
  until the event chain drained swallowed the following `turn_start`, and
  deferring the turn's send-resolvers with it let the next turn mistake them
  for its own. The resolvers are appended to a settling list, never assigned
  over — overwriting discarded the earlier turn's resolvers outright, hanging
  that caller's `send()` and deadlocking `drain()` behind it.

- Background-task state is tracked from the wire, not from the delivery path.
  It was maintained inside event dispatch, which only runs when a host
  subscribed, so `session.state`, `drain()`, and turn attribution silently
  degraded for a host that reads the session without an `onEvent` handler.

- A send resolves with its own turn. `_pendingResults` was a flat queue drained
  by whatever `result` landed next, so a follow-up the CLI had merely queued
  resolved against a turn that never contained it — the host then read
  "finished" for a message still waiting to run. Each entry now carries its
  command uuid and settles only when the turn that claimed it completes. A
  terminal `command_lifecycle` settles a message the CLI retires without
  running, which previously had nothing to settle it at all.

- `drain()` waits for provider-initiated turns and for running subagents.
  `_inFlight` only tracks turns the host dispatched, so draining during the gap
  between a root result and the resume turn that follows it — measured at 8-11
  seconds live — SIGTERM'd the CLI and killed the child outright. Background
  *processes* are deliberately excluded: a dev server started with
  `run_in_background` may never exit, and the contract is "let the agent's work
  settle", not "outlive whatever it launched". Bounded by a deadline so a
  wedged turn cannot hang the drain.

  It also holds across the gap between a task's result being delivered and the
  resume turn it triggers — 24ms for a subagent, 71ms for a background process.
  The task is no longer live by then, so waiting on live tasks alone left
  `drain()` landing in that window and killing the very turn it was extended to
  protect. The delivery record is the provider stating a turn is coming, so it
  is used as one; the wait is released by the next turn to open or close.

- Turns opened by a command that ends in `refused`, `discarded`, or `cancelled`
  are closed by that record. Those states never produce a `result`, so nothing
  else would ever close them and the session pinned as working with no path
  back.

- Wire lines arriving after `close()` are ignored, and `close()` rejects sends
  still waiting on a turn instead of stranding the caller forever.

- `turn_start` carries the `eventId` of the line that opened it, and a minimal
  `raw`. A resume turn is headed by `system/init`, whose payload runs to ~5KB
  of tools, skills, plugins, and MCP config; echoing it whole made hosts that
  persist `raw` pay that for every resume, twice.

### Compatibility

- Additive at the type level. `turn_start` is a new event type — consumers with
  exhaustive `switch` statements over `StreamEvent` will need a case or a
  default. `report` and `toolUseId` are new required fields on
  `background_task`; every in-tree provider sets them, and both are `null`
  where the provider reports nothing.
- No behavior change for OpenCode, Cursor, or any other provider. Codex gains
  `report`/`toolUseId` and is otherwise untouched; only the Claude provider
  emits `turn_start`.

## 0.0.36 — OpenCode empty-turn follow-ups

Follow-ups to the OpenCode empty-turn handling in 0.0.35.

### Changed

- Turn, command, and task state is now reduced from the ordered wire in one
  place, rather than held in mutable fields updated across `await` boundaries.
  Each turn's settlement batch is captured synchronously before any suspension
  point, so a turn that opens while an earlier handler is still draining cannot
  have its sends resolved by that handler — the failure that made two
  back-to-back results resolve both callers with the first result.

- A turn owns a *set* of command uuids. The CLI coalesces: a host message
  dequeued while a turn is running joins that turn instead of starting its own.
  Modelling one command per turn left every coalesced message permanently
  unsettled.

### Fixed

- The empty-turn classifier's "finished" guard now lives in `terminalOutcome`,
  so the live and reconcile paths agree. The live path called it unconditionally
  on the `/message` response, while the reconcile path gated on the message
  having a finish reason or an error first. With `info` absent (an empty or
  malformed body) `terminalOutcome` walked to `failed`/`incomplete_turn` but
  suppressed the note — which needs `info` — producing a failed turn with
  nothing in the transcript explaining it, the exact silent stall the 0.0.35
  change removes, reached from the other side. A message with neither a finish
  reason nor an error now stays `completed`.
- `_messageRoles` (the map that suppresses the prompt echo) is now cleared at
  turn end instead of never. It sat next to the per-turn dedup maps but was
  omitted from their turn-start reset, and could not join it: a user message's
  role has to survive from its `message.updated` frame into the part stream that
  follows within the same turn, so clearing at the start would reintroduce the
  echo. Clearing at turn end bounds the map to one turn's messages instead of
  growing for the session's whole life.
- A user interrupt performed through OpenCode's own UI now reports as `aborted`,
  not `failed`. When OpenCode records a `MessageAbortedError`, the classifier
  maps it to `status: "aborted"` with a plain message, matching self-aborts and
  Codex's handling of the same action, rather than `agent_error` with a
  JSON-stringified error object.

- `session.state` no longer follows a detached child. The state machine set
  `thinking` on any assistant line, including a subagent's, so `state` and
  `turn_start`/`result` contradicted each other for the child's entire run —
  measured at 7.6s live — with nothing to clear it if the child was stopped or
  killed.
- `stream_event` opens a turn. Under `includePartialMessages` the whole
  streamed reply arrived before `turn_start`, which reintroduced the reported
  bug one layer down: output visible while the session still read as finished.
- A `send()` issued while a turn is settling is no longer classified as
  `resume`. The trigger reads a counter of host messages still awaiting a
  turn; the resolver list cannot answer that, because a turn's resolvers are
  moved off it the moment its `result` is read.
- `_pendingResumeTaskId` is consumed only by the resume turn it explains. It
  was cleared on every turn open, so a host send landing between a task's
  delivery and its resume turn wiped the attribution.
- Turn state, the task-fact cache, and the unclaimed-send counter are all
  reset when a session's pending work is rejected (exit, crash, close). A
  `_turnOpen` left set would also suppress the `idle` fallback in
  `handleResult` and pin a dead session as working with no path back.

### Compatibility

- The incomplete-turn note is emitted as `type: "assistant"` (the only surface a
  host renders) and tagged `raw.synthetic: "incomplete_turn"`. It is
  library-authored prose, not model output: a host that replays transcript
  history back into a model (context rebuilding, summarization) should filter
  events carrying `raw.synthetic` so the note is never fed back as assistant turn
  content.

## 0.0.35 — Codex turn-boundary correctness and model discovery

### Changed

- Turn, command, and task state is now reduced from the ordered wire in one
  place, rather than held in mutable fields updated across `await` boundaries.
  Each turn's settlement batch is captured synchronously before any suspension
  point, so a turn that opens while an earlier handler is still draining cannot
  have its sends resolved by that handler — the failure that made two
  back-to-back results resolve both callers with the first result.

- A turn owns a *set* of command uuids. The CLI coalesces: a host message
  dequeued while a turn is running joins that turn instead of starting its own.
  Modelling one command per turn left every coalesced message permanently
  unsettled.

### Fixed

- A Codex `send()` issued while the previous turn's result was still being
  delivered is now a turn of its own. It previously joined the finished turn,
  which left it with no interrupt latch: `interrupt()` found nothing to target
  and returned as though it had succeeded, so Stop was a silent no-op — the
  exact failure 0.0.33 set out to remove. The same send could also be settled
  with the *previous* turn's `TurnResult`, so `await send()` resolved
  `completed` while the agent was still working. Turn latches now carry a
  generation, result delivery drains only its own generation, and a superseded
  delivery no longer clears the running turn's state, accumulators, or latch.
  The window is real time: it spans `await this._eventChain` (any host
  persisting events) and the on-disk usage scan when `turn/completed` carries
  no usage.
- Turn outcomes are now snapshotted at the terminal frame rather than read at
  delivery time. Delivery is asynchronous, so reading the live accumulators
  read whichever turn was running *then*: a turn that started during the window
  inherited the previous turn's failure and reported its own summary alongside
  someone else's error. Clearing on the way out was not an option either — the
  usage-scan path re-reads state after an await.
- A duplicate terminal frame for an already-delivered turn no longer bypasses
  the generation fence. Codex can report failure through both `turn/completed`
  with a failed status and a separate `turn/failed`; the second arrives with no
  active latch, and exempting that case restored every symptom the fence
  exists to prevent.
- Claude `task_updated` patches no longer assert `running`. A patch that only
  renames a task said nothing about liveness yet claimed the task was running,
  silently resurrecting a `paused` one. `task_started` and `task_progress` still
  imply `running`, because those events are emitted by a running task.
- Codex approval requests now carry the right fields. `toolUseId` reads
  `itemId` (the protocol has no `id` here, so it was always `""`), and
  file-change approvals describe themselves from `grantRoot` rather than a
  `path` field that does not exist. Confirmed against
  `codex app-server generate-json-schema` on 0.148.
- Child-thread approvals and questions no longer drive root session state, and
  carry `agentId` so a host can attribute them to the subagent that asked. This
  covers all three server-to-client request handlers: command-execution
  approval, file-change approval, and `requestUserInput`. Every one of them
  requires `threadId` in the protocol, so the scoping is read from the wire
  rather than inferred.
- `item/permissions/requestApproval` is handled instead of falling through to
  the generic empty ack, which the schema rejects —
  `PermissionsRequestApprovalResponse` requires a `permissions` profile.
  Allowing echoes the requested profile; refusing, or having no host handler,
  grants nothing.
- Claude discovery no longer returns an ambiguous empty list. A control probe
  proves the mechanism still works before any candidate is judged, so `[]` now
  means "this CLI recognizes none of them" rather than doubling as "the probe
  broke". A broken mechanism throws, which callers already treat as "use your
  fallback catalog".
- The redundant direct `startBackgroundTaskPoller` call sites are gone. They
  fired mid-item, before a later line in the same chunk could mark a task
  terminal, which spawned a `thread/read` for a task that was already finished.
- Collaboration tool calls addressed to several receiver threads now emit a
  `background_task` for every child. Only the first receiver was reported, so
  the rest of a fan-out never existed as far as the host could tell. Added
  `parseCodexStreamLines()`, which returns every event a line produces;
  `parseCodexStreamLine()` remains as a first-event-only wrapper.
- Root `collabAgentToolCall` items that map to no task edge (`sendInput` to an
  unknown task, metadata-only calls with no change) are forwarded as `unknown`
  events again instead of being dropped, restoring the forward-compat escape
  hatch for wire shapes that are not modeled yet.
- `executeCodexProvider` now emits a terminal `background_task` edge with
  status `stopped` for children still running when the one-shot process exits.
  The capability is declared provider-wide, but the one-shot path has no
  session to reconcile against, so those children previously stayed `running`
  forever from the host's view.
- A Claude `task_notification` that reports a live status is no longer forced
  terminal. Every notification produced `phase: "completed"` regardless of the
  status it carried, so an event saying `status: "running"` also told hosts to
  drop the task — the documented contract is to remove a task from the active
  set on `phase === "completed"`. Terminality now follows the status. A
  notification with no status is still the completion signal it has always been.
- Codex background tasks registered through the parser's `subAgentActivity`
  branch now get a reconciliation poller. Only the collaboration handler
  started one, so those tasks had no safety net and depended entirely on the
  child notification arriving — the exact failure 0.0.34 exists to survive.
- A Codex child thread announced with no parent thread id now writes a stderr
  notice instead of silently disabling background-task tracking and
  reconciliation for that child.
- Codex background-task bookkeeping no longer grows without bound. A terminal
  task keeps its identity (that is what suppresses duplicate edges and blocks
  resurrection) and its description (the reactivation path reads it precisely
  because the record is terminal), but releases `summary`, which is the
  genuinely unbounded field — full agent messages, appended per item. Both maps
  are cleared on `close()`.
- Claude's top reasoning rung is no longer a silent downgrade. `ProviderConfig.effort`
  of `"ultra"` now reaches the CLI as `--effort ultracode`, the token Claude Code
  actually accepts. Previously it was passed through verbatim, and the CLI answered
  with a stderr warning and then ran the turn at the session default, so callers
  asking for maximum reasoning got ordinary reasoning with no error to notice.
  Codex is unaffected: it names that rung `ultra` natively.
- `ListModelsOptions.cacheTtlMs` is now honored. It has been part of the public
  shape since `listModels()` shipped but nothing read it, so callers passing a TTL
  paid for a fresh CLI round trip every call. A TTL of `0` or `undefined` still
  forces a refresh, and a rejected discovery is never cached.
- An OpenCode turn that ends with no reply is no longer reported as a clean
  completion. When the upstream provider drops the stream, OpenCode records the
  assistant message with `finish: "unknown"`, no text, and no error, which the
  adapter mapped to a successful empty turn — indistinguishable from a stall.
  Such a turn now resolves `failed` and emits a visible assistant note
  explaining the model returned no content, so the user can retry instead of
  waiting on a turn that already ended. Detection keys on a terminal message
  with no visible text and a non-clean finish reason, so a real answer or a
  clean stop is never touched, and a user interrupt (which OpenCode marks with a
  `MessageAbortedError`) still reports as an error rather than an empty turn.
  Live and reconcile paths share a `${messageId}:incomplete` event id so a
  catch-up dedups the note instead of duplicating it.
- An OpenCode user prompt is no longer echoed back as an assistant message. The
  live session mapped every streamed text part to assistant output, but OpenCode
  re-streams the user message's own text part once a turn is active, so each
  prompt surfaced a second time as if the agent had said it. The session now
  tracks message roles from `message.updated` frames and drops parts belonging
  to a user message; an as-yet-unknown role still emits, so a frame-ordering
  race can never suppress genuine assistant output.
- OpenCode's live terminal `result` event now uses the same `${messageId}:result`
  id as the reconcile path. The two paths previously produced different ids for
  the same turn terminus, so a reconcile after a live turn appended a duplicate
  terminal marker instead of deduping against the one already written. Migration:
  a host that already persisted a terminal row under the old bare `msg_x` id
  won't dedup it against the incoming `msg_x:result`, so the first catch-up after
  upgrading appends one duplicate terminal marker per previously-recorded live
  turn. One-time and bounded; terminal `result` rows are analytics-only and not
  rendered.

### Added

- `codex.listModels()` reads `codex debug models`, so Codex models arrive with the
  reasoning levels each one actually supports and its own default. These are
  genuinely per-model: 5.6 Sol advertises `ultra`, 5.5 stops at `xhigh`.
- `claude.listModels()` validates the tier aliases (`opus`, `sonnet`, `haiku`,
  `fable`) against the installed binary and reports the efforts it accepts.
  Claude Code ships no catalog command, so this works by asking the CLI to
  validate each value: `--help` enumerates the efforts it documents, and anything
  it accepts without documenting (`ultracode`) is recovered by probing. Probes use
  `--bare` where available so they cannot fire a user's hooks, and pass an empty
  prompt so they exit before reaching the network. No probe costs a token.
- `claude.listClaudeEfforts()` for hosts that want the effort ladder without a
  model list. Claude applies one `--effort` per session rather than per model.
- `ProviderModel.description` carries a provider's own one-line blurb through.
- `capabilities.modelDiscovery` is now `true` for `claude` and `codex`, and the
  contract test now checks both directions so a provider cannot declare
  discovery it does not implement, or implement discovery it does not declare.

- `session.state` no longer follows a detached child. The state machine set
  `thinking` on any assistant line, including a subagent's, so `state` and
  `turn_start`/`result` contradicted each other for the child's entire run —
  measured at 7.6s live — with nothing to clear it if the child was stopped or
  killed.
- `stream_event` opens a turn. Under `includePartialMessages` the whole
  streamed reply arrived before `turn_start`, which reintroduced the reported
  bug one layer down: output visible while the session still read as finished.
- A `send()` issued while a turn is settling is no longer classified as
  `resume`. The trigger reads a counter of host messages still awaiting a
  turn; the resolver list cannot answer that, because a turn's resolvers are
  moved off it the moment its `result` is read.
- `_pendingResumeTaskId` is consumed only by the resume turn it explains. It
  was cleared on every turn open, so a host send landing between a task's
  delivery and its resume turn wiped the attribution.
- Turn state, the task-fact cache, and the unclaimed-send counter are all
  reset when a session's pending work is rejected (exit, crash, close). A
  `_turnOpen` left set would also suppress the `idle` fallback in
  `handleResult` and pin a dead session as working with no path back.

### Compatibility

- Discovery is curated-list-plus-validation for Claude, not enumeration. A tier
  alias this library has never heard of cannot be discovered, and a recognized
  `--model` value proves the binary knows the name, not that the account is
  entitled to it.
- A cold Claude discovery spawns the CLI several times: measured ~1.8-3s
  depending on machine load, against ~0.1s for Codex. Two of those spawns
  (`--help` and the control probe) are serial; the rest run concurrently. Pass
  `cacheTtlMs` and keep a static fallback for first paint.
- Concurrent sends still coalesce into one turn and share its `TurnResult`.
  What changed is that a send arriving after the previous turn has terminated
  is no longer treated as concurrent with it.
- **Migration note for 0.0.32 and earlier.** 0.0.33 moved Claude task lifecycle
  from `type: "unknown"` to `type: "background_task"`; that was listed under
  Added, but for hosts it is a breaking change. Code shaped like
  `if (event.type === "unknown") { getClaudeTaskDetails(event) }` stops seeing
  tasks. `getClaudeTaskDetails()` still accepts legacy `unknown` events, which
  covers replaying stored history but not a live handler keyed on the old
  discriminator. Branch on `type === "background_task"` and treat the `unknown`
  form as the compatibility path.
- **`background_task.status` is now `BackgroundTaskStatus | null`.** Null means
  "no change reported" — keep whatever you have. This is a type-level breaking
  change and deliberately so: it fails loudly at compile time rather than
  silently. Only Claude emits it, and only where the wire genuinely says
  nothing; Codex always reports a concrete status.
- The generic fallback for unhandled Codex server requests still replies `{}`.
  Every server request the protocol defines but this library does not handle
  declares required response fields, so that reply is schema-invalid for all of
  them — the same class as the `item/permissions/requestApproval` fix in this
  release. A JSON-RPC error reply is the honest answer, but `rpcResponse` has no
  error path and adding one is a behavior change (an error can abort a turn
  where `{}` limps along), so it is deferred rather than rushed in. Pre-existing;
  the misleading "ack to unblock the turn" comment has been corrected.
- Codex child reconciliation still polls `thread/read` every 2s per active
  child regardless of whether notifications are flowing. Unchanged here and
  still an open decision. `thread/status/changed` and `thread/closed` exist in
  the app-server protocol and would allow a push-based design with polling
  demoted to a silence-timeout fallback; worth evaluating before committing to
  polling permanently.
- Codex child reconciliation still polls `thread/read` every 2s for each active
  child regardless of whether notifications are flowing. That cost is unchanged
  here and remains an open decision, not a regression.

## 0.0.34 - Codex collaboration task lifecycle

### Changed

- Turn, command, and task state is now reduced from the ordered wire in one
  place, rather than held in mutable fields updated across `await` boundaries.
  Each turn's settlement batch is captured synchronously before any suspension
  point, so a turn that opens while an earlier handler is still draining cannot
  have its sends resolved by that handler — the failure that made two
  back-to-back results resolve both callers with the first result.

- A turn owns a *set* of command uuids. The CLI coalesces: a host message
  dequeued while a turn is running joins that turn instead of starting its own.
  Modelling one command per turn left every coalesced message permanently
  unsettled.

### Fixed

- Codex 0.144 collaboration tool calls now register spawned child threads as
  provider-neutral `background_task` events, including children launched after
  the root turn has already completed.
- Child completion, failure, and interruption reconcile against authoritative
  Codex thread state when live child notifications race or are unavailable.
  Reconciliation remains independent of root turn settlement.
- Duplicate start and terminal edges are suppressed across collaboration,
  child-thread, and reconciliation signals. Session shutdown also closes any
  still-active child lifecycle instead of leaving a permanent running state.

- `session.state` no longer follows a detached child. The state machine set
  `thinking` on any assistant line, including a subagent's, so `state` and
  `turn_start`/`result` contradicted each other for the child's entire run —
  measured at 7.6s live — with nothing to clear it if the child was stopped or
  killed.
- `stream_event` opens a turn. Under `includePartialMessages` the whole
  streamed reply arrived before `turn_start`, which reintroduced the reported
  bug one layer down: output visible while the session still read as finished.
- A `send()` issued while a turn is settling is no longer classified as
  `resume`. The trigger reads a counter of host messages still awaiting a
  turn; the resolver list cannot answer that, because a turn's resolvers are
  moved off it the moment its `result` is read.
- `_pendingResumeTaskId` is consumed only by the resume turn it explains. It
  was cleared on every turn open, so a host send landing between a task's
  delivery and its resume turn wiped the attribution.
- Turn state, the task-fact cache, and the unclaimed-send counter are all
  reset when a session's pending work is rejected (exit, crash, close). A
  `_turnOpen` left set would also suppress the `idle` fallback in
  `handleResult` and pin a dead session as working with no path back.

### Compatibility

- The change is isolated to Codex collaboration events. Claude and the other
  provider transports keep their existing background-task behavior.

## 0.0.33 — Reliable Codex control and background tasks

### Added

- `background_task` is now a first-class, provider-neutral `StreamEvent` for
  async subagents and background processes. It carries a stable task id,
  normalized type/phase/status, description, summary, and optional parent task
  lineage. Claude and Codex advertise this through
  `capabilities.backgroundTaskEvents`.
- Codex live sessions correlate root `subAgentActivity` items with child-thread
  lifecycle notifications from the multiplexed app-server connection. Child
  completion, failure, and interruption now remain visible after the root turn
  ends without ever resolving or mutating the root turn.
- Claude `task_started`, `task_progress`, `task_updated`, and
  `task_notification` records now normalize directly to `background_task`.
  `getClaudeTaskDetails()` remains available for Claude-native fields and
  accepts legacy `unknown` task events from older agentex versions.

### Changed

- Turn, command, and task state is now reduced from the ordered wire in one
  place, rather than held in mutable fields updated across `await` boundaries.
  Each turn's settlement batch is captured synchronously before any suspension
  point, so a turn that opens while an earlier handler is still draining cannot
  have its sends resolved by that handler — the failure that made two
  back-to-back results resolve both callers with the first result.

- A turn owns a *set* of command uuids. The CLI coalesces: a host message
  dequeued while a turn is running joins that turn instead of starting its own.
  Modelling one command per turn left every coalesced message permanently
  unsettled.

### Fixed

- Codex live sessions now track the active root turn and interrupt it with the
  supported `turn/interrupt` request, including the required thread and turn
  identifiers. Stop requests made before `turn/start` responds wait for the
  root turn identity instead of sending an invalid unscoped request.
- Repeated interrupt requests for one turn are coalesced, while a later turn
  receives its own interrupt. Child-agent turn notifications and queued send
  responses cannot replace the root turn being targeted.
- Codex `interrupted` terminal notifications now resolve the public turn result
  as `aborted`. Interrupt RPC errors propagate to the caller so hosts can show a
  failed Stop action instead of reporting false success.

- `session.state` no longer follows a detached child. The state machine set
  `thinking` on any assistant line, including a subagent's, so `state` and
  `turn_start`/`result` contradicted each other for the child's entire run —
  measured at 7.6s live — with nothing to clear it if the child was stopped or
  killed.
- `stream_event` opens a turn. Under `includePartialMessages` the whole
  streamed reply arrived before `turn_start`, which reintroduced the reported
  bug one layer down: output visible while the session still read as finished.
- A `send()` issued while a turn is settling is no longer classified as
  `resume`. The trigger reads a counter of host messages still awaiting a
  turn; the resolver list cannot answer that, because a turn's resolvers are
  moved off it the moment its `result` is read.
- `_pendingResumeTaskId` is consumed only by the resume turn it explains. It
  was cleared on every turn open, so a host send landing between a task's
  delivery and its resume turn wiped the attribution.
- Turn state, the task-fact cache, and the unclaimed-send counter are all
  reset when a session's pending work is rejected (exit, crash, close). A
  `_turnOpen` left set would also suppress the `idle` fallback in
  `handleResult` and pin a dead session as working with no path back.

### Compatibility

- Timeout and AbortSignal cancellation remain best-effort and preserve their
  existing synthetic results. Concurrent root sends retain their shared-result
  behavior. Background-task terminal events are informational and never settle
  a root `SendHandle.result`.

## 0.0.32 — Codex root-thread completion isolation

### Changed

- Turn, command, and task state is now reduced from the ordered wire in one
  place, rather than held in mutable fields updated across `await` boundaries.
  Each turn's settlement batch is captured synchronously before any suspension
  point, so a turn that opens while an earlier handler is still draining cannot
  have its sends resolved by that handler — the failure that made two
  back-to-back results resolve both callers with the first result.

- A turn owns a *set* of command uuids. The CLI coalesces: a host message
  dequeued while a turn is running joins that turn instead of starting its own.
  Modelling one command per turn left every coalesced message permanently
  unsettled.

### Fixed

- Codex live sessions now pin their root thread and ignore notifications from
  child-agent threads multiplexed over the same app-server connection. A child
  `turn/completed`, `turn/failed`, or item event can no longer resolve the root
  send, set the root session idle, overwrite its summary, or replace its
  resumable thread id.
- Codex assistant events now preserve the optional `commentary` and
  `final_answer` phase in live, transcript, and local-history normalization. Known
  commentary items remain progress events and are no longer reused as the
  synthesized terminal result summary.
- Current app-server `commandExecution` items and their camelCase output fields
  now normalize to the existing `tool_call` and `tool_result` event shapes.
- Live Codex event identity prefers the event's own thread scope while retaining
  the pinned root id as a compatibility fallback for older unscoped events.

- `session.state` no longer follows a detached child. The state machine set
  `thinking` on any assistant line, including a subagent's, so `state` and
  `turn_start`/`result` contradicted each other for the child's entire run —
  measured at 7.6s live — with nothing to clear it if the child was stopped or
  killed.
- `stream_event` opens a turn. Under `includePartialMessages` the whole
  streamed reply arrived before `turn_start`, which reintroduced the reported
  bug one layer down: output visible while the session still read as finished.
- A `send()` issued while a turn is settling is no longer classified as
  `resume`. The trigger reads a counter of host messages still awaiting a
  turn; the resolver list cannot answer that, because a turn's resolvers are
  moved off it the moment its `result` is read.
- `_pendingResumeTaskId` is consumed only by the resume turn it explains. It
  was cleared on every turn open, so a host send landing between a task's
  delivery and its resume turn wiped the attribution.
- Turn state, the task-fact cache, and the unclaimed-send counter are all
  reset when a session's pending work is rejected (exit, crash, close). A
  `_turnOpen` left set would also suppress the `idle` fallback in
  `handleResult` and pin a dead session as working with no path back.

### Compatibility

- Unscoped global Codex notifications continue to flow through. The documented
  concurrent-send behavior is unchanged: coalesced root sends still share the
  same root `TurnResult`.
- Other provider transports and completion semantics are unchanged.

## 0.0.31 — OpenCode saved history import and synchronization

### Added

- Added the optional provider-neutral `provider.savedHistory` contract for
  discovering and reading provider-owned sessions without exposing transcript
  paths, database layouts, or byte offsets.
- OpenCode saved-history discovery uses its authenticated, cross-project
  `/experimental/session` API with root-session, archived-session, directory,
  and limit filters. The older global `GET /session` list remains an
  active-session fallback.
- OpenCode saved-history reads include user prompts alongside normalized
  assistant, thinking, tool, and terminal events. Opaque message-part
  checkpoints support incremental synchronization and bounded full resync.
- Added public saved-history types, a static and runtime capability flag,
  derived-provider identity and environment overlays, and release-safe runtime
  cleanup.

### Safety and compatibility

- Discovery and message inspection are bounded by page, record, and byte
  limits. Malformed candidate records and sessions concurrently deleted with
  a 404 are isolated so they do not hide healthy sessions from the import
  catalog. Authentication, server, network, and invalid-response failures
  abort discovery rather than reporting a partial catalog as authoritative.
- Eligibility inspection has a shared 10,000-message and 25 MiB budget across
  the complete discovery call, in addition to its per-session bounds.
- Opaque checkpoints fingerprint their complete source message. If OpenCode
  mutates an active tail message in place, incremental sync reports the
  checkpoint missing so the host can perform a bounded deduplicated resync.
- Historical normalization emits terminal `result` events only after OpenCode
  records a finish reason or error. In-progress assistant messages no longer
  appear completed.
- A session deleted after discovery fails saved-history reads with the stable
  `source_missing` error code instead of appearing to be a successful empty
  resync. Known-session attachment retains its existing empty-on-missing
  compatibility behavior.
- Runtime `cwd` is separate from the optional saved-session `directory` filter,
  preserving cross-project discovery. Reads acquire OpenCode in the discovered
  session's cwd so another project's messages remain available.
- Existing Claude and Codex `localHistory` APIs and existing OpenCode
  `attachHistory()` behavior are unchanged. Known-session catch-up still omits
  user prompts owned by the host.

## 0.0.30 — Complete Claude and Codex host capabilities

### Changed

- Turn, command, and task state is now reduced from the ordered wire in one
  place, rather than held in mutable fields updated across `await` boundaries.
  Each turn's settlement batch is captured synchronously before any suspension
  point, so a turn that opens while an earlier handler is still draining cannot
  have its sends resolved by that handler — the failure that made two
  back-to-back results resolve both callers with the first result.

- A turn owns a *set* of command uuids. The CLI coalesces: a host message
  dequeued while a turn is running joins that turn instead of starting its own.
  Modelling one command per turn left every coalesced message permanently
  unsettled.

### Fixed

- Claude and Codex now declare the resumability, permission, question, and
  in-session selection capabilities their session implementations support.
- Codex now sends both model and effort overrides on every `turn/start`, so a
  recycled host process can apply a changed selection while resuming the same
  thread.
- Provider contract tests cover the complete Claude and Codex host capability
  matrix, including explicit unsupported controls.

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

- `session.state` no longer follows a detached child. The state machine set
  `thinking` on any assistant line, including a subagent's, so `state` and
  `turn_start`/`result` contradicted each other for the child's entire run —
  measured at 7.6s live — with nothing to clear it if the child was stopped or
  killed.
- `stream_event` opens a turn. Under `includePartialMessages` the whole
  streamed reply arrived before `turn_start`, which reintroduced the reported
  bug one layer down: output visible while the session still read as finished.
- A `send()` issued while a turn is settling is no longer classified as
  `resume`. The trigger reads a counter of host messages still awaiting a
  turn; the resolver list cannot answer that, because a turn's resolvers are
  moved off it the moment its `result` is read.
- `_pendingResumeTaskId` is consumed only by the resume turn it explains. It
  was cleared on every turn open, so a host send landing between a task's
  delivery and its resume turn wiped the attribution.
- Turn state, the task-fact cache, and the unclaimed-send counter are all
  reset when a session's pending work is rejected (exit, crash, close). A
  `_turnOpen` left set would also suppress the `idle` fallback in
  `handleResult` and pin a dead session as working with no path back.

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

### Changed

- Turn, command, and task state is now reduced from the ordered wire in one
  place, rather than held in mutable fields updated across `await` boundaries.
  Each turn's settlement batch is captured synchronously before any suspension
  point, so a turn that opens while an earlier handler is still draining cannot
  have its sends resolved by that handler — the failure that made two
  back-to-back results resolve both callers with the first result.

- A turn owns a *set* of command uuids. The CLI coalesces: a host message
  dequeued while a turn is running joins that turn instead of starting its own.
  Modelling one command per turn left every coalesced message permanently
  unsettled.

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

### Changed

- Turn, command, and task state is now reduced from the ordered wire in one
  place, rather than held in mutable fields updated across `await` boundaries.
  Each turn's settlement batch is captured synchronously before any suspension
  point, so a turn that opens while an earlier handler is still draining cannot
  have its sends resolved by that handler — the failure that made two
  back-to-back results resolve both callers with the first result.

- A turn owns a *set* of command uuids. The CLI coalesces: a host message
  dequeued while a turn is running joins that turn instead of starting its own.
  Modelling one command per turn left every coalesced message permanently
  unsettled.

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

### Changed

- Turn, command, and task state is now reduced from the ordered wire in one
  place, rather than held in mutable fields updated across `await` boundaries.
  Each turn's settlement batch is captured synchronously before any suspension
  point, so a turn that opens while an earlier handler is still draining cannot
  have its sends resolved by that handler — the failure that made two
  back-to-back results resolve both callers with the first result.

- A turn owns a *set* of command uuids. The CLI coalesces: a host message
  dequeued while a turn is running joins that turn instead of starting its own.
  Modelling one command per turn left every coalesced message permanently
  unsettled.

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

### Changed

- Turn, command, and task state is now reduced from the ordered wire in one
  place, rather than held in mutable fields updated across `await` boundaries.
  Each turn's settlement batch is captured synchronously before any suspension
  point, so a turn that opens while an earlier handler is still draining cannot
  have its sends resolved by that handler — the failure that made two
  back-to-back results resolve both callers with the first result.

- A turn owns a *set* of command uuids. The CLI coalesces: a host message
  dequeued while a turn is running joins that turn instead of starting its own.
  Modelling one command per turn left every coalesced message permanently
  unsettled.

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

### Changed

- Turn, command, and task state is now reduced from the ordered wire in one
  place, rather than held in mutable fields updated across `await` boundaries.
  Each turn's settlement batch is captured synchronously before any suspension
  point, so a turn that opens while an earlier handler is still draining cannot
  have its sends resolved by that handler — the failure that made two
  back-to-back results resolve both callers with the first result.

- A turn owns a *set* of command uuids. The CLI coalesces: a host message
  dequeued while a turn is running joins that turn instead of starting its own.
  Modelling one command per turn left every coalesced message permanently
  unsettled.

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

### Changed

- Turn, command, and task state is now reduced from the ordered wire in one
  place, rather than held in mutable fields updated across `await` boundaries.
  Each turn's settlement batch is captured synchronously before any suspension
  point, so a turn that opens while an earlier handler is still draining cannot
  have its sends resolved by that handler — the failure that made two
  back-to-back results resolve both callers with the first result.

- A turn owns a *set* of command uuids. The CLI coalesces: a host message
  dequeued while a turn is running joins that turn instead of starting its own.
  Modelling one command per turn left every coalesced message permanently
  unsettled.

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
