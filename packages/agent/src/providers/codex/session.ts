import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import type {
  AgentSession,
  CancelResult,
  SendHandle,
  SendOptions,
  SessionContext,
  SessionState,
  StreamEvent,
  TurnResult,
} from "../../types.js";
import { findBinary } from "../../utils/binary.js";
import { buildEnv, ensurePathInEnv } from "../../utils/env.js";
import { injectWorkspaceSkills } from "../../utils/skills.js";
import { resolveInstructions } from "../../utils/instructions.js";
import { createToolNameTracker } from "../../utils/tool-names.js";
import { parseCodexStreamLine } from "./parse.js";
import { withPlanModePreamble } from "./plan-mode.js";
import { scanCodexSessionUsage } from "./usage-scanner.js";

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

/** @internal Exported for unit testing — not part of the public API. */
export class CodexSessionImpl implements AgentSession {
  private _state: SessionState = "idle";
  private _threadId: string | null = null;
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

  constructor(
    private readonly proc: ChildProcess,
    private readonly ctx: SessionContext,
    private readonly cwd: string,
    private readonly model: string | null,
    private readonly instructions: string | null,
  ) {
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

  private rpcResponse(id: number, result: Record<string, unknown>): void {
    this.proc.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
  }

  // -------------------------------------------------------------------------
  // Handshake
  // -------------------------------------------------------------------------

  async handshake(): Promise<void> {
    // 1. initialize
    await this.rpcRequest("initialize", {
      clientInfo: { name: "agentex", version: "1.0.0" },
      capabilities: {},
    });

    // 2. thread/start
    const threadParams: Record<string, unknown> = { cwd: this.cwd };
    if (this.model) threadParams["model"] = this.model;
    if (this.instructions) threadParams["developerInstructions"] = this.instructions;

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

  async interrupt(): Promise<void> {
    if (this._state === "idle" || this._state === "closed") return;
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
    } else {
      // Unknown server request — ack to unblock
      this.rpcResponse(id, {});
    }
  }

  private async handleApproval(id: number, method: string, params: Record<string, unknown>): Promise<void> {
    this._state = "waiting_for_approval";

    if (!this.ctx.onUserInputRequest) {
      this.rpcResponse(id, { approved: true });
      if (this._state === "waiting_for_approval") this._state = "thinking";
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
      this.rpcResponse(id, { approved: resp.allow });
    } catch {
      this.rpcResponse(id, { approved: false });
    }

    if (this._state === "waiting_for_approval") this._state = "thinking";
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

    if (str(item, "type") !== "agent_message") return;

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

    // Dispatch the synthesized result event BEFORE resolving the turn, so it
    // is queued onto _eventChain and resolveTurn → deliverTurnResult drains
    // it before the awaiting send() returns. We synthesize here (rather than
    // routing the raw turn/completed line through emitStreamEvent) because
    // parseCodexStreamLine yields `text: ""` for turn.completed — the
    // accumulated `_turnSummary` from item.completed events is the useful
    // payload to carry on the result event.
    this.dispatchEvent({
      type: "result",
      text: this._turnSummary ?? "",
      costUsd: null,
      isError: this._turnIsError,
      stopReason: null,
      terminalReason: null,
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

    // If no usage from the stream, try scanning session logs
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
  }

  private emitStreamEvent(rawLine: string): void {
    if (!this.ctx.onEvent) return;
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
    const cb = this.ctx.onEvent;
    if (!cb) return;
    // Enrich synchronously (in stream order) so tool_result events carry the
    // name of the tool_call they answer.
    const enriched = this._trackToolName(event);
    this._eventChain = this._eventChain.then(async () => {
      try { await cb(enriched); } catch { /* swallow */ }
    });
  }
}
