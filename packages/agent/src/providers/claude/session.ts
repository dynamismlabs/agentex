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
  UserInputResponse,
} from "../../types.js";
import { findBinary } from "../../utils/binary.js";
import { buildEnv, ensurePathInEnv } from "../../utils/env.js";
import { buildSkillsDir, cleanupSkillsDir } from "../../utils/skills.js";
import { createToolNameTracker } from "../../utils/tool-names.js";
import { parseStreamLine, classifyClaudeAuthFromResult, CLAUDE_LOGIN_COMMAND } from "./parse.js";

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

  // Build skills dir (if any)
  let skillsDir: string | null = null;
  if (config.skillDirs && config.skillDirs.length > 0) {
    try {
      skillsDir = await buildSkillsDir(config.skillDirs, "claude");
    } catch { /* non-fatal */ }
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
  if (sessionParams) {
    const id = (sessionParams["sessionId"] as string) ?? (sessionParams["session_id"] as string);
    if (id && typeof id === "string") {
      args.push("--resume", id);
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
  if (config.effort) args.push("--effort", config.effort);
  if (config.maxTurns && config.maxTurns > 0) args.push("--max-turns", String(config.maxTurns));
  if (config.instructionsFile) args.push("--append-system-prompt-file", config.instructionsFile);
  if (skillsDir) args.push("--add-dir", skillsDir);
  if (config.mcpServers) {
    for (const mcp of config.mcpServers) {
      args.push("--mcp-server", mcp.name, "--", mcp.command, ...(mcp.args ?? []));
    }
  }
  if (config.extraArgs) args.push(...config.extraArgs);

  // Spawn persistent process
  const proc: ChildProcess = spawn(resolved.bin, args, {
    cwd,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });

  if (!proc.stdin || !proc.stdout || !proc.stderr) {
    throw new Error("Failed to open stdio on Claude process");
  }

  const session = new ClaudeSessionImpl(proc, ctx, skillsDir);

  // Wire up AbortSignal to close the session
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
export class ClaudeSessionImpl implements AgentSession {
  private _state: SessionState = "idle";
  private _sessionId: string | null = null;
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

  constructor(
    private readonly proc: ChildProcess,
    private readonly ctx: SessionContext,
    private readonly skillsDir: string | null,
  ) {
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

  /** Reject every pending send() Promise and outgoing control_response. */
  private rejectAllPending(err: Error): void {
    const pending = this._pendingResults.splice(0);
    for (const p of pending) {
      if (p.settled) continue;
      p.settled = true;
      p.cleanup?.();
      p.reject(err);
    }
    for (const [, p] of this._pendingControlResponses) p.reject(err);
    this._pendingControlResponses.clear();
  }

  get sessionId(): string | null { return this._sessionId; }
  get state(): SessionState { return this._state; }

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

    const entry: PendingResult = { resolve: resolveFn, reject: rejectFn };
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
      return { cancelled: response["cancelled"] === true };
    } catch {
      // Process exited / error before response — treat as "not cancelled."
      return { cancelled: false };
    }
  }

  async interrupt(): Promise<void> {
    if (this._state === "idle" || this._state === "closed") return;

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
      await this.close();
    })();
    return this._drainPromise;
  }

  async close(): Promise<void> {
    if (this._state === "closed") return;
    this._state = "closed";

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

    // Clean up skills dir
    if (this.skillsDir) {
      await cleanupSkillsDir(this.skillsDir);
    }
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
      this.handleStreamMessage(msg, line);
      void this.handleResult(msg);
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

    switch (subtype) {
      case "initialize":
        this.sendControlResponse(requestId, {});
        break;

      case "can_use_tool":
        this._state = "waiting_for_approval";
        this.handlePermissionRequest(requestId, request);
        break;

      case "elicitation":
        this._state = "waiting_for_input";
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

  private async handleResult(msg: Record<string, unknown>): Promise<void> {
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

    this._state = "idle";

    // Drain ALL pending send() resolvers with this turn's result. Multiple
    // concurrent sends coalesced by the CLI into one turn share the same
    // TurnResult — documented in SendHandle JSDoc. Splice empties the list
    // so subsequent sends queue against a fresh list for the next turn.
    const pending = this._pendingResults.splice(0);
    for (const p of pending) {
      // Skip sends already settled early by timeout / abort.
      if (p.settled) continue;
      p.settled = true;
      p.cleanup?.();
      p.resolve(result);
    }
  }

  // -------------------------------------------------------------------------
  // Stream event forwarding
  // -------------------------------------------------------------------------

  private handleStreamMessage(msg: Record<string, unknown>, rawLine: string): void {
    // Extract session ID from any message that has one
    if (typeof msg["session_id"] === "string" && msg["session_id"]) {
      this._sessionId = msg["session_id"];
    }

    // Update session state based on message type
    const type = str(msg, "type");
    if (type === "assistant" || type === "thinking") {
      this._state = "thinking";
    } else if (type === "tool_use") {
      this._state = "tool_executing";
    } else if (type === "tool_result") {
      this._state = "thinking";
    }

    // Forward as StreamEvent via the serial dispatch chain
    if (this.ctx.onEvent) {
      for (const event of parseStreamLine(rawLine)) {
        this.dispatchEvent(event);
      }
    }
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
