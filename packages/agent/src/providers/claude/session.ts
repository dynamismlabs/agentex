import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import type {
  AgentSession,
  SessionContext,
  TurnResult,
} from "../../types.js";
import { findBinary } from "../../utils/binary.js";
import { buildEnv, ensurePathInEnv } from "../../utils/env.js";
import { buildSkillsDir, cleanupSkillsDir } from "../../utils/skills.js";
import { parseStreamLine } from "./parse.js";

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

  if (config.skipPermissions) {
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

  return new ClaudeSessionImpl(proc, ctx, skillsDir);
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

class ClaudeSessionImpl implements AgentSession {
  private _state: "idle" | "running" | "closed" = "idle";
  private _sessionId: string | null = null;
  private _lineBuffer = "";
  private _stderrBuffer = "";

  // Active turn state
  private _turnResolve: ((result: TurnResult) => void) | null = null;
  private _turnReject: ((err: Error) => void) | null = null;

  /**
   * Tracks request_ids for async callbacks (permission, elicitation, hooks)
   * that are still in-flight. If the CLI sends a control_cancel_request for
   * one of these, we remove it so the stale response is never sent back.
   */
  private _pendingCallbacks = new Set<string>();

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
        // If a turn was in progress, reject it
        if (this._turnReject) {
          this._turnReject(new Error(
            `Claude process exited unexpectedly (code=${code}, signal=${signal})`
          ));
          this._turnResolve = null;
          this._turnReject = null;
        }
      }
    });

    proc.on("error", (err) => {
      if (this._state !== "closed") {
        this._state = "closed";
        if (this._turnReject) {
          this._turnReject(err);
          this._turnResolve = null;
          this._turnReject = null;
        }
      }
    });
  }

  get sessionId(): string | null { return this._sessionId; }
  get state(): "idle" | "running" | "closed" { return this._state; }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  async send(message: string): Promise<TurnResult> {
    if (this._state === "closed") throw new Error("Session is closed");
    if (this._state === "running") throw new Error("A turn is already in progress");

    this._state = "running";

    // Write user message in stream-json format
    const userMsg = ndjsonLine({
      type: "user",
      session_id: this._sessionId ?? "",
      message: { role: "user", content: message },
      parent_tool_use_id: null,
    });

    this.proc.stdin!.write(userMsg);

    return new Promise<TurnResult>((resolve, reject) => {
      this._turnResolve = resolve;
      this._turnReject = reject;
    });
  }

  async interrupt(): Promise<void> {
    if (this._state !== "running") return;

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

  async close(): Promise<void> {
    if (this._state === "closed") return;
    this._state = "closed";

    // Close stdin to signal the process to exit
    this.proc.stdin!.end();

    // Give it a moment to exit gracefully, then force kill
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

    // Result event — turn is complete
    if (type === "result") {
      this.handleResult(msg);
      return;
    }

    // Stream events — forward via onEvent and parse for agex StreamEvent
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
        this.handlePermissionRequest(requestId, request);
        break;

      case "elicitation":
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
      this.sendControlResponse(requestId, {
        behavior: "allow",
        toolUseID: toolUseId,
      });
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

      const response: Record<string, unknown> = {
        behavior: resp.allow ? "allow" : "deny",
        toolUseID: toolUseId,
      };
      if (resp.message) response["message"] = resp.message;
      if (resp.updatedInput) response["updatedInput"] = resp.updatedInput;

      this.sendControlResponse(requestId, response);
    } catch {
      if (!this._pendingCallbacks.delete(requestId)) return;
      this.sendControlResponse(requestId, {
        behavior: "deny",
        toolUseID: toolUseId,
        message: "Permission callback threw an error",
      });
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
    } catch {
      if (!this._pendingCallbacks.delete(requestId)) return;
      this.sendControlResponse(requestId, { action: "cancel" });
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

  private handleResult(msg: Record<string, unknown>): void {
    const summary = typeof msg["result"] === "string" ? msg["result"] : null;
    const isError = msg["is_error"] === true;
    const costUsd = typeof msg["total_cost_usd"] === "number" ? msg["total_cost_usd"] : null;
    const stopReason = str(msg, "stop_reason") || null;

    const usageObj = typeof msg["usage"] === "object" && msg["usage"] !== null
      ? msg["usage"] as Record<string, unknown>
      : null;

    const usage = usageObj ? {
      inputTokens: typeof usageObj["input_tokens"] === "number" ? usageObj["input_tokens"] : 0,
      outputTokens: typeof usageObj["output_tokens"] === "number" ? usageObj["output_tokens"] : 0,
      cachedInputTokens: typeof usageObj["cache_read_input_tokens"] === "number"
        ? usageObj["cache_read_input_tokens"] : undefined,
    } : undefined;

    // Extract session ID
    if (typeof msg["session_id"] === "string" && msg["session_id"]) {
      this._sessionId = msg["session_id"];
    }

    // Detect error codes
    let errorCode: string | null = null;
    const subtype = str(msg, "subtype");
    if (subtype === "error_max_turns" || stopReason === "max_turns") {
      errorCode = "max_turns";
    } else if (subtype === "error_max_budget_usd") {
      errorCode = "max_budget";
    } else if (subtype === "error_during_execution") {
      errorCode = "execution_error";
    }

    const result: TurnResult = {
      summary,
      usage,
      costUsd,
      isError,
      errorCode,
      errorMessage: isError ? summary : null,
      stopReason,
    };

    this._state = "idle";
    if (this._turnResolve) {
      const resolve = this._turnResolve;
      this._turnResolve = null;
      this._turnReject = null;
      resolve(result);
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

    // Forward as StreamEvent via onEvent callback
    if (this.ctx.onEvent) {
      for (const event of parseStreamLine(rawLine)) {
        try { void this.ctx.onEvent(event); } catch { /* swallow */ }
      }
    }
  }

}
