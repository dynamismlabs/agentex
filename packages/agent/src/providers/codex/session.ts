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
  private _threadId: string | null = null;
  /** Thread id to resume (from ctx.sessionParams); null starts a fresh thread. */
  private readonly _resumeThreadId: string | null;
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

  /** Stamps `tool_result.toolName` by correlating with prior `tool_call`s. */
  private readonly _trackToolName = createToolNameTracker();

  // Per-turn accumulators. Cleared after each result delivery so a subsequent
  // turn's events don't inherit stale values.
  private _turnSummary: string | null = null;
  private _turnUsage: { inputTokens: number; outputTokens: number } | null = null;
  private _turnModel: string | null = null;
  private _turnIsError = false;
  private _turnErrorMessage: string | null = null;
  private _turnStartedAt: Date | null = null;

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
  }

  get sessionId(): string | null { return this._threadId; }
  get state(): SessionState { return this._state; }

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
        // Rehydrate a durable Codex goal so getGoal() reflects it immediately
        // (goals live in SQLite, not the transcript, so a resumed thread would
        // otherwise report null until the next goal notification).
        await this.hydrateGoalFromThread();
        return;
      } catch (err) {
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

    this.rpcRequest("turn/start", turnParams).catch(() => {
      // Turn-level errors arrive via turn.failed notifications.
    });

    return { uuid, result };
  }

  /**
   * Wire up this send's timeout and/or abort signal. On fire, the active turn
   * is cancelled (`turn/cancel`) and the send settles with `timeout` /
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

  async cancel(_uuid: string): Promise<CancelResult> {
    // Codex's JSON-RPC protocol exposes no per-message cancel — only
    // turn-wide `turn/cancel` (which is what `interrupt()` calls).
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
    if (this._state === "idle" || this._state === "closed") return;
    this._goals.notifyInterrupted(); // don't let an emulated goal auto-continue
    try {
      await this.rpcRequest("turn/cancel", {});
    } catch { /* best effort */ }
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

    // Map v2 notification methods to processing
    if (method === "thread/started") {
      // codex-cli 0.130.0+ shape: { thread: { id, sessionId, ... } }
      const thread = asObj(params, "thread");
      this._threadId = str(thread, "id") || str(thread, "sessionId") || this._threadId;
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

    if (type === "thread.started") {
      this._threadId = str(event, "thread_id") || this._threadId;
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
    if (turnStatus === "failed" || turnStatus === "cancelled") {
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
      status: this._turnIsError ? "failed" : "completed",
      errorCode: this._turnIsError ? "execution_error" : null,
      errorMessage: this._turnErrorMessage,
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
    this._turnErrorMessage = null;
    this._turnStartedAt = null;

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
    if (!event.eventId && this._threadId && event.turnId && event.messageId) {
      event.eventId = `codex:${this._threadId}:${event.turnId}:${event.messageId}:${event.type}`;
    }
    // Enrich synchronously (in stream order) so tool_result events carry the
    // name of the tool_call they answer.
    const enriched = this._trackToolName(event);
    this._eventChain = this._eventChain.then(async () => {
      try { await cb(enriched); } catch { /* swallow */ }
    });
  }
}
