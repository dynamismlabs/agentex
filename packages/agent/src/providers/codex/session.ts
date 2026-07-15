import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import type {
  AgentSession,
  CancelResult,
  ClearGoalResult,
  GoalOptions,
  GoalState,
  StopTaskResult,
  SendHandle,
  SendOptions,
  SessionContext,
  SessionRecord,
  SessionState,
  SetGoalResult,
  StreamEvent,
  TurnResult,
  UserInputResponse,
} from "../../types.js";
import { GoalController, normalizeCodexGoalRecord, isTerminalGoalStatus } from "../../goals/index.js";
import { codexGoalCapability } from "./goal-capability.js";
import { createSessionRecord } from "../../sessions/record.js";
import { findBinary } from "../../utils/binary.js";
import { buildEnv, ensurePathInEnv } from "../../utils/env.js";
import { translateEndpoint } from "../../utils/endpoint.js";
import { injectWorkspaceSkills } from "../../utils/skills.js";
import { resolveInstructions } from "../../utils/instructions.js";
import { createToolNameTracker } from "../../utils/tool-names.js";
import { parseCodexStreamLine } from "./parse.js";
import { withPlanModePreamble } from "./plan-mode.js";
import { scanCodexSessionUsage } from "./usage-scanner.js";
import { codexSessionCodec } from "./codec.js";
import { parseCollaborationModes, resolveCollaborationModeParam } from "./modes.js";

/**
 * Extract a resume thread id from session params (reusing the codec's
 * sessionId / session_id / thread_id alias handling), or null to start fresh.
 */
function readCodexResumeId(
  sessionParams: Record<string, unknown> | null | undefined,
): string | null {
  const decoded = codexSessionCodec.deserialize(sessionParams ?? null);
  const id = decoded?.["sessionId"];
  return typeof id === "string" && id.length > 0 ? id : null;
}

/** One structured question Codex asks via `requestUserInput`, normalized to the
 *  cross-provider AskUserQuestion shape so callers can reuse parseAskUserQuestion. */
interface CodexQuestion {
  id: string;
  header: string;
  question: string;
  options: { label: string; description?: string }[];
  multiSelect?: boolean;
}

/** Pull and normalize the question list out of a `requestUserInput` params blob.
 *  Tolerant of missing/extra fields — drops anything without an id and at least
 *  a question or a header (Codex sometimes sends header-only prompts). */
function parseCodexQuestions(params: Record<string, unknown>): CodexQuestion[] {
  const raw = Array.isArray(params["questions"]) ? params["questions"] : [];
  const out: CodexQuestion[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const q = item as Record<string, unknown>;
    const id = typeof q["id"] === "string" ? q["id"] : "";
    const questionText = typeof q["question"] === "string" ? q["question"] : "";
    const header = typeof q["header"] === "string" ? q["header"] : "";
    if (!id || (!questionText && !header)) continue;
    // Fall back to the header as the prompt text so the bridged AskUserQuestion is
    // never empty and the host can key its answer off the same `question` value.
    const question = questionText || header;
    const options = Array.isArray(q["options"])
      ? q["options"]
          .filter((o): o is Record<string, unknown> => typeof o === "object" && o !== null)
          .map((o) => ({
            label: typeof o["label"] === "string" ? o["label"] : "",
            ...(typeof o["description"] === "string" && o["description"]
              ? { description: o["description"] as string }
              : {}),
          }))
          .filter((o) => o.label.length > 0)
      : [];
    out.push({
      id,
      header,
      question,
      options,
      ...(q["multiSelect"] === true ? { multiSelect: true } : {}),
    });
  }
  return out;
}

function normalizeAnswerValues(raw: unknown): string[] {
  if (typeof raw === "string") return raw.length > 0 ? [raw] : [];
  if (Array.isArray(raw)) return raw.filter((v): v is string => typeof v === "string" && v.length > 0);
  return [];
}

/** Translate a host AskUserQuestion answer (keyed by question text or header)
 *  into the Codex `requestUserInput` response shape:
 *  `{ [questionId]: { answers: string[] } }`. A denied response yields {}. */
function buildCodexUserInputAnswers(
  questions: CodexQuestion[],
  resp: UserInputResponse,
): Record<string, { answers: string[] }> {
  const out: Record<string, { answers: string[] }> = {};
  if (!resp.allow) return out;
  const updated =
    resp.updatedInput && typeof resp.updatedInput["answers"] === "object"
      ? (resp.updatedInput["answers"] as Record<string, unknown>)
      : null;
  if (!updated) return out;
  for (const q of questions) {
    const raw = updated[q.question] ?? updated[q.header];
    const values = normalizeAnswerValues(raw);
    if (values.length > 0) out[q.id] = { answers: values };
  }
  return out;
}

/** A pending `send()` whose `result` Promise hasn't settled yet. */
interface PendingResult {
  resolve: (result: TurnResult) => void;
  reject: (err: Error) => void;
  /** Set once the entry has been settled (by result, timeout, abort, or
   *  reject) so the other paths skip it — prevents double-handling. */
  settled?: boolean;
  /** Tear down this send's timeout timer / abort listener. */
  cleanup?: () => void;
}

interface TrackedBackgroundTask {
  taskId: string;
  description: string | null;
  summary: string | null;
  parentTaskId: string | null;
  terminal: boolean;
}

/** Identity latch for the root turn currently represented by this session. */
interface ActiveTurnReady {
  promise: Promise<string | null>;
  resolve: (turnId: string | null) => void;
  reject: (err: Error) => void;
  settled: boolean;
}

// ---------------------------------------------------------------------------
// JSON-RPC 2.0 helpers
// ---------------------------------------------------------------------------

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

function num(obj: Record<string, unknown>, key: string): number {
  const v = obj[key];
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function asObj(parent: Record<string, unknown>, key: string): Record<string, unknown> {
  const v = parent[key];
  return typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
}

/** Discriminated incoming message from the Codex CLI. */
type IncomingMessage =
  | { kind: "response"; id: number; result?: Record<string, unknown>; error?: { code: number; message: string } }
  | { kind: "request"; id: number; method: string; params: Record<string, unknown> }
  | { kind: "notification"; method: string; params: Record<string, unknown> }
  | { kind: "legacy_event"; event: Record<string, unknown> };

function classifyMessage(msg: Record<string, unknown>): IncomingMessage | null {
  // Detect JSON-RPC by *structure*, not by the `jsonrpc:"2.0"` discriminator.
  // codex-cli 0.130.0's `app-server` emits responses without the `jsonrpc`
  // field (technically non-compliant with the spec, but it's what ships).
  // Heuristic: a message is JSON-RPC if it has any of (jsonrpc, id, method).
  const hasJsonRpc = msg["jsonrpc"] === "2.0";
  const hasId = "id" in msg && (typeof msg["id"] === "number" || typeof msg["id"] === "string");
  const hasMethod = "method" in msg && typeof msg["method"] === "string";
  const hasResult = "result" in msg;
  const hasError = "error" in msg;

  if (hasJsonRpc || hasId || hasMethod) {
    const id = hasId
      ? (typeof msg["id"] === "number" ? msg["id"] : parseInt(String(msg["id"]), 10))
      : null;

    if (hasId && hasMethod) {
      return { kind: "request", id: id!, method: msg["method"] as string, params: asObj(msg, "params") };
    }
    if (hasId && (hasResult || hasError)) {
      const errRaw = msg["error"];
      const error = typeof errRaw === "object" && errRaw !== null
        ? { code: num(errRaw as Record<string, unknown>, "code"), message: str(errRaw as Record<string, unknown>, "message") }
        : undefined;
      const result = typeof msg["result"] === "object" && msg["result"] !== null
        ? (msg["result"] as Record<string, unknown>)
        : undefined;
      return { kind: "response", id: id!, result, error };
    }
    if (hasMethod) {
      return { kind: "notification", method: msg["method"] as string, params: asObj(msg, "params") };
    }
  }

  // Legacy NDJSON events (from `codex exec --json` format) — have a `type` field
  if (typeof msg["type"] === "string") {
    return { kind: "legacy_event", event: msg };
  }

  return null;
}

// ---------------------------------------------------------------------------
// createCodexSession
// ---------------------------------------------------------------------------

export async function createCodexSession(ctx: SessionContext): Promise<AgentSession> {
  const cwd = ctx.cwd ?? process.cwd();
  const config = ctx.config ?? {};

  // Resolve binary
  const resolved = await findBinary("codex", config.command);

  // Build env
  const env = buildEnv(ctx.env);
  ensurePathInEnv(env);
  // Custom endpoint (BYOK / gateway / alt model) — codex needs both a
  // synthesized model_providers block (`-c` args, added below) and the key in env.
  // `unset` is empty for codex (the ambient key never routes to the endpoint).
  const endpointTx = translateEndpoint("codex", config.endpoint);
  Object.assign(env, endpointTx.env);
  for (const key of endpointTx.unset) delete env[key];

  // Inject skills
  if (config.skillDirs && config.skillDirs.length > 0) {
    try {
      await injectWorkspaceSkills(config.skillDirs, cwd);
    } catch { /* non-fatal */ }
  }

  // Resolve instructions. In plan mode, prepend a preamble so the agent
  // investigates-and-proposes rather than attempting writes that the sandbox
  // will reject. See ./plan-mode.ts for rationale.
  const baseInstructions = await resolveInstructions(config.instructionsFile);
  const instructions = config.planMode
    ? withPlanModePreamble(baseInstructions)
    : baseInstructions;

  // Spawn Codex in interactive JSON-RPC mode via the `app-server` subcommand
  // (codex-cli 0.130.0+; the old top-level `--json` flag was removed).
  //
  // Args order matters: `--sandbox` and `--dangerously-bypass-approvals-and-sandbox`
  // are TOP-LEVEL options and must come BEFORE the `app-server` subcommand.
  // extraArgs land after the subcommand — semantics depend on the user's intent.
  const args = [...resolved.prefixArgs];
  if (config.planMode) {
    args.push("--sandbox", "read-only");
  } else if (config.skipPermissions) {
    args.push("--dangerously-bypass-approvals-and-sandbox");
  }
  // Custom endpoint model_providers overrides are top-level `-c` options, placed
  // with the other top-level flags before the `app-server` subcommand (the
  // position that is always valid for global options).
  if (endpointTx.args.length > 0) args.push(...endpointTx.args);
  args.push("app-server");
  if (config.extraArgs) args.push(...config.extraArgs);

  const proc = spawn(resolved.bin, args, {
    cwd,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });

  if (!proc.stdin || !proc.stdout || !proc.stderr) {
    throw new Error("Failed to open stdio on Codex process");
  }

  const session = new CodexSessionImpl(proc, ctx, cwd, config.model ?? null, instructions);

  // Perform JSON-RPC initialize handshake + thread/start
  await session.handshake();

  // Wire up AbortSignal
  if (ctx.signal) {
    if (ctx.signal.aborted) {
      void session.close();
    } else {
      ctx.signal.addEventListener("abort", () => void session.close(), { once: true });
    }
  }

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
export { codexGoalCapability } from "./goal-capability.js";

export class CodexSessionImpl implements AgentSession {
  private _state: SessionState = "idle";
  /**
   * The root thread represented by this AgentSession. Codex app-server also
   * reports child-agent threads on the same stdout connection, so this id is
   * pinned once discovered and must never be promoted to a child thread.
   */
  private _threadId: string | null = null;
  /** Thread id to resume (from ctx.sessionParams); null starts a fresh thread. */
  private readonly _resumeThreadId: string | null;
  /** Expected root during handshake, cleared when resume falls back to fresh. */
  private _expectedThreadId: string | null;
  private _lineBuffer = "";
  private _nextId = 1;

  // Pending outgoing RPC responses (keyed by request id)
  private _pendingRpc = new Map<number, {
    resolve: (result: Record<string, unknown>) => void;
    reject: (err: Error) => void;
  }>();

  // Pending result-resolvers. With concurrent send, multiple in-flight send()
  // Promises may share a single result event (when the CLI coalesces them
  // into one turn) or get distinct results across turns. On each
  // turn.completed / turn.failed we drain the entire list — every pending
  // Promise resolves with the same TurnResult.
  private _pendingResults: PendingResult[] = [];

  /** Result Promises for sends that haven't settled, tracked so `drain()` can
   *  await the in-flight turn(s) before closing. */
  private _inFlight = new Set<Promise<TurnResult>>();

  /** Set by `drain()`: new `send()` calls are refused while true. */
  private _draining = false;
  /** Shared promise so concurrent / repeated `drain()` calls coalesce. */
  private _drainPromise: Promise<void> | null = null;

  /**
   * Root turn targeted by `interrupt()`. The id is learned asynchronously from
   * the leader `turn/start` response or the root `turn/started` notification.
   * Concurrent sends reuse this latch so a queued response cannot replace the
   * actual active turn.
   */
  private _activeTurnId: string | null = null;
  private _activeTurnReady: ActiveTurnReady | null = null;
  /** Successful repeated interrupts coalesce until the terminal notification. */
  private _interruptPromise: Promise<void> | null = null;
  /** Prevents a late interrupt request after the terminal frame was observed. */
  private _turnTerminalObserved = false;

  /** Stamps `tool_result.toolName` by correlating with prior `tool_call`s. */
  private readonly _trackToolName = createToolNameTracker();

  // Per-turn accumulators. Cleared after each result delivery so a subsequent
  // turn's events don't inherit stale values.
  private _turnSummary: string | null = null;
  private _turnUsage: { inputTokens: number; outputTokens: number } | null = null;
  private _turnModel: string | null = null;
  private _turnIsError = false;
  private _turnWasInterrupted = false;
  private _turnErrorMessage: string | null = null;
  private _turnStartedAt: Date | null = null;

  /** Child-agent lifecycle is informational and never participates in root turn settlement. */
  private readonly _backgroundTasks = new Map<string, TrackedBackgroundTask>();
  private readonly _backgroundTaskIdsByPath = new Map<string, string>();

  /**
   * Serial dispatch chain for `onEvent`. Each dispatched event appends a
   * handler invocation; the chain enforces in-order delivery and lets
   * `send()` await all handlers for the turn before resolving. Approval
   * RPCs stay synchronous and are not gated on this chain.
   */
  private _eventChain: Promise<void> = Promise.resolve();

  /** Session-scoped goal engine (best-effort native thread goal + emulation). */
  private readonly _goals: GoalController;

  constructor(
    private readonly proc: ChildProcess,
    private readonly ctx: SessionContext,
    private readonly cwd: string,
    private readonly model: string | null,
    private readonly instructions: string | null,
  ) {
    this._resumeThreadId = readCodexResumeId(ctx.sessionParams);
    this._expectedThreadId = this._resumeThreadId;

    this._goals = new GoalController({
      providerType: "codex",
      capability: codexGoalCapability,
      getSessionId: () => this._threadId,
      send: (m) => this.send(m),
      dispatch: (event) => this.dispatchEvent(event),
      // Best-effort native arm. Goal mode is experimental + feature-gated
      // (`features.goals=true`); on builds without it the RPC errors and the
      // controller falls back to emulation. The method name is unconfirmed
      // (see spec §11) — we try the community spelling.
      armNative: async (objective) => {
        if (!this._threadId) return false;
        try {
          // Verified against codex 0.130.0 app-server: method + flat
          // `{threadId, objective}` params, gated on the `experimentalApi`
          // capability (declared in handshake) AND a build where the
          // `thread_goals` table exists (goals enabled in config.toml). When the
          // table is absent the RPC errors and the controller falls back to
          // emulation.
          await this.goalRpc("thread/goal/set", {
            threadId: this._threadId,
            objective,
          });
          return true;
        } catch {
          return false;
        }
      },
      clearNative: async () => {
        if (!this._threadId) return;
        await this.goalRpc("thread/goal/clear", { threadId: this._threadId }).catch(() => {});
      },
    });

    proc.stdout!.setEncoding("utf-8");
    proc.stdout!.on("data", (chunk: string) => this.handleStdout(chunk));

    proc.stderr!.setEncoding("utf-8");
    proc.stderr!.on("data", (chunk: string) => {
      if (this.ctx.onOutput) {
        try { void this.ctx.onOutput("stderr", chunk); } catch { /* swallow */ }
      }
    });

    proc.on("exit", (code, signal) => {
      if (this._state !== "closed") {
        this._state = "closed";
        const err = new Error(`Codex process exited unexpectedly (code=${code}, signal=${signal})`);
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

  /** Reject every pending send() Promise and outgoing JSON-RPC call. */
  private rejectAllPending(err: Error): void {
    const pending = this._pendingResults.splice(0);
    for (const p of pending) {
      if (p.settled) continue;
      p.settled = true;
      p.cleanup?.();
      p.reject(err);
    }
    for (const [, p] of this._pendingRpc) p.reject(err);
    this._pendingRpc.clear();
    this.clearActiveTurn(err);
  }

  get sessionId(): string | null { return this._threadId; }
  get state(): SessionState { return this._state; }

  /** Start the identity latch before writing the leader `turn/start` request. */
  private beginActiveTurn(): ActiveTurnReady {
    let resolveFn!: (turnId: string | null) => void;
    let rejectFn!: (err: Error) => void;
    const promise = new Promise<string | null>((resolve, reject) => {
      resolveFn = resolve;
      rejectFn = reject;
    });
    // A turn can finish without anyone calling interrupt(). Keep a later
    // process-exit rejection from becoming an unhandled promise rejection.
    void promise.catch(() => {});

    const ready: ActiveTurnReady = {
      promise,
      resolve: resolveFn,
      reject: rejectFn,
      settled: false,
    };
    this._activeTurnId = null;
    this._activeTurnReady = ready;
    this._interruptPromise = null;
    this._turnTerminalObserved = false;
    this._turnWasInterrupted = false;
    return ready;
  }

  /** First root turn id wins for the current latch. */
  private captureActiveTurnId(turnId: string, expected?: ActiveTurnReady): void {
    const ready = this._activeTurnReady;
    if (!turnId || !ready || ready.settled) return;
    if (expected && ready !== expected) return;
    this._activeTurnId = turnId;
    ready.settled = true;
    ready.resolve(turnId);
  }

  private rejectActiveTurnReady(err: Error, expected: ActiveTurnReady): void {
    if (this._activeTurnReady !== expected || expected.settled) return;
    expected.settled = true;
    expected.reject(err);
  }

  /** Clear the current turn and release an interrupt waiting for its id. */
  private clearActiveTurn(err?: Error): void {
    const ready = this._activeTurnReady;
    if (ready && !ready.settled) {
      ready.settled = true;
      if (err) ready.reject(err);
      else ready.resolve(null);
    }
    this._activeTurnId = null;
    this._activeTurnReady = null;
    this._interruptPromise = null;
    this._turnTerminalObserved = false;
  }

  /** Mark root turn termination and release an interrupt still awaiting its id. */
  private markTurnTerminalObserved(): void {
    this._turnTerminalObserved = true;
    const ready = this._activeTurnReady;
    if (ready && !ready.settled) {
      ready.settled = true;
      ready.resolve(null);
    }
  }

  /**
   * Durable identity for persistence + later `attachSession`. Null until Codex
   * has assigned a thread id; serializes `{sessionId, cwd}` through the codec so
   * it round-trips back into `thread/resume`.
   */
  describe(): SessionRecord | null {
    if (!this._threadId) return null;
    const params = codexSessionCodec.serialize({ sessionId: this._threadId, cwd: this.cwd });
    if (!params) return null;
    return createSessionRecord({
      providerType: "codex",
      params,
      cwd: this.cwd,
      displayId: codexSessionCodec.getDisplayId?.(params) ?? null,
    });
  }

  // -------------------------------------------------------------------------
  // JSON-RPC send helpers
  // -------------------------------------------------------------------------

  private rpcRequest(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>> {
    const id = this._nextId++;
    const msg: Record<string, unknown> = { jsonrpc: "2.0", id, method };
    if (params) msg["params"] = params;
    this.proc.stdin!.write(JSON.stringify(msg) + "\n");

    return new Promise((resolve, reject) => {
      this._pendingRpc.set(id, { resolve, reject });
    });
  }

  /**
   * Bounded RPC for experimental, best-effort methods (the `thread/goal/*`
   * family). An app-server build that doesn't recognize the method may never
   * reply; without this, `setGoal`/`clearGoal`/resume hydration would hang
   * forever. On timeout we reject (callers treat that as "unsupported" and fall
   * back to emulation / skip). A late reply still resolves the pending entry
   * harmlessly; a never-reply is cleaned up by rejectAllPending on close.
   */
  private goalRpc(method: string, params: Record<string, unknown>, timeoutMs = 5000): Promise<Record<string, unknown>> {
    return Promise.race([
      this.rpcRequest(method, params),
      new Promise<never>((_, reject) => {
        const t = setTimeout(() => reject(new Error(`codex ${method} timed out`)), timeoutMs);
        if (typeof t.unref === "function") t.unref();
      }),
    ]);
  }

  private rpcResponse(id: number, result: Record<string, unknown>): void {
    this.proc.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
  }

  // -------------------------------------------------------------------------
  // Handshake
  // -------------------------------------------------------------------------

  async handshake(): Promise<void> {
    // 1. initialize. Declare `experimentalApi` so the app-server exposes its
    // experimental method surface — notably `thread/goal/{set,get,clear}`, which
    // the server rejects with "requires experimentalApi capability" otherwise
    // (verified against codex 0.130.0 app-server). This is the same capability
    // the official VS Code client declares; it gates access to experimental RPC
    // methods, not turn semantics.
    await this.rpcRequest("initialize", {
      clientInfo: { name: "agentex", version: "1.0.0" },
      capabilities: { experimentalApi: true },
    });

    // 2. Resume an existing thread when the caller supplied sessionParams,
    //    otherwise start a fresh one. `thread/resume` continues the SAME thread
    //    with its full context retained — distinct from `thread/fork`, which is
    //    a divergent rewind copy. The thread keeps its original cwd/model, so we
    //    pass only the thread id (+ refreshed developer instructions).
    if (this._resumeThreadId) {
      const resumeParams: Record<string, unknown> = { threadId: this._resumeThreadId };
      if (this.instructions) resumeParams["developerInstructions"] = this.instructions;
      try {
        const res = await this.rpcRequest("thread/resume", resumeParams);
        const thread = asObj(res, "thread");
        // thread/resume may echo the thread back or return {}; fall back to the
        // id we resumed with so `sessionId` is always populated.
        this._threadId = str(thread, "id") || str(thread, "sessionId") || this._resumeThreadId;
        this._expectedThreadId = this._threadId;
        // Rehydrate a durable Codex goal so getGoal() reflects it immediately
        // (goals live in SQLite, not the transcript, so a resumed thread would
        // otherwise report null until the next goal notification).
        await this.hydrateGoalFromThread();
        return;
      } catch (err) {
        // A failed resume can emit thread/started before its error response.
        // Clear that provisional identity so the fresh thread's init event is
        // accepted instead of being mistaken for a foreign child thread.
        if (this._threadId === this._expectedThreadId) this._threadId = null;
        this._expectedThreadId = null;
        // The thread is unknown to this codex install (different machine, pruned
        // history). Don't fail the whole session — fall back to a fresh thread
        // and surface the downgrade on stderr. The new id flows back out via
        // the next sessionParams snapshot so callers see the session changed.
        if (this.ctx.onOutput) {
          const reason = err instanceof Error ? err.message : String(err);
          try {
            void this.ctx.onOutput(
              "stderr",
              `agentex: codex thread/resume failed for ${this._resumeThreadId}, starting a fresh thread: ${reason}\n`,
            );
          } catch { /* swallow */ }
        }
      }
    }

    // thread/start (fresh)
    const threadParams: Record<string, unknown> = { cwd: this.cwd };
    if (this.model) threadParams["model"] = this.model;
    if (this.instructions) threadParams["developerInstructions"] = this.instructions;

    // Apply a chosen collaboration mode (config.modeId) by resolving it against
    // the live mode list. Only on fresh threads — a resumed thread keeps the
    // mode it was created with. Mode discovery is advisory: a failure or an
    // unknown id just falls through to the default mode.
    const modeId = this.ctx.config?.modeId;
    if (modeId) {
      try {
        // Bound the discovery RPC: an older app-server that ignores
        // `collaborationMode/list` would otherwise hang the whole handshake.
        const modesResponse = await Promise.race([
          this.rpcRequest("collaborationMode/list", {}),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("collaborationMode/list timed out")), 10_000),
          ),
        ]);
        const collaborationMode = resolveCollaborationModeParam(
          parseCollaborationModes(modesResponse),
          modeId,
        );
        if (collaborationMode) {
          // Avoid sending instructions twice: the caller's top-level
          // `developerInstructions` wins, so drop the mode's copy.
          if (this.instructions) delete collaborationMode.settings["developer_instructions"];
          threadParams["collaborationMode"] = collaborationMode;
        }
      } catch { /* modes are advisory — ignore discovery failures */ }
    }

    const res = await this.rpcRequest("thread/start", threadParams);
    // codex-cli 0.130.0+ shape: { thread: { id, sessionId, ... }, model, ... }
    const thread = asObj(res, "thread");
    this._threadId = str(thread, "id") || str(thread, "sessionId") || null;
    this._expectedThreadId = this._threadId;
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  async send(message: string, options?: SendOptions): Promise<SendHandle> {
    if (this._state === "closed") throw new Error("Session is closed");
    if (this._draining) throw new Error("Session is draining — no new sends accepted");

    // No protocol-level guard — Codex's TUI demonstrates queueing of user
    // messages during an active turn, and our wire test (transcript
    // 019e33c3) confirms two `user_message` events recorded across a
    // long-running turn. We bet on the JSON-RPC layer queueing similarly
    // and pass through. If the second `turn/start` lands during the first
    // turn, the per-turn accumulators continue collecting until the result
    // event fires; the result then drains all pending resolvers.
    const existingTurnReady = this._activeTurnReady;
    const isTurnLeader = existingTurnReady === null;
    const turnReady = existingTurnReady ?? this.beginActiveTurn();

    if (this._state === "idle") {
      this._state = "thinking";
      this._turnStartedAt = new Date();
    }

    // UUID is for API parity with Claude — Codex's JSON-RPC doesn't carry it
    // through the wire protocol, so cancel(uuid) is a no-op for Codex.
    const uuid = randomUUID();

    // Start a turn — the completion comes via notifications, not the RPC response.
    // codex-cli 0.130.0+ expects `input` as a content-block array, not a plain
    // string. The MCP-style shape: [{type:"text", text:"..."}].
    const turnParams: Record<string, unknown> = {
      input: [{ type: "text", text: message }],
    };
    if (this._threadId) turnParams["threadId"] = this._threadId;
    // Codex app-server accepts model and reasoning effort as turn/start
    // overrides. Selected values become defaults for later turns on the same
    // thread, so forwarding the session config here works for fresh and
    // resumed sessions without mutating the user's global config.toml.
    if (this.model) turnParams["model"] = this.model;
    if (this.ctx.config?.effort) turnParams["effort"] = this.ctx.config.effort;

    let resolveFn!: (r: TurnResult) => void;
    let rejectFn!: (e: Error) => void;
    const result = new Promise<TurnResult>((resolve, reject) => {
      resolveFn = resolve;
      rejectFn = reject;
    });

    const entry: PendingResult = { resolve: resolveFn, reject: rejectFn };
    this._pendingResults.push(entry);

    // Track the in-flight turn so drain() can await it; drop it on settle.
    this._inFlight.add(result);
    void result.catch(() => {}).finally(() => this._inFlight.delete(result));

    // Per-send timeout / abort, falling back to the session-level
    // ProviderConfig.timeoutSec default when no per-call timeout is given.
    this.armSendDeadline(entry, options);

    const turnStart = this.rpcRequest("turn/start", turnParams);
    if (isTurnLeader) {
      void turnStart.then((response) => {
        const turnId = str(asObj(response, "turn"), "id");
        if (turnId) {
          this.captureActiveTurnId(turnId, turnReady);
        }
        // Some app-server versions may omit the id from the response and send
        // it only in turn/started. Keep the latch open for that notification.
      }).catch((err: unknown) => {
        this.rejectActiveTurnReady(
          err instanceof Error ? err : new Error(String(err)),
          turnReady,
        );
        // Turn-level failures may also arrive via turn/failed notifications.
      });
    } else {
      void turnStart.catch(() => {
        // Turn-level failures arrive via turn/failed notifications.
      });
    }

    return { uuid, result };
  }

  /**
   * Wire up this send's timeout and/or abort signal. On fire, the active turn
   * is interrupted (`turn/interrupt`) and the send settles with `timeout` /
   * `aborted`. No-op when neither a timeout nor a signal applies.
   */
  private armSendDeadline(entry: PendingResult, options?: SendOptions): void {
    const timeoutSec = options?.timeoutSec ?? this.ctx.config?.timeoutSec;
    const signal = options?.signal;
    const hasTimeout = typeof timeoutSec === "number" && timeoutSec > 0;
    if (!hasTimeout && !signal) return;

    if (signal?.aborted) {
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
   * Settle a still-pending send early (timeout or abort). Cancels the active
   * turn best-effort and resolves the send's `result` with a synthetic
   * TurnResult. A no-op if the entry already settled (the real result raced
   * ahead). The late real turn-completion later finds the entry already gone.
   */
  private settleEarly(entry: PendingResult, kind: "timeout" | "aborted"): void {
    if (entry.settled) return;
    entry.settled = true;
    entry.cleanup?.();

    const idx = this._pendingResults.indexOf(entry);
    if (idx >= 0) this._pendingResults.splice(idx, 1);

    // Best-effort cancel of the active turn. With concurrent sends this ends
    // the single shared turn for all of them — see SendOptions JSDoc.
    void this.interrupt().catch(() => {});

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

  async cancel(_uuid: string): Promise<CancelResult> {
    // Codex's JSON-RPC protocol exposes no per-message cancel — only
    // turn-wide `turn/interrupt` (which is what `interrupt()` calls).
    // capabilities.cancelQueuedMessage is false; this is a documented no-op.
    return { cancelled: false };
  }

  async stopTask(_taskId: string): Promise<StopTaskResult> {
    // Codex has no per-task stop control; capabilities.stopTask is false.
    return { stopped: false };
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

  /**
   * Best-effort: read the durable thread goal (`thread/goal/get`) and hydrate the
   * controller so a resumed session reports it. Silently skips when goals are
   * disabled, the table is absent, or there's no active goal.
   */
  private async hydrateGoalFromThread(): Promise<void> {
    if (!this._threadId) return;
    try {
      const res = await this.goalRpc("thread/goal/get", { threadId: this._threadId });
      const goal = asObj(res, "goal");
      if (Object.keys(goal).length === 0) return;
      const fields = normalizeCodexGoalRecord(goal, "model");
      if (!fields || isTerminalGoalStatus(fields.status)) return;
      const state: GoalState = {
        objective: fields.objective,
        status: fields.status,
        met: fields.met,
        enforced: fields.enforced,
        source: fields.source,
        updatedAt: new Date().toISOString(),
      };
      if (fields.tokensUsed !== undefined) state.tokensUsed = fields.tokensUsed;
      if (fields.timeUsedSeconds !== undefined) state.timeUsedSeconds = fields.timeUsedSeconds;
      if (fields.tokenBudget !== undefined) state.tokenBudget = fields.tokenBudget;
      this._goals.hydrate(state);
    } catch {
      /* goals off / unsupported / no goal — leave getGoal() null */
    }
  }

  async interrupt(): Promise<void> {
    if (this._state === "closed") return;
    const ready = this._activeTurnReady;
    if (!ready || this._turnTerminalObserved) return;
    if (this._interruptPromise) return this._interruptPromise;

    const threadId = this._threadId;
    if (!threadId) {
      throw new Error("Cannot interrupt Codex turn before the root thread id is known");
    }
    this._goals.notifyInterrupted(); // don't let an emulated goal auto-continue

    const interruptPromise = (async () => {
      const turnId = this._activeTurnId ?? await ready.promise;
      // The turn may have completed while interrupt() was waiting for the
      // leader turn/start response. In that race, completion is the success.
      if (!turnId || this._activeTurnReady !== ready || this._turnTerminalObserved) return;
      await this.rpcRequest("turn/interrupt", { threadId, turnId });
    })();
    this._interruptPromise = interruptPromise;

    try {
      await interruptPromise;
    } catch (err) {
      // A rejected control request must reach the host instead of becoming a
      // false successful Stop. Clear only this turn's failed attempt so a
      // subsequent click can retry.
      if (this._activeTurnReady === ready && this._interruptPromise === interruptPromise) {
        this._interruptPromise = null;
      }
      throw err;
    }
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
      await this.close();
    })();
    return this._drainPromise;
  }

  async close(): Promise<void> {
    if (this._state === "closed") return;
    this._state = "closed";
    this.rejectAllPending(new Error("Codex session closed"));

    this.proc.stdin!.end();

    // Grace window before SIGKILL is configurable via ProviderConfig.graceSec
    // for sessions running long tools.
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
  }

  // -------------------------------------------------------------------------
  // Stdout parsing
  // -------------------------------------------------------------------------

  private handleStdout(chunk: string): void {
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
    const raw = parseJson(line);
    if (!raw) return;
    const msg = classifyMessage(raw);
    if (!msg) return;

    switch (msg.kind) {
      case "response":
        this.handleRpcResponse(msg);
        break;
      case "request":
        this.handleServerRequest(msg.id, msg.method, msg.params);
        break;
      case "notification":
        this.handleNotification(msg.method, msg.params, line);
        break;
      case "legacy_event":
        this.handleLegacyEvent(msg.event, line);
        break;
    }
  }

  // -------------------------------------------------------------------------
  // RPC response dispatch
  // -------------------------------------------------------------------------

  private handleRpcResponse(msg: { id: number; result?: Record<string, unknown>; error?: { code: number; message: string } }): void {
    const pending = this._pendingRpc.get(msg.id);
    if (!pending) return;
    this._pendingRpc.delete(msg.id);

    if (msg.error) {
      pending.reject(new Error(`JSON-RPC error ${msg.error.code}: ${msg.error.message}`));
    } else {
      pending.resolve(msg.result ?? {});
    }
  }

  // -------------------------------------------------------------------------
  // Server→client requests (tool approval)
  // -------------------------------------------------------------------------

  private handleServerRequest(id: number, method: string, params: Record<string, unknown>): void {
    if (
      method === "item/commandExecution/requestApproval" ||
      method === "item/fileChange/requestApproval"
    ) {
      void this.handleApproval(id, method, params);
    } else if (
      method === "item/tool/requestUserInput" ||
      method === "tool/requestUserInput"
    ) {
      // `tool/requestUserInput` is the legacy method name on older codex builds.
      void this.handleUserInputRequest(id, params);
    } else {
      // Unknown server request — ack to unblock the turn.
      this.rpcResponse(id, {});
    }
  }

  /**
   * Leave a waiting-for-input/approval state correctly. A slow host handler can
   * resolve after the turn already ended (deliverTurnResult → idle), so restore
   * to `thinking` only when a turn is still in flight, else `idle` — never clobber
   * a finished turn back to `thinking`.
   */
  private restoreStateAfter(waitingState: "waiting_for_approval" | "waiting_for_input"): void {
    if (this._state !== waitingState) return;
    this._state = this._pendingResults.length > 0 ? "thinking" : "idle";
  }

  private async handleApproval(id: number, method: string, params: Record<string, unknown>): Promise<void> {
    this._state = "waiting_for_approval";

    // Codex's app-server expects `{ decision: "accept" | "decline" | "cancel" }`
    // (NOT `{ approved: boolean }`). agentex's UserInputResponse has no interrupt
    // concept, so allow → accept and deny → decline.
    if (!this.ctx.onUserInputRequest) {
      this.rpcResponse(id, { decision: "accept" });
      this.restoreStateAfter("waiting_for_approval");
      return;
    }

    const toolName = method === "item/commandExecution/requestApproval"
      ? "command_execution"
      : "file_change";

    try {
      const resp = await this.ctx.onUserInputRequest({
        toolName,
        input: params,
        toolUseId: str(params, "id"),
        description: str(params, "command") || str(params, "path") || undefined,
      });
      this.rpcResponse(id, { decision: resp.allow ? "accept" : "decline" });
    } catch {
      this.rpcResponse(id, { decision: "decline" });
    }

    this.restoreStateAfter("waiting_for_approval");
  }

  /**
   * Handle a Codex `requestUserInput` server→client request: the agent is asking
   * the user one or more structured questions. Maps onto the cross-provider
   * AskUserQuestion shape so callers reuse `parseAskUserQuestion`, then answers
   * back in Codex's `{ answers: { [questionId]: { answers: string[] } } }` shape.
   */
  private async handleUserInputRequest(id: number, params: Record<string, unknown>): Promise<void> {
    // Questions are user *input*, not a tool-permission gate — distinct state so a
    // host UI can render a question form vs an approval prompt.
    this._state = "waiting_for_input";

    const questions = parseCodexQuestions(params);

    // No host handler, or nothing answerable → return empty answers so the
    // agent proceeds without hanging.
    if (!this.ctx.onUserInputRequest || questions.length === 0) {
      this.rpcResponse(id, { answers: {} });
      this.restoreStateAfter("waiting_for_input");
      return;
    }

    try {
      const resp = await this.ctx.onUserInputRequest({
        toolName: "AskUserQuestion",
        input: { questions },
        toolUseId: str(params, "id") || "codex-user-input",
      });
      this.rpcResponse(id, { answers: buildCodexUserInputAnswers(questions, resp) });
    } catch {
      this.rpcResponse(id, { answers: {} });
    }

    this.restoreStateAfter("waiting_for_input");
  }

  // -------------------------------------------------------------------------
  // Notification handling (v2 format)
  // -------------------------------------------------------------------------

  /** Extract the thread scope carried by a v2 app-server notification. */
  private notificationThreadId(params: Record<string, unknown>): string | null {
    const thread = asObj(params, "thread");
    return str(params, "threadId") || str(thread, "id") || str(thread, "sessionId") || null;
  }

  /**
   * Whether an explicitly-scoped event belongs to another app-server thread.
   * `_expectedThreadId` protects the resume handshake window before `_threadId`
   * has been populated and is cleared if resume falls back to a fresh thread.
   * Unscoped global notifications remain eligible.
   */
  private isForeignThread(threadId: string | null): boolean {
    const rootThreadId = this._threadId ?? this._expectedThreadId;
    return !!threadId && !!rootThreadId && threadId !== rootThreadId;
  }

  private backgroundTaskParentIdForPath(agentPath: string | null): string | null {
    if (!agentPath) return null;
    const separator = agentPath.lastIndexOf("/");
    if (separator <= 0) return null;
    return this._backgroundTaskIdsByPath.get(agentPath.slice(0, separator)) ?? null;
  }

  private agentMessageText(item: Record<string, unknown>): string | null {
    const direct = str(item, "text");
    if (direct) return direct;
    const content = Array.isArray(item["content"]) ? item["content"] : [];
    for (const entry of content) {
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
      const block = entry as Record<string, unknown>;
      const text = str(block, "text");
      if (text && (str(block, "type") === "output_text" || str(block, "type") === "text")) {
        return text;
      }
    }
    return null;
  }

  /**
   * Maintain just enough child metadata to turn a later foreign-thread
   * terminal notification into one provider-neutral task event. This reducer
   * is deliberately separate from every root turn accumulator.
   */
  private observeBackgroundTask(event: Extract<StreamEvent, { type: "background_task" }>): boolean {
    const previous = this._backgroundTasks.get(event.taskId);
    // Codex reports `subAgentActivity:interacted` after it forwards a child's
    // final answer to the parent. The authoritative child turn/completed can
    // arrive first, so suppress that late progress edge instead of resurrecting
    // a task that already reached a terminal state. A later child turn/started
    // explicitly reactivates the record below in handleForeignNotification.
    if (previous?.terminal) return false;

    const description = event.description ?? previous?.description ?? null;
    const summary = event.summary ?? previous?.summary ?? null;
    const parentTaskId = event.parentTaskId
      ?? previous?.parentTaskId
      ?? this.backgroundTaskParentIdForPath(description);

    event.description = description;
    event.summary = summary;
    event.parentTaskId = parentTaskId;

    this._backgroundTasks.set(event.taskId, {
      taskId: event.taskId,
      description,
      summary,
      parentTaskId,
      terminal: event.phase === "completed",
    });
    if (description) this._backgroundTaskIdsByPath.set(description, event.taskId);
    return true;
  }

  /**
   * A Codex app-server connection also publishes child thread notifications.
   * They are useful only as background-task metadata. They must never flow
   * through root state, summary, usage, or `resolveTurn()`.
   */
  private handleForeignNotification(
    method: string,
    params: Record<string, unknown>,
    rawLine: string,
    childThreadId: string,
  ): void {
    if (method === "thread/started") {
      const thread = asObj(params, "thread");
      const parentThreadId = str(thread, "parentThreadId") || str(thread, "parent_thread_id");
      const rootThreadId = this._threadId ?? this._expectedThreadId;
      const parentTask = this._backgroundTasks.get(parentThreadId);
      // App-server can publish child thread/started before the corresponding
      // root subAgentActivity item. Register only descendants of this session,
      // not unrelated foreign threads multiplexed by a future server version.
      if (parentThreadId !== rootThreadId && !parentTask) return;

      const source = asObj(thread, "source");
      const subAgent = Object.keys(asObj(source, "subAgent")).length > 0
        ? asObj(source, "subAgent")
        : asObj(source, "subagent");
      const spawnSource = Object.keys(asObj(subAgent, "threadSpawn")).length > 0
        ? asObj(subAgent, "threadSpawn")
        : asObj(subAgent, "thread_spawn");
      const description = str(spawnSource, "agentPath")
        || str(spawnSource, "agent_path")
        || str(thread, "name")
        || str(thread, "agentNickname")
        || str(thread, "agentRole")
        || null;

      this.dispatchEvent({
        type: "background_task",
        taskId: childThreadId,
        taskType: "subagent",
        phase: "started",
        status: "running",
        description,
        summary: null,
        parentTaskId: parentThreadId === rootThreadId ? null : parentThreadId,
        timestamp: new Date().toISOString(),
        providerType: "codex",
        sessionId: rootThreadId,
        messageId: null,
        eventId: rootThreadId
          ? `codex:${rootThreadId}:background-task:${childThreadId}:started`
          : null,
        turnId: null,
        parentToolCallId: null,
        raw: parseJson(rawLine) ?? params,
      });
      return;
    }

    const task = this._backgroundTasks.get(childThreadId);
    if (!task) return;

    if (method === "turn/started") {
      if (!task.terminal) return;
      task.terminal = false;
      task.summary = null;
      const turn = asObj(params, "turn");
      const turnId = str(turn, "id") || str(params, "turnId") || null;
      const rootThreadId = this._threadId ?? this._expectedThreadId;
      this.dispatchEvent({
        type: "background_task",
        taskId: childThreadId,
        taskType: "subagent",
        phase: "progress",
        status: "running",
        description: task.description,
        summary: null,
        parentTaskId: task.parentTaskId,
        timestamp: new Date().toISOString(),
        providerType: "codex",
        sessionId: rootThreadId,
        messageId: null,
        eventId: rootThreadId && turnId
          ? `codex:${rootThreadId}:background-task:${childThreadId}:${turnId}:progress`
          : null,
        turnId,
        parentToolCallId: null,
        raw: parseJson(rawLine) ?? params,
      });
      return;
    }

    if (method === "item/completed") {
      const item = asObj(params, "item");
      const itemType = str(item, "type");
      if ((itemType === "agentMessage" || itemType === "agent_message") && str(item, "phase") !== "commentary") {
        const summary = this.agentMessageText(item);
        if (summary) task.summary = summary;
      }
      return;
    }

    if (method !== "turn/completed" && method !== "turn/failed") return;

    const turn = asObj(params, "turn");
    const turnId = str(turn, "id") || str(params, "turnId") || null;
    const nativeStatus = method === "turn/failed" ? "failed" : str(turn, "status");
    const status = nativeStatus === "failed"
      ? "failed"
      : nativeStatus === "interrupted" || nativeStatus === "cancelled"
        ? "stopped"
        : "completed";
    const errorMessage = str(asObj(turn, "error"), "message")
      || str(params, "message")
      || str(params, "error");
    const rootThreadId = this._threadId ?? this._expectedThreadId;

    this.dispatchEvent({
      type: "background_task",
      taskId: childThreadId,
      taskType: "subagent",
      phase: "completed",
      status,
      description: task.description,
      summary: task.summary ?? (errorMessage || null),
      parentTaskId: task.parentTaskId,
      timestamp: new Date().toISOString(),
      providerType: "codex",
      sessionId: rootThreadId,
      messageId: null,
      eventId: rootThreadId && turnId
        ? `codex:${rootThreadId}:background-task:${childThreadId}:${turnId}:completed`
        : null,
      turnId,
      parentToolCallId: null,
      raw: parseJson(rawLine) ?? params,
    });
  }

  private handleNotification(method: string, params: Record<string, unknown>, rawLine: string): void {
    // codex/event — legacy wrapper
    if (method === "codex/event") {
      const innerMsg = str(params, "msg");
      if (innerMsg) {
        // Try to parse inner message
        const inner = parseJson(innerMsg);
        if (inner) this.handleLegacyEvent(inner, innerMsg);
      }
      return;
    }

    // One Codex app-server connection multiplexes notifications for the root
    // thread and any child agents it spawns. An AgentSession represents only
    // its root thread, so foreign items must not change root state/summary and,
    // most importantly, a child turn/completed must not resolve the root send.
    const notificationThreadId = this.notificationThreadId(params);
    if (this.isForeignThread(notificationThreadId)) {
      this.handleForeignNotification(method, params, rawLine, notificationThreadId!);
      return;
    }

    // Map v2 notification methods to processing
    if (method === "thread/started") {
      // codex-cli 0.130.0+ shape: { thread: { id, sessionId, ... } }
      if (!this._threadId) this._threadId = notificationThreadId;
      this.emitStreamEvent(rawLine);
      return;
    }

    if (method === "turn/started") {
      this.captureActiveTurnId(str(asObj(params, "turn"), "id") || str(params, "turnId"));
      // The parser intentionally suppresses this lifecycle-only event.
      this.emitStreamEvent(rawLine);
      return;
    }

    if (method === "item/started") {
      this._state = "tool_executing";
      this.emitStreamEvent(rawLine);
      return;
    }

    if (method === "item/completed") {
      this._state = "thinking";
      this.extractSummaryFromItem(params);
      this.emitStreamEvent(rawLine);
      return;
    }

    if (method === "turn/completed") {
      this.handleTurnCompleted(params);
      return;
    }

    if (method === "turn/failed") {
      this.markTurnTerminalObserved();
      this._turnIsError = true;
      this._turnErrorMessage = str(params, "message") || str(params, "error") || "Turn failed";
      // Emit before resolve so the result event is queued onto _eventChain
      // before resolveTurn awaits it.
      this.emitStreamEvent(rawLine);
      this.resolveTurn();
      return;
    }

    if (method === "error") {
      // A request/turn error notification (e.g. a 4xx from the model API).
      // Capture the message so the trailing `turn/completed` (status "failed")
      // surfaces it. Don't resolve here: `willRetry: true` means the turn
      // continues, and either way `turn/completed` is the turn terminus.
      const msg = str(asObj(params, "error"), "message") || str(params, "message");
      if (msg) this._turnErrorMessage = msg;
      this.emitStreamEvent(rawLine);
      return;
    }

    // Forward unrecognized notifications
    this.emitStreamEvent(rawLine);
  }

  // -------------------------------------------------------------------------
  // Legacy event handling (NDJSON events with `type` field)
  // -------------------------------------------------------------------------

  private handleLegacyEvent(event: Record<string, unknown>, rawLine: string): void {
    const type = str(event, "type");
    const eventThreadId =
      str(event, "thread_id") || str(event, "threadId") || str(event, "session_id") || null;

    // Older NDJSON-shaped events can also carry explicit thread scope. Keep
    // the same root-only invariant when that scope is available.
    if (this.isForeignThread(eventThreadId)) return;

    if (type === "thread.started") {
      if (!this._threadId) this._threadId = eventThreadId;
      this.emitStreamEvent(rawLine);
      return;
    }

    if (type === "item.started") {
      this._state = "tool_executing";
      this.emitStreamEvent(rawLine);
      return;
    }

    if (type === "item.completed") {
      this._state = "thinking";
      this.extractSummaryFromItem(event);
      this.emitStreamEvent(rawLine);
      return;
    }

    if (type === "turn.completed") {
      this.handleTurnCompleted(event);
      return;
    }

    if (type === "turn.failed" || type === "error") {
      this.markTurnTerminalObserved();
      this._turnIsError = true;
      this._turnErrorMessage = str(event, "message") || str(event, "error") || "Turn failed";
      // Emit before resolve so the result event is queued onto _eventChain
      // before resolveTurn awaits it.
      this.emitStreamEvent(rawLine);
      this.resolveTurn();
      return;
    }

    this.emitStreamEvent(rawLine);
  }

  // -------------------------------------------------------------------------
  // Shared helpers
  // -------------------------------------------------------------------------

  private extractSummaryFromItem(params: Record<string, unknown>): void {
    const item = typeof params["item"] === "object" && params["item"] !== null
      ? (params["item"] as Record<string, unknown>)
      : params;

    // v2 app-server items are `agentMessage` (camelCase); legacy NDJSON is
    // `agent_message`. Accept both or v2 turns return a null TurnResult.summary.
    const itemType = str(item, "type");
    if (itemType !== "agent_message" && itemType !== "agentMessage") return;

    // Commentary is progress, not the terminal answer. Keep phase-absent
    // legacy events as a compatibility fallback, while known final_answer
    // items remain eligible for TurnResult.summary.
    if (str(item, "phase") === "commentary") return;

    // Direct text (Codex 0.30+)
    const directText = str(item, "text");
    if (directText) {
      this._turnSummary = directText;
      return;
    }

    // Fallback: content array
    const content = Array.isArray(item["content"]) ? item["content"] : [];
    for (const entry of content) {
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
      const block = entry as Record<string, unknown>;
      if (str(block, "type") === "output_text") {
        const text = str(block, "text");
        if (text) this._turnSummary = text;
      }
    }
  }

  private handleTurnCompleted(params: Record<string, unknown>): void {
    this.markTurnTerminalObserved();
    const usage = typeof params["usage"] === "object" && params["usage"] !== null
      ? (params["usage"] as Record<string, unknown>)
      : null;
    if (usage) {
      const inputTokens = num(usage, "input_tokens");
      const outputTokens = num(usage, "output_tokens");
      if (inputTokens > 0 || outputTokens > 0) {
        this._turnUsage = { inputTokens, outputTokens };
      }
    }
    const model = str(params, "model");
    if (model) this._turnModel = model;

    // codex 0.130 signals turn failure via `turn/completed` with
    // `turn.status: "failed"` (carrying `turn.error.message`), not always via a
    // separate `turn/failed`. Detect it so the TurnResult + result event report
    // the error instead of a false "completed".
    const turn = asObj(params, "turn");
    const turnStatus = str(turn, "status");
    if (turnStatus === "interrupted" || turnStatus === "cancelled") {
      this._turnWasInterrupted = true;
    } else if (turnStatus === "failed") {
      this._turnIsError = true;
      const msg = str(asObj(turn, "error"), "message");
      this._turnErrorMessage = msg || this._turnErrorMessage || `Turn ${turnStatus}`;
    }

    // Dispatch the synthesized result event BEFORE resolving the turn, so it
    // is queued onto _eventChain and resolveTurn → deliverTurnResult drains
    // it before the awaiting send() returns. We synthesize here (rather than
    // routing the raw turn/completed line through emitStreamEvent) because
    // parseCodexStreamLine yields `text: ""` for turn.completed — the
    // accumulated `_turnSummary` from item.completed events is the useful
    // payload to carry on the result event.
    this.dispatchEvent({
      type: "result",
      text: this._turnIsError ? (this._turnErrorMessage ?? this._turnSummary ?? "") : (this._turnSummary ?? ""),
      costUsd: null,
      isError: this._turnIsError,
      stopReason: null,
      terminalReason: turnStatus || null,
      numTurns: null,
      durationMs: null,
      timestamp: new Date().toISOString(),
      providerType: "codex",
      sessionId: this._threadId,
      messageId: null,
      eventId: null,
      turnId: null,
      parentToolCallId: null,
      raw: params,
    });

    this.resolveTurn();
  }

  private resolveTurn(): void {
    const resolvedModel = this._turnModel ?? this.model;
    let usage = this._turnUsage && resolvedModel
      ? { [resolvedModel]: { inputTokens: this._turnUsage.inputTokens, outputTokens: this._turnUsage.outputTokens } }
      : undefined;

    // Usage precedence: the `turn.completed` payload is authoritative when
    // present (captured above into _turnUsage). Only when the stream carried no
    // usage do we fall back to scanning Codex's on-disk session logs.
    //
    // RACINESS: the disk scan is best-effort and inherently racy — the rollout
    // file may still be flushing when we read it, so a fallback scan can miss the
    // latest turn or read partially-written totals. We therefore scan ONLY when
    // there is no in-band usage, and never let a scan failure fail the turn
    // (usage simply stays undefined). Prefer the in-band payload always.
    if (!usage && this._turnStartedAt) {
      const startedAt = this._turnStartedAt;
      const threadId = this._threadId ?? undefined;
      // Fire-and-forget: scan logs then deliver result
      void scanCodexSessionUsage({ startedAfter: startedAt, threadId }).then((scanned) => {
        usage = scanned;
      }).catch(() => {
        // Non-fatal — usage stays undefined
      }).finally(() => {
        void this.deliverTurnResult(usage);
      });
      return;
    }

    void this.deliverTurnResult(usage);
  }

  private async deliverTurnResult(usage: Record<string, import("../../types.js").TokenUsage> | undefined): Promise<void> {
    const result: TurnResult = {
      summary: this._turnSummary,
      usage,
      costUsd: null,
      status: this._turnWasInterrupted ? "aborted" : this._turnIsError ? "failed" : "completed",
      errorCode: this._turnWasInterrupted ? "aborted" : this._turnIsError ? "execution_error" : null,
      errorMessage: this._turnWasInterrupted ? "Turn was interrupted" : this._turnErrorMessage,
    };

    // Drain pending onEvent handlers so callers awaiting send() see a settled
    // DB / log / UI state by the time TurnResult resolves. The chain snapshot
    // here covers every event queued up to and including the result event;
    // later events extend the chain but aren't awaited.
    await this._eventChain;

    // The await above yields the event loop; the process may have exited
    // (or the session closed) during that window, in which case the exit
    // handler already rejected the turn and set state to "closed". Don't
    // overwrite that with "idle" — it would falsely advertise a usable
    // session whose stdin is dead.
    if (this._state === "closed") return;

    this._state = "idle";

    // Drain ALL pending send() resolvers with this turn's result. Multiple
    // concurrent sends coalesced into one turn share the same TurnResult.
    const pending = this._pendingResults.splice(0);

    // Clear per-turn accumulators so a subsequent turn doesn't inherit
    // stale summary / usage / model.
    this._turnSummary = null;
    this._turnUsage = null;
    this._turnModel = null;
    this._turnIsError = false;
    this._turnWasInterrupted = false;
    this._turnErrorMessage = null;
    this._turnStartedAt = null;
    this.clearActiveTurn();

    for (const p of pending) {
      // Skip sends already settled early by timeout / abort.
      if (p.settled) continue;
      p.settled = true;
      p.cleanup?.();
      p.resolve(result);
    }

    // Advance any emulated goal loop now that the turn has fully settled.
    void this._goals.onTurnSettled(result);
  }

  private emitStreamEvent(rawLine: string): void {
    // Parse when there's an onEvent subscriber OR an active goal to observe, so
    // native goal_status transitions update getGoal() even with no handler.
    if (!this.ctx.onEvent && !this._goals.isTracking()) return;
    // Pass current threadId so NDJSON-shaped events (via codex/event wrapper)
    // carry sessionId. v2 notifications parse threadId from params directly
    // and ignore this arg.
    const event = parseCodexStreamLine(rawLine, this._threadId);
    if (event) this.dispatchEvent(event);
  }

  /**
   * Queue an event for in-order delivery to `onEvent`. Each call appends a
   * `.then` to `_eventChain` so handler N+1 only starts after handler N's
   * returned promise settles. Errors are swallowed inside the chain so a
   * throwing handler does not break delivery of subsequent events.
   */
  private dispatchEvent(event: StreamEvent): void {
    if (event.type === "background_task" && !this.observeBackgroundTask(event)) return;
    // Track native goal_status transitions (keeps getGoal() accurate).
    this._goals.observe(event);
    const cb = this.ctx.onEvent;
    if (!cb) return;
    // Codex emits no native per-event uuid. Where the v2 components exist,
    // synthesize a documented, replay-stable identity so hosts get an
    // idempotency key for live captures:
    //   codex:<threadId>:<turnId>:<itemId>:<eventType>
    // This is an UPSERT key, not a uniqueness guarantee — repeated updates to
    // the same item (e.g. streaming text on one agent_message) intentionally
    // share an id; the last write wins. It also does NOT match the transcript
    // reader's `codex:<sessionId>:<offset>` scheme (different wire vocabulary
    // on disk) — cross-shape dedup remains a host concern.
    const eventThreadId = event.sessionId ?? this._threadId;
    if (!event.eventId && eventThreadId && event.turnId && event.messageId) {
      event.eventId = `codex:${eventThreadId}:${event.turnId}:${event.messageId}:${event.type}`;
    }
    // Enrich synchronously (in stream order) so tool_result events carry the
    // name of the tool_call they answer.
    const enriched = this._trackToolName(event);
    this._eventChain = this._eventChain.then(async () => {
      try { await cb(enriched); } catch { /* swallow */ }
    });
  }
}
