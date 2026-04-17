import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import type {
  AgentSession,
  SessionContext,
  SessionState,
  TurnResult,
} from "../../types.js";
import { findBinary } from "../../utils/binary.js";
import { buildEnv, ensurePathInEnv } from "../../utils/env.js";
import { injectWorkspaceSkills } from "../../utils/skills.js";
import { resolveInstructions } from "../../utils/instructions.js";
import { parseCodexStreamLine } from "./parse.js";
import { scanCodexSessionUsage } from "./usage-scanner.js";

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
  const isRpc = msg["jsonrpc"] === "2.0";

  if (isRpc) {
    const hasId = "id" in msg && (typeof msg["id"] === "number" || typeof msg["id"] === "string");
    const hasMethod = "method" in msg && typeof msg["method"] === "string";
    const id = typeof msg["id"] === "number" ? msg["id"] : parseInt(String(msg["id"]), 10);

    if (hasId && hasMethod) {
      return { kind: "request", id, method: msg["method"] as string, params: asObj(msg, "params") };
    }
    if (hasId && !hasMethod) {
      const errRaw = msg["error"];
      const error = typeof errRaw === "object" && errRaw !== null
        ? { code: num(errRaw as Record<string, unknown>, "code"), message: str(errRaw as Record<string, unknown>, "message") }
        : undefined;
      const result = typeof msg["result"] === "object" && msg["result"] !== null
        ? (msg["result"] as Record<string, unknown>)
        : undefined;
      return { kind: "response", id, result, error };
    }
    if (hasMethod) {
      return { kind: "notification", method: msg["method"] as string, params: asObj(msg, "params") };
    }
    return null;
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

  // Resolve instructions
  const instructions = await resolveInstructions(config.instructionsFile);

  // Spawn Codex in interactive JSON-RPC mode
  const args = [...resolved.prefixArgs, "--json"];
  if (config.skipPermissions) args.push("--dangerously-bypass-approvals-and-sandbox");
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

class CodexSessionImpl implements AgentSession {
  private _state: SessionState = "idle";
  private _threadId: string | null = null;
  private _lineBuffer = "";
  private _nextId = 1;

  // Pending outgoing RPC responses (keyed by request id)
  private _pendingRpc = new Map<number, {
    resolve: (result: Record<string, unknown>) => void;
    reject: (err: Error) => void;
  }>();

  // Active turn state
  private _turnResolve: ((result: TurnResult) => void) | null = null;
  private _turnReject: ((err: Error) => void) | null = null;
  private _turnSummary: string | null = null;
  private _turnUsage: { inputTokens: number; outputTokens: number } | null = null;
  private _turnModel: string | null = null;
  private _turnIsError = false;
  private _turnErrorMessage: string | null = null;
  private _turnStartedAt: Date | null = null;

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
        for (const [, pending] of this._pendingRpc) pending.reject(err);
        this._pendingRpc.clear();
        if (this._turnReject) {
          this._turnReject(err);
          this._turnResolve = null;
          this._turnReject = null;
        }
      }
    });

    proc.on("error", (err) => {
      if (this._state !== "closed") {
        this._state = "closed";
        for (const [, pending] of this._pendingRpc) pending.reject(err);
        this._pendingRpc.clear();
        if (this._turnReject) {
          this._turnReject(err);
          this._turnResolve = null;
          this._turnReject = null;
        }
      }
    });
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
    this._threadId = str(res, "threadId") || str(res, "thread_id") || null;
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  async send(message: string): Promise<TurnResult> {
    if (this._state === "closed") throw new Error("Session is closed");
    if (this._state !== "idle") throw new Error("A turn is already in progress");

    this._state = "thinking";
    this._turnSummary = null;
    this._turnUsage = null;
    this._turnModel = null;
    this._turnIsError = false;
    this._turnErrorMessage = null;
    this._turnStartedAt = new Date();

    // Start a turn — the completion comes via notifications, not the RPC response
    const turnParams: Record<string, unknown> = { input: message };
    if (this._threadId) turnParams["threadId"] = this._threadId;

    this.rpcRequest("turn/start", turnParams).catch(() => {
      // Turn-level errors arrive via turn.failed notifications
    });

    return new Promise<TurnResult>((resolve, reject) => {
      this._turnResolve = resolve;
      this._turnReject = reject;
    });
  }

  async interrupt(): Promise<void> {
    if (this._state === "idle" || this._state === "closed") return;
    try {
      await this.rpcRequest("turn/cancel", {});
    } catch { /* best effort */ }
  }

  async close(): Promise<void> {
    if (this._state === "closed") return;
    this._state = "closed";

    this.proc.stdin!.end();

    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        this.proc.kill("SIGKILL");
        resolve();
      }, 5000);

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
      this._threadId = str(params, "threadId") || str(params, "thread_id") || this._threadId;
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
      this.resolveTurn();
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
      this.resolveTurn();
      this.emitStreamEvent(rawLine);
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

    this.resolveTurn();
    // Also emit as stream event for the raw line
    if (this.ctx.onEvent) {
      try {
        void this.ctx.onEvent({
          type: "result",
          text: this._turnSummary ?? "",
          cost: null,
          isError: this._turnIsError,
          timestamp: new Date().toISOString(),
        });
      } catch { /* swallow */ }
    }
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
        this.deliverTurnResult(usage);
      });
      return;
    }

    this.deliverTurnResult(usage);
  }

  private deliverTurnResult(usage: Record<string, import("../../types.js").TokenUsage> | undefined): void {
    const result: TurnResult = {
      summary: this._turnSummary,
      usage,
      costUsd: null,
      status: this._turnIsError ? "failed" : "completed",
      errorCode: this._turnIsError ? "execution_error" : null,
      errorMessage: this._turnErrorMessage,
    };

    this._state = "idle";
    if (this._turnResolve) {
      const resolve = this._turnResolve;
      this._turnResolve = null;
      this._turnReject = null;
      resolve(result);
    }
  }

  private emitStreamEvent(rawLine: string): void {
    if (!this.ctx.onEvent) return;
    const event = parseCodexStreamLine(rawLine);
    if (event) {
      try { void this.ctx.onEvent(event); } catch { /* swallow */ }
    }
  }
}
