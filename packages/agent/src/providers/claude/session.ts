import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import type {
  BackgroundTaskType,
  TurnTrigger,
  AgentSession,
  CancelResult,
  ClearGoalResult,
  GoalOptions,
  GoalState,
  SendHandle,
  SendOptions,
  SessionContext,
  SessionRecord,
  SessionState,
  SetGoalResult,
  StopTaskResult,
  StreamEvent,
  TurnResult,
  UserInputResponse,
} from "../../types.js";
import { GoalController, latestGoalFromEvents, isTerminalGoalStatus } from "../../goals/index.js";
import { claudeGoalCapability } from "./goal-capability.js";
import { claudeSessionCodec } from "./codec.js";
import { backgroundTaskEventFromClaude } from "./parse.js";
import { createSessionRecord } from "../../sessions/record.js";
import { claudeTranscriptOps } from "./transcript.js";
import { findBinary } from "../../utils/binary.js";
import { buildEnv, ensurePathInEnv } from "../../utils/env.js";
import { translateEndpoint } from "../../utils/endpoint.js";
import { claudeEffortFlagValue } from "./effort.js";
import { buildSkillsDir, cleanupSkillsDir } from "../../utils/skills.js";
import { claudeFeatureArgs, cleanupMcpConfig, stageMcpConfig } from "./mcp.js";
import { createToolNameTracker } from "../../utils/tool-names.js";
import { parseStreamLine, classifyClaudeAuthFromResult, CLAUDE_LOGIN_COMMAND, type PartialStreamContext } from "./parse.js";

/** A pending `send()` whose `result` Promise hasn't settled yet. */
interface PendingResult {
  /**
   * The `command_uuid` of the host message this send wrote. A turn claims a
   * uuid when it opens, so the turn's `result` settles exactly the sends it
   * actually ran — rather than whichever `result` happened to land next.
   */
  commandUuid: string;
  resolve: (result: TurnResult) => void;
  reject: (err: Error) => void;
  /** Set once the entry has been settled (by result, timeout, abort, or
   *  reject) so the other paths skip it — prevents double-handling. */
  settled?: boolean;
  /** Tear down this send's timeout timer / abort listener. */
  cleanup?: () => void;
}

// ---------------------------------------------------------------------------
// ndjson helpers
// ---------------------------------------------------------------------------

function ndjsonLine(obj: Record<string, unknown>): string {
  return JSON.stringify(obj) + "\n";
}

function parseJson(line: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(line);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch { /* skip */ }
  return null;
}

function str(obj: Record<string, unknown>, key: string): string {
  const v = obj[key];
  return typeof v === "string" ? v : "";
}

function obj(parent: Record<string, unknown>, key: string): Record<string, unknown> {
  const v = parent[key];
  return typeof v === "object" && v !== null && !Array.isArray(v)
    ? v as Record<string, unknown>
    : {};
}

// ---------------------------------------------------------------------------
// Permission response shaping
// ---------------------------------------------------------------------------

/**
 * Build the wire-shape control_response for a `can_use_tool` request.
 *
 * The CLI's `PermissionResultAllow` schema requires `updatedInput` on every
 * allow response — it carries the (possibly host-modified) tool input back
 * into the agent. If the host doesn't supply one, we echo the original input.
 * `PermissionResultDeny` only requires `behavior` and `message`.
 *
 * Exported for unit testing — not part of the public API.
 *
 * @internal
 */
export function buildPermissionResponse(
  toolUseId: string,
  input: Record<string, unknown>,
  resp: UserInputResponse | null,
): Record<string, unknown> {
  // Auto-allow when no host callback is registered.
  if (resp === null) {
    return { behavior: "allow", toolUseID: toolUseId, updatedInput: input };
  }
  if (resp.allow) {
    const out: Record<string, unknown> = {
      behavior: "allow",
      toolUseID: toolUseId,
      updatedInput: resp.updatedInput ?? input,
    };
    if (resp.message) out["message"] = resp.message;
    return out;
  }
  const out: Record<string, unknown> = {
    behavior: "deny",
    toolUseID: toolUseId,
  };
  if (resp.message) out["message"] = resp.message;
  return out;
}

// ---------------------------------------------------------------------------
// ClaudeSession — persistent multi-turn process
// ---------------------------------------------------------------------------

/**
 * Creates and returns a ClaudeSession that manages a persistent Claude CLI
 * process using the bidirectional stream-json protocol.
 *
 * The CLI is spawned with `--input-format stream-json --output-format stream-json`
 * which keeps stdin open for multi-turn messages instead of reading a single prompt.
 */
export async function createClaudeSession(ctx: SessionContext): Promise<AgentSession> {
  const cwd = ctx.cwd ?? process.cwd();
  const config = ctx.config ?? {};

  // Resolve binary
  const resolved = await findBinary("claude", config.command);

  // Build env
  const env = buildEnv(ctx.env);
  ensurePathInEnv(env);
  // Custom endpoint (BYOK / gateway / alt model) — env-only for claude. `unset`
  // clears ambient Anthropic creds that would otherwise leak to a custom baseUrl.
  const endpointTx = translateEndpoint("claude", config.endpoint);
  Object.assign(env, endpointTx.env);
  for (const key of endpointTx.unset) delete env[key];

  // Build skills dir (if any)
  let skillsDir: string | null = null;
  if (config.skillDirs && config.skillDirs.length > 0) {
    try {
      skillsDir = await buildSkillsDir(config.skillDirs, "claude");
    } catch { /* non-fatal */ }
  }

  // Stage MCP config (if any) — attached via `--mcp-config <file>` (mode 0600),
  // never argv: http server headers can carry bearer tokens and argv is
  // world-readable via `ps`. Cleaned up in close().
  let mcpConfigPath: string | null = null;
  if (config.mcpServers && config.mcpServers.length > 0) {
    mcpConfigPath = await stageMcpConfig(config.mcpServers);
  }

  // Build CLI args for SDK/headless mode
  const args = [
    ...resolved.prefixArgs,
    "--print", "-",
    "--input-format", "stream-json",
    "--output-format", "stream-json",
    "--verbose",
  ];

  // Resume existing session
  const sessionParams = ctx.sessionParams ?? null;
  let resumeId: string | null = null;
  if (sessionParams) {
    const id = (sessionParams["sessionId"] as string) ?? (sessionParams["session_id"] as string);
    if (id && typeof id === "string") {
      args.push("--resume", id);
      resumeId = id;
    }
  }

  // planMode and skipPermissions are mutually exclusive — planMode wins.
  // In plan mode the agent can't actually perform mutations anyway, but we
  // still need stdio permission protocol so the host can inspect the
  // ExitPlanMode permission request and capture the proposed plan.
  if (config.planMode) {
    args.push("--permission-mode", "plan");
    args.push("--permission-prompt-tool", "stdio");
  } else if (config.skipPermissions) {
    args.push("--dangerously-skip-permissions");
  } else {
    // Enable bidirectional permission protocol via control_request/control_response.
    // Without this flag, Claude Code handles permissions internally via its TUI,
    // which silently fails in headless/SDK mode.
    args.push("--permission-prompt-tool", "stdio");
  }
  if (config.model) args.push("--model", config.model);
  if (config.effort) args.push("--effort", claudeEffortFlagValue(config.effort));
  if (config.maxTurns && config.maxTurns > 0) args.push("--max-turns", String(config.maxTurns));
  if (config.instructionsFile) args.push("--append-system-prompt-file", config.instructionsFile);
  if (skillsDir) args.push("--add-dir", skillsDir);
  args.push(...claudeFeatureArgs(config, mcpConfigPath));
  // extraArgs stay LAST so hosts can override any generated flag.
  if (config.extraArgs) args.push(...config.extraArgs);

  // Spawn persistent process
  const proc: ChildProcess = spawn(resolved.bin, args, {
    cwd,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });

  if (!proc.stdin || !proc.stdout || !proc.stderr) {
    // Don't leak staged dirs/files when the spawn fails before the session
    // object (whose close() owns cleanup) exists.
    if (skillsDir) await cleanupSkillsDir(skillsDir);
    await cleanupMcpConfig(mcpConfigPath);
    throw new Error("Failed to open stdio on Claude process");
  }

  const session = new ClaudeSessionImpl(proc, { ...ctx, cwd }, skillsDir, mcpConfigPath);

  // Wire up AbortSignal to close the session
  if (ctx.signal) {
    if (ctx.signal.aborted) {
      void session.close();
    } else {
      ctx.signal.addEventListener("abort", () => void session.close(), { once: true });
    }
  }

  // Finish historical hydration before exposing the session. This prevents a
  // late transcript read from overwriting a goal the caller sets immediately.
  if (resumeId && session.state !== "closed") await session.hydrateGoalFromTranscript(resumeId);

  return session;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * @internal Re-exported for existing import sites; the const now lives in the
 * leaf `goal-capability.ts` so `index.ts` can read it without loading this
 * heavy session module (spec §5.1).
 */
export { claudeGoalCapability } from "./goal-capability.js";

/** Provider tag stamped on every event this session emits. */
const CLAUDE_PROVIDER_TYPE = "claude";

/**
 * `command_lifecycle` states that retire a host message. `completed` follows a
 * `result`; the rest do not produce one at all, which is why they have to
 * close a turn themselves.
 */
const TERMINAL_COMMAND_STATES = new Set(["completed", "cancelled", "discarded", "refused"]);

export class ClaudeSessionImpl implements AgentSession {
  private _state: SessionState = "idle";
  private _sessionId: string | null = null;
  /**
   * The open root turn, or null.
   *
   * `commandUuids` is a set because the CLI coalesces: a second host message
   * dequeued while a turn is running joins that turn rather than starting its
   * own. Modelling one uuid per turn left every coalesced message unsettled.
   *
   * An empty set means the provider opened this turn itself.
   */
  private _openTurn: { turnId: string; trigger: TurnTrigger; commandUuids: Set<string> } | null = null;
  /** Monotonic turn counter, so `turn_start`/`turn_end` can be paired by id. */
  private _turnSeq = 0;
  /**
   * Host messages the CLI has acknowledged and not yet claimed by a turn,
   * keyed by the uuid `send()` generated.
   *
   * The CLI echoes that uuid back on every `command_lifecycle` record, so a
   * turn opened by a `started` naming one of these *is* that message's turn —
   * exact, not inferred. Entries leave only two ways: claimed by a turn, or
   * retired by a terminal lifecycle record.
   */
  private _outstandingCommands = new Set<string>();
  /** Background tasks currently live, by id, with the type they started as. */
  private _activeTasks = new Map<string, BackgroundTaskType>();
  /**
   * Task ids whose results were delivered while no turn was open, and whose
   * resume turn has not arrived yet.
   *
   * A set rather than a flag: two subagents finishing together deliver twice,
   * and one bit could not represent that. Used only to hold `drain()` across
   * the 24-71ms gap between a delivery and the turn it triggers — the task is
   * no longer live by then, so nothing else covers it. Cleared when a turn
   * opens or closes, so a delivery the CLI folds into a running turn cannot
   * pin the session.
   */
  private _pendingDeliveries = new Set<string>();
  /**
   * Settlement batches captured but not yet resolved, one array per turn.
   *
   * Isolated so no turn can drain another's — that sharing is what made two
   * back-to-back results resolve both sends with the first result — but still
   * reachable, so a process exit mid-drain can reject them instead of
   * stranding the caller forever.
   */
  private _settlingBatches = new Set<PendingResult[]>();
  /**
   * Whether this CLI build has ever emitted `command_lifecycle`. Learned once:
   * builds that emit it do so for every host message, so after the first
   * sighting an unnamed turn is genuinely provider-initiated and the
   * oldest-unclaimed fallback must not fire.
   */
  private _seenCommandLifecycle = false;
  /**
   * Whether this stream has produced a `result` yet. `system/init` is session
   * metadata at boot but heads every provider-initiated resume turn, and this
   * is what tells the two apart.
   */
  private _seenResult = false;
  /**
   * Task type and description as first reported on `task_started`, keyed by
   * task id. Later lifecycle records are sparse — `task_updated` is a bare
   * patch and `task_notification` carries no type — so without this a
   * finished subagent normalizes to `taskType: "unknown"` and hosts render
   * "Background task completed" for what is plainly a subagent.
   */
  private _taskFacts = new Map<string, { taskType: BackgroundTaskType; description: string | null }>();
  /**
   * Cap on `_taskFacts`. Entries cannot be dropped on task completion, because
   * a completion arrives as two records and the second still needs enriching,
   * so the map is bounded by eviction instead. A session that ran this many
   * background tasks will not miss the oldest one's label.
   */
  private static readonly TASK_FACT_LIMIT = 512;
  private _lineBuffer = "";
  private _stderrBuffer = "";

  // Pending result-resolvers. With concurrent send, multiple in-flight send()
  // Promises may share a single result event (when the CLI coalesces them
  // into one turn) or get distinct results across turns. On each `result`
  // event we drain the entire list — every pending Promise resolves with the
  // same TurnResult. Subsequent sends queue against a fresh list.
  private _pendingResults: PendingResult[] = [];

  /** Result Promises for sends that haven't settled, tracked so `drain()` can
   *  await the in-flight turn(s) before closing. */
  private _inFlight = new Set<Promise<TurnResult>>();

  /** Set by `drain()`: new `send()` calls are refused while true. */
  private _draining = false;
  /** Shared promise so concurrent / repeated `drain()` calls coalesce. */
  private _drainPromise: Promise<void> | null = null;

  /** Tracks the owning message id across --include-partial-messages lines. */
  private readonly _partialCtx: PartialStreamContext = { messageId: null };

  /** Stamps `tool_result.toolName` by correlating with prior `tool_call`s. */
  private readonly _trackToolName = createToolNameTracker();

  /**
   * Tracks request_ids for async callbacks (permission, elicitation, hooks)
   * that are still in-flight. If the CLI sends a control_cancel_request for
   * one of these, we remove it so the stale response is never sent back.
   */
  private _pendingCallbacks = new Set<string>();

  /**
   * Outgoing control_requests we sent to the CLI and are awaiting a
   * control_response for, keyed by request_id. Currently only used by
   * `cancel(uuid)` (interrupt remains fire-and-forget).
   */
  private _pendingControlResponses = new Map<string, {
    resolve: (response: Record<string, unknown>) => void;
    reject: (err: Error) => void;
  }>();

  /**
   * Serial dispatch chain for `onEvent`. Each dispatched event appends a
   * handler invocation; the chain enforces in-order delivery and lets
   * `send()` await all handlers for the turn before resolving. Control
   * requests stay synchronous and are not gated on this chain.
   */
  private _eventChain: Promise<void> = Promise.resolve();

  /** Session-scoped goal engine (native `/goal` passthrough + emulation fallback). */
  private readonly _goals: GoalController;

  /** Resolved transcript path (shared by the goal poller + sentinel context). */
  private _transcriptPath: string | null = null;
  private _transcriptResolving = false;
  /** Tail state for observing native goal_status (transcript-only, not on stdout). */
  private _goalScanOffset = 0;
  private _goalPoll: ReturnType<typeof setInterval> | null = null;
  private readonly cwd: string;

  constructor(
    private readonly proc: ChildProcess,
    private readonly ctx: SessionContext,
    private readonly skillsDir: string | null,
    private readonly mcpConfigPath: string | null = null,
  ) {
    this.cwd = ctx.cwd ?? process.cwd();
    this._goals = new GoalController({
      providerType: "claude",
      capability: claudeGoalCapability,
      getSessionId: () => this._sessionId,
      send: (m) => this.send(m),
      dispatch: (event) => this.dispatchEvent(event),
      // Best-effort transcript path for custom sentinels that read history.
      // Triggers a lazy async resolve; returns null until it's cached.
      getTranscriptPath: () => this.peekTranscriptPath(),
      // Native arm: `/goal <objective>` arms the CLI's Stop-hook sentinel.
      // Verified against CC 2.1.191: this DOES arm over stream-json stdin, the
      // Haiku sentinel runs, and goal_status attachments are written — but only
      // to the on-disk transcript, NOT the live stdout stream. So we tail the
      // transcript to observe the transitions (startGoalObservation). The
      // objective is whitespace-collapsed for the single-line slash command;
      // the controller keeps the original for state.
      armNative: async (objective) => {
        await this.send(`/goal ${objective.replace(/\s+/g, " ").trim()}`);
        this.startGoalObservation();
        return true;
      },
      clearNative: async () => {
        await this.send("/goal clear");
      },
    });
    // Wire up stdout line-by-line parsing
    proc.stdout!.setEncoding("utf-8");
    proc.stdout!.on("data", (chunk: string) => this.handleStdout(chunk));

    proc.stderr!.setEncoding("utf-8");
    proc.stderr!.on("data", (chunk: string) => {
      this._stderrBuffer += chunk;
      if (this.ctx.onOutput) {
        try { void this.ctx.onOutput("stderr", chunk); } catch { /* swallow */ }
      }
    });

    proc.on("exit", (code, signal) => {
      if (this._state !== "closed") {
        this._state = "closed";
        const err = new Error(
          `Claude process exited unexpectedly (code=${code}, signal=${signal})`
        );
        this.rejectAllPending(err);
      }
    });

    proc.on("error", (err) => {
      if (this._state !== "closed") {
        this._state = "closed";
        this.rejectAllPending(err);
      }
    });
  }

  /**
   * Open a root turn and announce it. Returns the turn that was opened.
   *
   * `commandUuids` starts with the message that opened it, if any; a coalesced
   * message dequeued later joins the same turn via `joinTurn`.
   */
  private openTurn(trigger: TurnTrigger, commandUuid: string | null, msg: Record<string, unknown>): void {
    const turnId = `turn-${++this._turnSeq}`;
    // The set holds every command associated with this turn, including one the
    // CLI named that we have no record of sending. `trigger` says whether it
    // was ours; the set is what lets a terminal lifecycle record close the turn
    // it opened. Without that, a `started`/`refused` pair for an unrecognized
    // uuid opened a turn nothing could close.
    this._openTurn = {
      turnId,
      trigger,
      commandUuids: new Set(commandUuid ? [commandUuid] : []),
    };
    // The delivery that prompted this turn has been answered by it opening.
    this._pendingDeliveries.clear();
    // A host turn takes `thinking` from send(); a provider-initiated one has
    // nothing else to set it, and `state` must not contradict `turn_start`.
    if (this._state === "idle") this._state = "thinking";
    this.dispatchEvent({
      type: "turn_start",
      turnId,
      trigger,
      timestamp: new Date().toISOString(),
      providerType: CLAUDE_PROVIDER_TYPE,
      sessionId: this._sessionId,
      messageId: null,
      eventId: str(msg, "uuid") || null,
      parentToolCallId: null,
      raw: { type: str(msg, "type"), ...(commandUuid ? { command_uuid: commandUuid } : {}) },
    });
  }

  /** Attach a coalesced host message to the turn already running. */
  private joinTurn(commandUuid: string): void {
    this._openTurn?.commandUuids.add(commandUuid);
    this._outstandingCommands.delete(commandUuid);
  }

  /**
   * Close the open turn and announce it. Returns what was closed, or null.
   *
   * Every `turn_start` gets exactly one `turn_end`, which is why this is the
   * only place a turn is cleared. `result` alone could not serve: a cancelled,
   * discarded, or refused message opens a turn and produces no result.
   */
  private closeTurn(
    reason: "result" | "cancelled" | "discarded" | "refused" | "session_closed",
  ): { turnId: string; trigger: TurnTrigger; commandUuids: Set<string> } | null {
    const turn = this.takeOpenTurn();
    this.emitTurnEnd(turn, reason);
    return turn;
  }

  /**
   * Clear the open turn and return it, without announcing the close.
   *
   * Split from the announcement because the state change has to be synchronous
   * — the CLI can flush a result and the next turn's opening line in one chunk
   * — while `turn_end` must be ordered *after* the `result` that carries the
   * turn's payload.
   */
  private takeOpenTurn(): { turnId: string; trigger: TurnTrigger; commandUuids: Set<string> } | null {
    const turn = this._openTurn;
    this._openTurn = null;
    this._pendingDeliveries.clear();
    return turn;
  }

  /** Announce a close for a turn already taken. No-op for a null turn. */
  private emitTurnEnd(
    turn: { turnId: string; trigger: TurnTrigger; commandUuids: Set<string> } | null,
    reason: "result" | "cancelled" | "discarded" | "refused" | "session_closed",
  ): void {
    if (!turn) return;
    this.dispatchEvent({
      type: "turn_end",
      turnId: turn.turnId,
      trigger: turn.trigger,
      reason,
      timestamp: new Date().toISOString(),
      providerType: CLAUDE_PROVIDER_TYPE,
      sessionId: this._sessionId,
      messageId: null,
      eventId: null,
      parentToolCallId: null,
      raw: { reason },
    });
  }

  /**
   * Remove and return the send resolvers belonging to `turn`.
   *
   * Synchronous and exhaustive by design: the caller holds the only reference
   * to the returned array, so no later turn can drain it.
   */
  private claimSettlementBatch(
    turn: { commandUuids: Set<string> } | null,
  ): PendingResult[] {
    const batch: PendingResult[] = [];
    this._settlingBatches.add(batch);
    if (!turn) {
      // A result with no turn to attribute it to. Settling everything is the
      // lesser evil: resolving with a neighbouring turn's result is wrong, but
      // hanging every caller is worse.
      batch.push(...this._pendingResults.splice(0));
      return batch;
    }
    if (turn.commandUuids.size === 0) return batch; // provider-initiated
    for (let i = this._pendingResults.length - 1; i >= 0; i--) {
      if (turn.commandUuids.has(this._pendingResults[i]!.commandUuid)) {
        batch.unshift(...this._pendingResults.splice(i, 1));
      }
    }
    return batch;
  }

  /**
   * Settle any send still waiting on a command the CLI has finished with.
   *
   * `completed` means its turn ran, so it takes that turn's result; the other
   * terminal states mean it never ran at all.
   */
  private settleCommand(commandUuid: string, state: string): void {
    for (let i = this._pendingResults.length - 1; i >= 0; i--) {
      const entry = this._pendingResults[i]!;
      if (entry.commandUuid !== commandUuid || entry.settled) continue;
      this._pendingResults.splice(i, 1);
      entry.settled = true;
      entry.cleanup?.();
      // Reaching here means no turn ever claimed this message, so there is no
      // result of its own to give it. `completed` without a claiming turn is
      // not expected — it is reported honestly rather than papered over with a
      // neighbouring turn's payload.
      entry.resolve({
        status: state === "completed" ? "completed" : "aborted",
        summary: null,
        costUsd: null,
        errorCode: `command_${state}`,
        errorMessage: `Message was ${state} by the CLI without a turn of its own`,
      } as TurnResult);
    }
  }

  /**
   * Reject every send still waiting on a turn, and clear the turn bookkeeping
   * that described it. Shared by the fatal paths and by `close()`.
   */
  private rejectPendingSends(err: Error): void {
    const pending = this._pendingResults.splice(0);
    // Batches already captured for a turn still settling. Their handler may
    // never resume — the process is gone — so they are rejected here rather
    // than left hanging their callers.
    for (const captured of this._settlingBatches) pending.push(...captured);
    this._settlingBatches.clear();
    // No turn survives this, and the host is told so rather than left holding
    // an unmatched `turn_start`.
    this.closeTurn("session_closed");
    this._outstandingCommands.clear();
    this._activeTasks.clear();
    this._taskFacts.clear();
    for (const p of pending) {
      if (p.settled) continue;
      p.settled = true;
      p.cleanup?.();
      p.reject(err);
    }
  }

  /** Reject every pending send() Promise and outgoing control_response. */
  private rejectAllPending(err: Error): void {
    this.rejectPendingSends(err);
    for (const [, p] of this._pendingControlResponses) p.reject(err);
    this._pendingControlResponses.clear();
  }

  get sessionId(): string | null { return this._sessionId; }
  get state(): SessionState { return this._state; }
  private isClosed(): boolean { return this._state === "closed"; }

  /**
   * Durable identity for persistence + later `attachSession`. Null until Claude
   * has assigned a session id (the first `system`/init event); serializes
   * `{sessionId, cwd?}` through the codec so it round-trips back into resume.
   */
  describe(): SessionRecord | null {
    if (!this._sessionId) return null;
    const cwd = this.cwd;
    const params = claudeSessionCodec.serialize({
      sessionId: this._sessionId,
      ...(cwd ? { cwd } : {}),
    });
    if (!params) return null;
    return createSessionRecord({
      providerType: "claude",
      params,
      cwd,
      displayId: claudeSessionCodec.getDisplayId?.(params) ?? null,
    });
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  async send(message: string, options?: SendOptions): Promise<SendHandle> {
    if (this._state === "closed") throw new Error("Session is closed");
    if (this._draining) throw new Error("Session is draining — no new sends accepted");

    // No guard on _state — Claude's CLI accepts user messages mid-turn and
    // queues them internally (drain via `cancel_async_message` if needed).
    // Set state for observability if currently idle; mid-turn the active
    // turn's state machine keeps driving it.
    if (this._state === "idle") this._state = "thinking";

    const uuid = randomUUID();
    // The CLI echoes this back on every `command_lifecycle` record for the
    // message, which is what lets a turn be attributed exactly.
    this._outstandingCommands.add(uuid);

    // Write user message in stream-json format. `uuid` becomes the queue
    // key the CLI uses for `cancel_async_message`.
    const userMsg = ndjsonLine({
      type: "user",
      session_id: this._sessionId ?? "",
      message: { role: "user", content: message },
      parent_tool_use_id: null,
      uuid,
    });

    let resolveFn!: (r: TurnResult) => void;
    let rejectFn!: (e: Error) => void;
    const result = new Promise<TurnResult>((resolve, reject) => {
      resolveFn = resolve;
      rejectFn = reject;
    });

    const entry: PendingResult = { commandUuid: uuid, resolve: resolveFn, reject: rejectFn };
    this._pendingResults.push(entry);

    // Track the in-flight turn so drain() can await it; drop it on settle.
    this._inFlight.add(result);
    void result.catch(() => {}).finally(() => this._inFlight.delete(result));

    // Per-send timeout / abort, falling back to the session-level
    // ProviderConfig.timeoutSec default when no per-call timeout is given.
    this.armSendDeadline(entry, options);

    this.proc.stdin!.write(userMsg);

    return { uuid, result };
  }

  /**
   * Wire up this send's timeout and/or abort signal. On fire, the active turn
   * is interrupted and the send settles with `timeout` / `aborted`. No-op when
   * neither a timeout nor a signal applies.
   */
  private armSendDeadline(entry: PendingResult, options?: SendOptions): void {
    const timeoutSec = options?.timeoutSec ?? this.ctx.config?.timeoutSec;
    const signal = options?.signal;
    const hasTimeout = typeof timeoutSec === "number" && timeoutSec > 0;
    if (!hasTimeout && !signal) return;

    if (signal?.aborted) {
      // Already aborted before the write — settle on the next tick so the
      // caller still receives its SendHandle first.
      queueMicrotask(() => this.settleEarly(entry, "aborted"));
      return;
    }

    let timer: ReturnType<typeof setTimeout> | undefined;
    const onAbort = () => this.settleEarly(entry, "aborted");
    if (hasTimeout) {
      timer = setTimeout(() => this.settleEarly(entry, "timeout"), timeoutSec! * 1000);
    }
    if (signal) signal.addEventListener("abort", onAbort, { once: true });

    entry.cleanup = () => {
      if (timer) clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
    };
  }

  /**
   * Settle a still-pending send early (timeout or abort). Interrupts the active
   * turn best-effort and resolves the send's `result` with a synthetic
   * TurnResult. A no-op if the entry already settled (the real result raced
   * ahead). The late real `result` event later finds the entry already gone.
   */
  private settleEarly(entry: PendingResult, kind: "timeout" | "aborted"): void {
    if (entry.settled) return;
    entry.settled = true;
    entry.cleanup?.();

    const idx = this._pendingResults.indexOf(entry);
    if (idx >= 0) this._pendingResults.splice(idx, 1);

    // Best-effort interrupt of the active turn. With concurrent sends this ends
    // the single shared turn for all of them — see SendOptions JSDoc.
    void this.interrupt();

    entry.resolve({
      summary: null,
      usage: undefined,
      costUsd: null,
      status: kind,
      errorCode: kind,
      errorMessage: kind === "timeout"
        ? "Turn exceeded its timeout and was interrupted"
        : "Turn was aborted",
    });
  }

  async cancel(uuid: string): Promise<CancelResult> {
    if (this._state === "closed") return { cancelled: false };

    const requestId = randomUUID();
    const responsePromise = new Promise<Record<string, unknown>>((resolve, reject) => {
      this._pendingControlResponses.set(requestId, { resolve, reject });
    });

    const cancelMsg = ndjsonLine({
      type: "control_request",
      request_id: requestId,
      request: {
        subtype: "cancel_async_message",
        message_uuid: uuid,
      },
    });

    this.proc.stdin!.write(cancelMsg);

    try {
      const response = await responsePromise;
      // No bookkeeping here: the CLI emits `command_lifecycle/cancelled` for
      // the message, and that is what retires it.
      return { cancelled: response["cancelled"] === true };
    } catch {
      // Process exited / error before response — treat as "not cancelled."
      return { cancelled: false };
    }
  }

  async stopTask(taskId: string): Promise<StopTaskResult> {
    if (this._state === "closed") return { stopped: false };

    const requestId = randomUUID();
    const responsePromise = new Promise<Record<string, unknown>>((resolve, reject) => {
      this._pendingControlResponses.set(requestId, { resolve, reject });
    });

    const stopMsg = ndjsonLine({
      type: "control_request",
      request_id: requestId,
      request: {
        subtype: "stop_task",
        task_id: taskId,
      },
    });

    this.proc.stdin!.write(stopMsg);

    try {
      // The CLI acknowledges a stop with an EMPTY success control_response (no
      // payload), so success alone means "accepted". An unknown / already-ended
      // task_id — or a CLI build without `stop_task` — comes back as an error
      // control_response, which rejects here. Either way we settle to a boolean;
      // the task's terminal status arrives later as a task_updated/notification.
      await responsePromise;
      return { stopped: true };
    } catch {
      return { stopped: false };
    }
  }

  setGoal(objective: string, options?: GoalOptions): Promise<SetGoalResult> {
    return this._goals.setGoal(objective, options);
  }

  clearGoal(options?: { reason?: "cleared" | "blocked" }): Promise<ClearGoalResult> {
    return this._goals.clearGoal(options);
  }

  getGoal(): GoalState | null {
    return this._goals.getGoal();
  }

  async interrupt(): Promise<void> {
    if (this._state === "idle" || this._state === "closed") return;
    this._goals.notifyInterrupted(); // don't let an emulated goal auto-continue

    // Send interrupt control request
    const requestId = randomUUID();
    const interruptMsg = ndjsonLine({
      type: "control_request",
      request_id: requestId,
      request: { subtype: "interrupt" },
    });

    this.proc.stdin!.write(interruptMsg);
    // The result event from the interrupted turn will resolve the pending send()
  }

  async drain(): Promise<void> {
    if (this._state === "closed") return;
    // Coalesce concurrent / repeated drains onto one promise.
    if (this._drainPromise) return this._drainPromise;
    this._draining = true;
    this._drainPromise = (async () => {
      // Let every in-flight turn settle (resolve or reject) before closing, so
      // a running tool finishes rather than being killed mid-flight.
      await Promise.allSettled([...this._inFlight]);
      // `_inFlight` only tracks turns this host dispatched. A provider-initiated
      // turn — the CLI acting on a finished background task — has no send()
      // behind it, so draining used to SIGTERM the CLI mid-turn and kill
      // whatever that turn was doing. Now that the session can see those turns,
      // the one API whose contract is "let in-flight work settle" honors them.
      await this.awaitTurnClose();
      await this.close();
    })();
    return this._drainPromise;
  }

  /**
   * Resolve once no turn is open, or once the deadline passes.
   *
   * Bounded on purpose: a turn that never produces a `result` (a wedged CLI)
   * must not make `drain()` hang forever. Polling rather than eventing because
   * turn close is driven from the stream reader, and a missed edge here would
   * be the same hang by another route.
   */
  private async awaitTurnClose(timeoutMs = 120_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    const settling = (): boolean => {
      if (this._openTurn) return true;
      // A running subagent will hand its result back and open a resume turn,
      // so it is in-flight work. Closing during the gap between the root
      // result and that turn — measured at 8-11s live — killed it outright.
      //
      // Background *processes* are excluded on purpose: a dev server started
      // with run_in_background may never exit, and the contract is "let the
      // agent's work settle", not "outlive whatever it launched".
      // A delivered result whose resume turn has not opened yet. This is the
      // provider's own signal that more work is coming, used where it matters.
      if (this._pendingDeliveries.size > 0) return true;
      for (const taskType of this._activeTasks.values()) {
        if (taskType === "subagent") return true;
      }
      return false;
    };
    while (settling() && this._state !== "closed" && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  async close(): Promise<void> {
    if (this._state === "closed") return;
    this._state = "closed";
    // Anything still waiting has no turn left to settle it. Without this a
    // bare `close()` with a send in flight hung that caller for good.
    this.rejectPendingSends(new Error("Session closed before the turn completed"));
    // Final transcript scan so a goal_status (e.g. `met`) written since the last
    // ~800ms poll isn't lost on a fast close. No-op when no goal is observed.
    await this.scanGoalTranscript().catch(() => { /* best effort */ });
    this.stopGoalObservation();

    // Close stdin to signal the process to exit
    this.proc.stdin!.end();

    // Give it a moment to exit gracefully, then force kill. The grace window is
    // configurable via ProviderConfig.graceSec for sessions running long tools.
    const graceSec = this.ctx.config?.graceSec ?? 5;
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        this.proc.kill("SIGKILL");
        resolve();
      }, graceSec * 1000);

      this.proc.on("exit", () => {
        clearTimeout(timeout);
        resolve();
      });

      this.proc.kill("SIGTERM");
    });

    // Clean up staged dirs/files
    if (this.skillsDir) {
      await cleanupSkillsDir(this.skillsDir);
    }
    await cleanupMcpConfig(this.mcpConfigPath);
  }

  // -------------------------------------------------------------------------
  // Stdout parsing
  // -------------------------------------------------------------------------

  private handleStdout(chunk: string): void {
    // Forward raw output
    if (this.ctx.onOutput) {
      try { void this.ctx.onOutput("stdout", chunk); } catch { /* swallow */ }
    }

    this._lineBuffer += chunk;
    const lines = this._lineBuffer.split("\n");
    this._lineBuffer = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      this.handleLine(trimmed);
    }
  }

  private handleLine(line: string): void {
    const msg = parseJson(line);
    if (!msg) return;

    const type = str(msg, "type");

    // Control requests from CLI (can_use_tool, elicitation, initialize, etc.)
    if (type === "control_request") {
      this.handleControlRequest(msg);
      return;
    }

    // Control cancel — CLI is aborting a pending request (e.g., hook won the
    // race against the SDK permission prompt).
    if (type === "control_cancel_request") {
      const cancelId = str(msg, "request_id");
      if (cancelId) this._pendingCallbacks.delete(cancelId);
      return;
    }

    // Control response — CLI is responding to a control_request we sent
    // (currently only `cancel_async_message`; `interrupt` is fire-and-forget).
    if (type === "control_response") {
      this.handleControlResponse(msg);
      return;
    }

    // Result event — turn is complete. Forward to onEvent first (via
    // handleStreamMessage / parseStreamLine) so the wire event flows through
    // the same path as every other line; then resolve the TurnResult. The
    // await inside handleResult drains the chain so handlers settle before
    // the awaiting send() returns.
    if (type === "result") {
      // Close the turn and snapshot its settlement batch synchronously, before
      // any `await`. Both halves matter. Closing late swallows the next
      // `turn_start`, because the CLI can flush this result and the following
      // turn's opening line in one chunk. Snapshotting late is worse: the
      // batch used to live in a field shared by every turn, so whichever
      // async handler resumed first drained all of it and resolved the second
      // turn's sends with the first turn's result.
      const closingTurn = this.takeOpenTurn();
      const batch = this.claimSettlementBatch(closingTurn);
      this._seenResult = true;
      this.handleStreamMessage(msg, line);
      // Announced after the result event, so the payload precedes the close.
      this.emitTurnEnd(closingTurn, "result");
      void this.handleResult(msg, batch);
      return;
    }

    // Stream events — forward via onEvent and parse for agentex StreamEvent
    this.handleStreamMessage(msg, line);
  }

  // -------------------------------------------------------------------------
  // Control request dispatch
  // -------------------------------------------------------------------------

  private handleControlRequest(msg: Record<string, unknown>): void {
    const requestId = str(msg, "request_id");
    const request = obj(msg, "request");
    const subtype = str(request, "subtype");
    const nested = msg["parent_tool_use_id"] != null
      || request["parent_tool_use_id"] != null;

    switch (subtype) {
      case "initialize":
        this.sendControlResponse(requestId, {});
        break;

      // A detached subagent raises its own prompts, and those are the child
      // being blocked, not this session. Parking the parent in
      // `waiting_for_approval` there outlived the root turn with nothing able
      // to clear it — the same nested-actor rule the stream path applies.
      case "can_use_tool":
        if (!nested) this._state = "waiting_for_approval";
        this.handlePermissionRequest(requestId, request);
        break;

      case "elicitation":
        if (!nested) this._state = "waiting_for_input";
        this.handleElicitationRequest(requestId, request);
        break;

      case "hook_callback":
        this.handleHookCallback(requestId, request);
        break;

      default:
        // Unknown control request — respond with empty success to unblock the
        // CLI. This covers subtypes like set_permission_mode, mcp_status,
        // get_context_usage, etc., that don't require host action.
        this.sendControlResponse(requestId, {});
        break;
    }
  }

  /**
   * Handle a `control_response` from the CLI — a reply to an outgoing
   * `control_request` we sent (currently only `cancel_async_message`).
   *
   * Wire shape:
   *   {type:"control_response", response:{request_id, subtype:"success"|"error", response:{...} | error}}
   */
  private handleControlResponse(msg: Record<string, unknown>): void {
    const response = obj(msg, "response");
    const requestId = str(response, "request_id");
    if (!requestId) return;
    const pending = this._pendingControlResponses.get(requestId);
    if (!pending) return;
    this._pendingControlResponses.delete(requestId);

    const subtype = str(response, "subtype");
    if (subtype === "error") {
      const errMsg = str(response, "error") || "control_response error";
      pending.reject(new Error(errMsg));
      return;
    }
    pending.resolve(obj(response, "response"));
  }

  // -------------------------------------------------------------------------
  // can_use_tool — permission requests
  // -------------------------------------------------------------------------

  private async handlePermissionRequest(
    requestId: string,
    request: Record<string, unknown>,
  ): Promise<void> {
    const toolName = str(request, "tool_name");
    const input = obj(request, "input");
    const toolUseId = str(request, "tool_use_id");

    // If no permission callback, auto-allow
    if (!this.ctx.onUserInputRequest) {
      this.sendControlResponse(
        requestId,
        buildPermissionResponse(toolUseId, input, null),
      );
      return;
    }

    this._pendingCallbacks.add(requestId);

    try {
      const resp = await this.ctx.onUserInputRequest({
        toolName,
        input,
        toolUseId,
        title: str(request, "title") || undefined,
        displayName: str(request, "display_name") || undefined,
        description: str(request, "description") || undefined,
        agentId: str(request, "agent_id") || undefined,
      });

      // If the request was cancelled while we were waiting, don't respond
      if (!this._pendingCallbacks.delete(requestId)) return;

      this.sendControlResponse(
        requestId,
        buildPermissionResponse(toolUseId, input, resp),
      );
      if (this._state === "waiting_for_approval") this._state = "thinking";
    } catch {
      if (!this._pendingCallbacks.delete(requestId)) return;
      this.sendControlResponse(requestId, {
        behavior: "deny",
        toolUseID: toolUseId,
        message: "Permission callback threw an error",
      });
      if (this._state === "waiting_for_approval") this._state = "thinking";
    }
  }

  // -------------------------------------------------------------------------
  // elicitation — MCP servers requesting user input
  // -------------------------------------------------------------------------

  private async handleElicitationRequest(
    requestId: string,
    request: Record<string, unknown>,
  ): Promise<void> {
    // If no elicitation callback, decline
    if (!this.ctx.onElicitation) {
      this.sendControlResponse(requestId, { action: "decline" });
      return;
    }

    this._pendingCallbacks.add(requestId);

    try {
      const resp = await this.ctx.onElicitation({
        mcpServerName: str(request, "mcp_server_name"),
        message: str(request, "message"),
        mode: (str(request, "mode") as "form" | "url") || undefined,
        url: str(request, "url") || undefined,
        elicitationId: str(request, "elicitation_id") || undefined,
        requestedSchema: typeof request["requested_schema"] === "object" && request["requested_schema"] !== null
          ? request["requested_schema"] as Record<string, unknown>
          : undefined,
      });

      if (!this._pendingCallbacks.delete(requestId)) return;

      const response: Record<string, unknown> = { action: resp.action };
      if (resp.action === "accept" && resp.content) {
        response["content"] = resp.content;
      }

      this.sendControlResponse(requestId, response);
      if (this._state === "waiting_for_input") this._state = "thinking";
    } catch {
      if (!this._pendingCallbacks.delete(requestId)) return;
      this.sendControlResponse(requestId, { action: "cancel" });
      if (this._state === "waiting_for_input") this._state = "thinking";
    }
  }

  // -------------------------------------------------------------------------
  // hook_callback — CLI requesting the host to execute a hook
  // -------------------------------------------------------------------------

  private async handleHookCallback(
    requestId: string,
    request: Record<string, unknown>,
  ): Promise<void> {
    // If no hook callback, return empty result
    if (!this.ctx.onHookCallback) {
      this.sendControlResponse(requestId, {});
      return;
    }

    this._pendingCallbacks.add(requestId);

    try {
      const resp = await this.ctx.onHookCallback({
        callbackId: str(request, "callback_id"),
        input: obj(request, "input"),
        toolUseId: str(request, "tool_use_id") || undefined,
      });

      if (!this._pendingCallbacks.delete(requestId)) return;
      this.sendControlResponse(requestId, resp.result ?? {});
    } catch {
      if (!this._pendingCallbacks.delete(requestId)) return;
      this.sendControlErrorResponse(requestId, "Hook callback threw an error");
    }
  }

  // -------------------------------------------------------------------------
  // Response helpers
  // -------------------------------------------------------------------------

  private sendControlResponse(requestId: string, response: Record<string, unknown>): void {
    const msg = ndjsonLine({
      type: "control_response",
      response: {
        request_id: requestId,
        subtype: "success",
        response,
      },
    });
    this.proc.stdin!.write(msg);
  }

  private sendControlErrorResponse(requestId: string, error: string): void {
    const msg = ndjsonLine({
      type: "control_response",
      response: {
        request_id: requestId,
        subtype: "error",
        error,
      },
    });
    this.proc.stdin!.write(msg);
  }

  // -------------------------------------------------------------------------
  // Result handling
  // -------------------------------------------------------------------------

  private async handleResult(
    msg: Record<string, unknown>,
    batch: PendingResult[] = [],
  ): Promise<void> {
    const summary = typeof msg["result"] === "string" ? msg["result"] : null;
    const isError = msg["is_error"] === true;
    const costUsd = typeof msg["total_cost_usd"] === "number" ? msg["total_cost_usd"] : null;
    const stopReason = str(msg, "stop_reason") || null;
    const modelName = str(msg, "model") || null;

    const usageObj = typeof msg["usage"] === "object" && msg["usage"] !== null
      ? msg["usage"] as Record<string, unknown>
      : null;

    const usageData = usageObj ? {
      inputTokens: typeof usageObj["input_tokens"] === "number" ? usageObj["input_tokens"] : 0,
      outputTokens: typeof usageObj["output_tokens"] === "number" ? usageObj["output_tokens"] : 0,
      cachedInputTokens: typeof usageObj["cache_read_input_tokens"] === "number"
        ? usageObj["cache_read_input_tokens"] : undefined,
    } : undefined;

    // Key usage by model name
    const usage = usageData && modelName
      ? { [modelName]: usageData }
      : undefined;

    // Extract session ID
    if (typeof msg["session_id"] === "string" && msg["session_id"]) {
      this._sessionId = msg["session_id"];
    }

    // Detect error codes and derive status. Run the auth classifier
    // before the generic `isError` branch so auth failures get the
    // specific `auth_required` code and a recovery message instead of
    // a vague `execution_error`.
    let errorCode: string | null = null;
    const subtype = str(msg, "subtype");
    let status: TurnResult["status"] = "completed";
    const authClassification = classifyClaudeAuthFromResult(msg);

    if (subtype === "error_max_turns" || stopReason === "max_turns") {
      errorCode = "max_turns";
      status = "max_turns";
    } else if (subtype === "error_max_budget_usd") {
      errorCode = "max_budget";
      status = "max_budget";
    } else if (authClassification) {
      errorCode = "auth_required";
      status = "failed";
    } else if (subtype === "error_during_execution" || isError) {
      errorCode = errorCode ?? "execution_error";
      status = "failed";
    }

    const errorMessage = (() => {
      if (authClassification) {
        return summary
          ? `${summary} (run \`${CLAUDE_LOGIN_COMMAND}\`)`
          : `Claude requires authentication. Run \`${CLAUDE_LOGIN_COMMAND}\`.`;
      }
      return isError ? summary : null;
    })();

    const result: TurnResult = {
      summary,
      usage,
      costUsd,
      status,
      errorCode,
      errorMessage,
    };

    // Drain pending onEvent handlers so callers awaiting send() see a
    // settled DB / log / UI state by the time TurnResult resolves. The
    // chain snapshot here covers every event queued up to and including
    // the result event; later events extend the chain but aren't awaited.
    await this._eventChain;

    // The await above yields the event loop; the process may have exited
    // (or the session closed) during that window, in which case the exit
    // handler already rejected the turn and set state to "closed". Don't
    // overwrite that with "idle" — it would falsely advertise a usable
    // session whose stdin is dead.
    if (this._state === "closed") return;

    // Only fall back to idle if no new turn opened while the chain drained.
    // The CLI can start the next turn in the same chunk as this result, and
    // asserting idle over a turn that is already running is the exact false
    // "finished" this release exists to remove.
    if (!this._openTurn) this._state = "idle";

    // Settle the batch this turn owns — and only that batch. It was captured
    // synchronously when the result line was read, so a turn that opened while
    // this handler was suspended cannot have its sends resolved here. That
    // sharing is what made two back-to-back results resolve both sends with
    // the first result.
    this._settlingBatches.delete(batch);
    for (const p of batch) {
      // Skip sends already settled early by timeout / abort.
      if (p.settled) continue;
      p.settled = true;
      p.cleanup?.();
      p.resolve(result);
    }

    // Advance any emulated goal loop now that the turn has fully settled.
    void this._goals.onTurnSettled(result);
  }

  // -------------------------------------------------------------------------
  // Stream event forwarding
  // -------------------------------------------------------------------------

  private handleStreamMessage(msg: Record<string, unknown>, rawLine: string): void {
    // A line can arrive during close()'s grace window. Acting on it would
    // reopen a turn on a dead session, flip `state` off "closed", and emit a
    // `turn_start` to a host that has already drained — with nothing left to
    // ever close it again.
    if (this._state === "closed") return;

    // Extract session ID from any message that has one
    if (typeof msg["session_id"] === "string" && msg["session_id"]) {
      this._sessionId = msg["session_id"];
    }

    // Update session state based on message type. Nested-actor lines are
    // excluded for the same reason they do not open a turn: a detached
    // subagent streams its own output onto the parent after the root result,
    // and letting it drive `state` left the session reporting "thinking" for
    // the child's whole run — directly contradicting `turn_start`/`result`,
    // with nothing to clear it if the child is stopped or killed.
    const type = str(msg, "type");
    if (msg["parent_tool_use_id"] == null) {
      if (type === "assistant" || type === "thinking") {
        this._state = "thinking";
      } else if (type === "tool_use") {
        this._state = "tool_executing";
      } else if (type === "tool_result") {
        this._state = "thinking";
      }
    }

    // Retire host messages the CLI has finished with, before deciding what a
    // turn opening means. `refused`/`discarded` never produce a `result`, so
    // this is also the only thing that closes a turn they opened — without it
    // the session would pin as working with no path back.
    if (type === "command_lifecycle") {
      this._seenCommandLifecycle = true;
      const commandUuid = str(msg, "command_uuid");
      const state = str(msg, "state");
      if (commandUuid && TERMINAL_COMMAND_STATES.has(state)) {
        this._outstandingCommands.delete(commandUuid);
        // The CLI is done with this message. Anything still waiting on it will
        // never be settled by a `result` — a cancelled or refused message
        // produces none, and a `completed` one whose turn we could not attribute
        // would otherwise wait forever.
        this.settleCommand(commandUuid, state);
        if (state !== "completed" && this._openTurn?.commandUuids.has(commandUuid)) {
          // Nothing else will close this turn: these states never produce a
          // `result`. (A closed session returned above, so state is live.)
          this.closeTurn(state as "cancelled" | "discarded" | "refused");
          this._state = "idle";
        }
      }
    }

    // Background-task state is session state: `drain()` waits on live
    // subagents and turn attribution consumes delivered results. Decoded here
    // from the wire rather than in the dispatch path, which only runs when a
    // host subscribed — a host that reads `session.state` and calls `drain()`
    // without an onEvent handler would otherwise get neither.
    this.trackBackgroundTaskState(msg);

    // Open a turn on the first line of turn content, before that line's own
    // events, so a host sees turn_start → … → result → turn_end in order.
    const namedUuid = type === "command_lifecycle" ? str(msg, "command_uuid") : "";
    if (this._openTurn) {
      // The CLI coalesces: a host message dequeued while a turn is running
      // joins it rather than starting its own. Modelling one command per turn
      // left every coalesced message permanently unsettled.
      if (namedUuid && this._outstandingCommands.has(namedUuid)) this.joinTurn(namedUuid);
    } else if (this.opensTurn(msg, type)) {
      // Exact attribution: the CLI stamps every `command_lifecycle` for a host
      // message with the uuid `send()` minted, so a `started` naming one we are
      // still waiting on *is* that message's turn. Anything else opened the
      // turn without us asking — which is what this event exists to expose.
      const claimedUuid = namedUuid
        ? (this._outstandingCommands.has(namedUuid) ? namedUuid : null)
        // Only guess for a build that has never named a command. Once one has,
        // it names every host message, so an unnamed turn is provider-initiated
        // and consuming a uuid here would mislabel twice.
        : this._seenCommandLifecycle
          ? null
          : this._outstandingCommands.values().next().value ?? null;
      if (claimedUuid) this._outstandingCommands.delete(claimedUuid);
      // Track the named command even when it is not one of ours, so its
      // terminal lifecycle record can close this turn.
      this.openTurn(claimedUuid ? "send" : "resume", claimedUuid ?? (namedUuid || null), msg);
    }

    // Parse + dispatch when there's an onEvent subscriber OR an active goal to
    // observe, so native goal_status transitions update getGoal() even with no
    // handler. dispatchEvent observes unconditionally and gates delivery on cb.
    if (this.ctx.onEvent || this._goals.isTracking()) {
      for (const event of parseStreamLine(rawLine, this._partialCtx)) {
        this.dispatchEvent(event);
      }
    }
  }

  /**
   * Whether this wire line is the first content of a turn.
   *
   * Deliberately excludes two things.
   *
   * The background-task records (`task_started`, `task_updated`,
   * `task_notification`, `background_tasks_changed`) arrive *between* turns —
   * a detached child reporting in while nothing is running — so treating one
   * as a turn opening would report the session as working every time a
   * background process coughed.
   *
   * `system/init` is special. It is boot metadata the first time — before any
   * result, opening a turn on it would create a phantom `resume` at startup,
   * leave it open, and swallow the first real send's `turn_start`. But the
   * CLI re-emits it at the head of every provider-initiated resume turn, and
   * measured live it precedes that turn's first assistant line by 1.4–1.9s.
   * Ignoring it outright traded a phantom turn for a second-long blind window
   * on exactly the turns this event exists to expose, so it opens a turn once
   * a result has been seen on this stream and not before.
   *
   * And anything carrying `parent_tool_use_id`, which is a nested actor's own
   * output. Claude streams a detached subagent's assistant text, thinking and
   * tool calls onto the parent stream while the root turn is over. Those are
   * the child working, not this session, and counting them would hold the
   * session "working" for the entire detached run — when the honest answer,
   * and what the CLI shows, is that the root turn finished and its result is
   * ready to read. The real resume turn arrives afterwards, at root level,
   * once the child's result is delivered back.
   */
  private opensTurn(msg: Record<string, unknown>, type: string): boolean {
    if (msg["parent_tool_use_id"] != null) return false;
    // `stream_event` is the partial-message wrapper. Without it, a host that
    // opted into `includePartialMessages` receives the whole streamed reply
    // before `turn_start` — the turn's output arriving before the event that
    // says the turn began.
    if (type === "stream_event") return true;
    // `command_lifecycle/started` heads every host-dispatched turn and only
    // those — never a resume — so it is safe to open on and carries no
    // phantom-turn risk. It is also the earliest signal available: without it
    // the session's very first turn has no opener until its first assistant
    // line, measured live at 1.8-6.4s of reading as idle while working.
    if (type === "command_lifecycle") return str(msg, "state") === "started";
    if (type === "system") return this._seenResult && str(msg, "subtype") === "init";
    // `thinking` and `tool_use` are content blocks inside an `assistant`
    // message, not top-level wire types; they are listed because the state
    // machine above accepts them and the two should not disagree about what
    // counts as turn content.
    return type === "assistant"
      || type === "thinking"
      || type === "tool_use"
      || type === "user";
  }

  /**
   * Fold one background-task wire record into session state.
   *
   * Separate from the enrichment below on purpose: this must run for every
   * line regardless of whether anything is listening, because `drain()` and
   * turn attribution read what it maintains.
   */
  private trackBackgroundTaskState(msg: Record<string, unknown>): void {
    const event = backgroundTaskEventFromClaude(msg);
    if (!event) return;

    const terminal = event.status === "completed"
      || event.status === "failed"
      || event.status === "stopped";
    if (terminal) {
      this._activeTasks.delete(event.taskId);
    } else if (event.status !== null || event.phase === "started") {
      // `status: null` means "no change reported" — a sparse patch that only
      // renames a task says nothing about liveness. Writing the task back into
      // the live set there resurrected work that had already completed.
      this._activeTasks.set(event.taskId, this._taskFacts.get(event.taskId)?.taskType ?? event.taskType);
    }

    // The provider stating that a turn is coming — held so `drain()` does not
    // close in the gap before it opens. Keyed on the outcome rather than on
    // the delivery record alone, because a completion arrives as two records
    // (`task_updated` then `task_notification`) and the first already removes
    // the task from the live set: waiting only for the second left a window
    // where neither the task nor the delivery was visible.
    //
    // Only for outcomes that actually deliver. A stopped task hands nothing
    // back and starts no turn, so holding for one would just burn the deadline.
    const delivers = event.status === "completed" || event.status === "failed";
    if ((event.report || delivers) && !this._openTurn) {
      this._pendingDeliveries.add(event.taskId);
    }

    if (event.phase === "started") {
      this._taskFacts.set(event.taskId, {
        taskType: event.taskType,
        description: event.description,
      });
      // Evict oldest-first. Map iteration is insertion-ordered, so the first
      // key is the least recently started task.
      while (this._taskFacts.size > ClaudeSessionImpl.TASK_FACT_LIMIT) {
        const oldest = this._taskFacts.keys().next();
        if (oldest.done) break;
        this._taskFacts.delete(oldest.value);
      }
    }
  }

  /**
   * Fill in what a sparse background-task record leaves out.
   *
   * `task_started` is the only record that names the task's type; the patches
   * and the completion notification that follow identify it by id alone. This
   * remembers the first description and carries it forward so a completion
   * still knows it was a subagent.
   */
  private _trackTaskFacts(event: StreamEvent): StreamEvent {
    if (event.type !== "background_task") return event;
    const known = this._taskFacts.get(event.taskId);
    if (!known) return event;
    const needsType = event.taskType === "unknown" && known.taskType !== "unknown";
    const needsDescription = event.description === null && known.description !== null;
    if (!needsType && !needsDescription) return event;
    return {
      ...event,
      taskType: needsType ? known.taskType : event.taskType,
      description: needsDescription ? known.description : event.description,
    };
  }

  private dispatchEvent(event: StreamEvent): void {
    // Enrich and record before anything can bail out. `_trackTaskFacts` also
    // maintains session state — which tasks are live, which results are
    // waiting for a resume turn — and gating that on a subscriber meant
    // `session.state`, `drain()` and turn attribution all silently degraded
    // for a host that reads the session without an onEvent handler.
    const enriched = this._trackTaskFacts(this._trackToolName(event));
    // Let the goal engine track native goal_status transitions even when no
    // onEvent handler is attached (keeps getGoal() accurate).
    this._goals.observe(enriched);
    const cb = this.ctx.onEvent;
    if (!cb) return;
    this._eventChain = this._eventChain.then(async () => {
      try { await cb(enriched); } catch { /* swallow */ }
    });
  }

  // -------------------------------------------------------------------------
  // Native goal observation
  //
  // Claude's `/goal` writes `goal_status` attachments to the on-disk transcript
  // but NOT to the live stdout stream we parse, so the controller can't observe
  // native transitions from events. While a native goal is active we tail the
  // transcript and feed any `goal_status` lines through the normal dispatch
  // (which runs `_goals.observe` + delivers to onEvent). Self-stops once the
  // goal reaches a terminal state; also stopped on close().
  // -------------------------------------------------------------------------

  private startGoalObservation(): void {
    if (this._goalPoll) return;
    // NB: do NOT reset _goalScanOffset here. It persists across goals so a second
    // goal in the same session doesn't replay the first goal's historical
    // goal_status lines. It starts at 0 (fresh session) and advances as we read.
    const tick = (): void => { void this.scanGoalTranscript().catch(() => { /* best effort */ }); };
    this._goalPoll = setInterval(tick, 800);
    if (typeof this._goalPoll.unref === "function") this._goalPoll.unref();
    // Defer the first scan: `armNative` calls this BEFORE the controller has
    // recorded its optimistic `active` state, so a synchronous scan would see
    // `isTracking() === false` and immediately stop the poller.
    setTimeout(tick, 0);
  }

  private stopGoalObservation(): void {
    if (this._goalPoll) {
      clearInterval(this._goalPoll);
      this._goalPoll = null;
    }
  }

  private async scanGoalTranscript(): Promise<void> {
    if (!this._goalPoll) return; // observation already stopped
    // Stop once the goal is terminal (or was never really native).
    if (!this._goals.isTracking()) { this.stopGoalObservation(); return; }
    const filePath = await this.resolveTranscriptPath();
    if (!filePath) return;
    for await (const { event, offset } of claudeTranscriptOps.read({
      filePath,
      fromOffset: this._goalScanOffset,
    })) {
      this._goalScanOffset = offset;
      if (event.type === "goal_status") this.dispatchEvent(event);
    }
  }

  /** Resolve + cache the on-disk transcript path for this session. */
  private async resolveTranscriptPath(): Promise<string | null> {
    if (this._transcriptPath) return this._transcriptPath;
    const sessionId = this._sessionId;
    if (!sessionId || this._transcriptResolving) return null;
    this._transcriptResolving = true;
    try {
      const found = await claudeTranscriptOps.find({
        sessionId,
        cwd: this.cwd,
      });
      if (found) this._transcriptPath = found.filePath;
    } catch { /* best effort */ } finally {
      this._transcriptResolving = false;
    }
    return this._transcriptPath;
  }

  /** Sync accessor for the sentinel context; kicks off a lazy resolve. */
  private peekTranscriptPath(): string | null {
    if (!this._transcriptPath && this._sessionId) void this.resolveTranscriptPath();
    return this._transcriptPath;
  }

  /**
   * On resume, restore an unmet native goal from the transcript so getGoal()
   * reflects it and observation continues (Claude persists an unmet goal across
   * --resume; an achieved/cleared one is not restored).
   */
  async hydrateGoalFromTranscript(sessionId: string): Promise<void> {
    try {
      if (this.isClosed()) return;
      const found = await claudeTranscriptOps.find({
        sessionId,
        cwd: this.cwd,
      });
      if (!found || this.isClosed()) return;
      this._transcriptPath = found.filePath;
      const events: StreamEvent[] = [];
      let endOffset = 0;
      for await (const { event, offset } of claudeTranscriptOps.read({ filePath: found.filePath })) {
        if (this.isClosed()) return;
        endOffset = offset;
        if (event.type === "goal_status") events.push(event);
      }
      const last = latestGoalFromEvents(events);
      if (!this.isClosed() && last && !isTerminalGoalStatus(last.status)) {
        // Start observing from the END of the historical transcript so the poller
        // surfaces only post-resume transitions (we already hydrated the state).
        this._goalScanOffset = endOffset;
        this._goals.hydrate(last);
        this.startGoalObservation();
      }
    } catch { /* best effort */ }
  }

}
