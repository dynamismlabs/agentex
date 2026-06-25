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
  SessionState,
  SetGoalResult,
  StreamEvent,
  TurnResult,
} from "../../types.js";
import { GoalController, EMULATED_GOAL_CAPABILITY } from "../../goals/index.js";
import { findBinary } from "../../utils/binary.js";
import { buildEnv, ensurePathInEnv } from "../../utils/env.js";
import { uuidv7 } from "../../utils/uuid.js";
import { acquireOpenCodeServer, type OpenCodeServerHandle } from "./server.js";
import { opencodeSessionCodec } from "./codec.js";
import {
  assistantTextFromParts,
  mapOpenCodePart,
  mapOpenCodeToolCall,
  turnStatusFromMessage,
  usageFromMessage,
  type OcBaseInfo,
} from "./event-parse.js";

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}
function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
function rec(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/** Parse a "providerID/modelID" string into opencode's model param. */
function parseModel(model: string | undefined): { providerID: string; modelID: string } | null {
  if (!model) return null;
  const idx = model.indexOf("/");
  if (idx <= 0) return null;
  return { providerID: model.slice(0, idx), modelID: model.slice(idx + 1) };
}

function readResumeId(sessionParams: Record<string, unknown> | null | undefined): string | null {
  const decoded = opencodeSessionCodec.deserialize(sessionParams ?? null);
  const id = decoded?.["sessionId"];
  return typeof id === "string" && id.length > 0 ? id : null;
}

/** Create + connect an OpenCode HTTP/SSE session. */
export async function createOpenCodeSession(ctx: SessionContext): Promise<AgentSession> {
  const session = new OpenCodeSession(ctx);
  await session.connect();
  return session;
}

class OpenCodeSession implements AgentSession {
  private _state: SessionState = "idle";
  private _sessionId: string | null = null;
  private server: OpenCodeServerHandle | null = null;
  private url = "";
  private readonly model: { providerID: string; modelID: string } | null;

  private _turnActive = false;
  private _inFlight: Promise<TurnResult> | null = null;
  private _draining = false;
  /** AbortController for the in-flight `POST /message`, so `close()` can cancel it. */
  private _activeController: AbortController | null = null;

  // Live-stream dedup state (the global SSE feed re-sends full parts as they grow).
  // Cleared at the start of every turn so a prior turn's part ids can't suppress
  // this turn's events.
  private readonly _seenTextLen = new Map<string, number>();
  private readonly _emittedToolCall = new Set<string>();
  private readonly _emittedToolResult = new Set<string>();
  private _sse: AbortController | null = null;

  /** Goal engine. OpenCode has no native goal surface — always emulated. */
  private readonly _goals: GoalController;

  constructor(private readonly ctx: SessionContext) {
    this.model = parseModel(ctx.config?.model);
    this._goals = new GoalController({
      providerType: "opencode",
      capability: EMULATED_GOAL_CAPABILITY,
      getSessionId: () => this._sessionId,
      send: (m) => this.send(m),
      dispatch: (event: StreamEvent) => {
        if (this.ctx.onEvent) void Promise.resolve(this.ctx.onEvent(event)).catch(() => {});
      },
    });
  }

  get sessionId(): string | null {
    return this._sessionId;
  }
  get state(): SessionState {
    return this._state;
  }

  async connect(): Promise<void> {
    const config = this.ctx.config ?? {};
    const resolved = await findBinary("opencode", config.command);
    const env = buildEnv(this.ctx.env);
    ensurePathInEnv(env);
    const cwd = this.ctx.cwd ?? process.cwd();

    this.server = await acquireOpenCodeServer(resolved.bin, resolved.prefixArgs, env, cwd);
    this.url = this.server.url;

    // Everything after acquiring the server must release it on failure, or the
    // pooled `opencode serve` process leaks (refCount stuck at 1 forever).
    try {
      const resumeId = readResumeId(this.ctx.sessionParams);
      if (resumeId) {
        this._sessionId = resumeId;
      } else {
        const res = await fetch(`${this.url}/session`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({}),
        });
        if (!res.ok) throw new Error(`opencode: failed to create session (${res.status})`);
        const data = (await res.json()) as Record<string, unknown>;
        this._sessionId = str(data["id"]);
      }

      // Live event stream (global; filtered to our session).
      this._sse = new AbortController();
      void this.readSse(this._sse.signal);
    } catch (err) {
      if (this._sse) {
        try {
          this._sse.abort();
        } catch {
          /* ignore */
        }
        this._sse = null;
      }
      this.server.release();
      this.server = null;
      this._state = "closed";
      throw err;
    }

    if (this.ctx.signal) {
      if (this.ctx.signal.aborted) void this.close();
      else this.ctx.signal.addEventListener("abort", () => void this.close(), { once: true });
    }
  }

  // -------------------------------------------------------------------------
  // SSE live stream
  // -------------------------------------------------------------------------

  private async readSse(signal: AbortSignal): Promise<void> {
    try {
      const res = await fetch(`${this.url}/global/event`, { signal });
      if (!res.body) return;
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).trimEnd();
          buf = buf.slice(nl + 1);
          if (line.startsWith("data:")) {
            const json = line.slice(5).trim();
            if (json) await this.handleSse(json);
          }
        }
      }
    } catch {
      // Stream closed/aborted — the POST /message response remains authoritative.
    }
  }

  private async handleSse(json: string): Promise<void> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch {
      return;
    }
    const payload = rec(rec(parsed)?.["payload"]);
    if (!payload || payload["type"] !== "message.part.updated") return;
    const props = rec(payload["properties"]);
    const part = rec(props?.["part"]);
    if (!part || str(part["sessionID"]) !== this._sessionId) return;
    await this.emitPart(part);
  }

  private async emitPart(part: Record<string, unknown>): Promise<void> {
    // The SSE feed is global and async: drop stragglers that arrive while no turn
    // is active so a finished turn's late parts don't surface against the next one.
    if (!this._turnActive) return;
    const info: OcBaseInfo = {
      provider: "opencode",
      sessionId: this._sessionId,
      timestamp: new Date().toISOString(),
    };
    const id = str(part["id"]) ?? "";
    const type = part["type"];

    if (type === "text" || type === "reasoning") {
      if (part["synthetic"] === true || part["ignored"] === true) return;
      const full = typeof part["text"] === "string" ? part["text"] : "";
      const seen = this._seenTextLen.get(id) ?? 0;
      if (full.length <= seen) return;
      this._seenTextLen.set(id, full.length);
      const ev = mapOpenCodePart(part, info, full.slice(seen));
      await this.emit(ev);
    } else if (type === "tool") {
      const callId = str(part["callID"]) ?? id;
      const status = str(rec(part["state"])?.["status"]);
      if (!this._emittedToolCall.has(callId)) {
        this._emittedToolCall.add(callId);
        await this.emit(mapOpenCodeToolCall(part, info));
      }
      if ((status === "completed" || status === "error") && !this._emittedToolResult.has(callId)) {
        this._emittedToolResult.add(callId);
        await this.emit(mapOpenCodePart(part, info));
      }
    }
  }

  private async emit(ev: ReturnType<typeof mapOpenCodePart>): Promise<void> {
    if (ev && this.ctx.onEvent) {
      try {
        await this.ctx.onEvent(ev);
      } catch {
        /* a throwing handler must not break the stream */
      }
    }
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  async send(message: string, options?: SendOptions): Promise<SendHandle> {
    if (this._state === "closed") throw new Error("Session is closed");
    if (this._draining) throw new Error("Session is draining — no new sends accepted");
    if (this._turnActive) {
      throw new Error("OpenCode session is busy — a turn is already in progress (concurrentSend not supported)");
    }
    const uuid = uuidv7();
    this._turnActive = true;
    this._state = "thinking";
    const result = this.runTurn(message, options);
    this._inFlight = result;
    // Advance any emulated goal loop once the turn settles (finishTurn runs in
    // runTurn's finally, so the session is idle by the time this fires).
    void result.then((r) => this._goals.onTurnSettled(r)).catch(() => {});
    return { uuid, result };
  }

  private finishTurn(): void {
    this._turnActive = false;
    this._inFlight = null;
    if (this._state !== "closed") this._state = "idle";
  }

  private async runTurn(message: string, options?: SendOptions): Promise<TurnResult> {
    if (!this._sessionId) {
      this.finishTurn();
      return {
        summary: null,
        costUsd: null,
        status: "failed",
        errorCode: "not_initialized",
        errorMessage: "OpenCode session is not initialized",
      };
    }

    // Fresh per-turn live-stream dedup so a previous turn's part ids can't
    // suppress this turn's events.
    this._seenTextLen.clear();
    this._emittedToolCall.clear();
    this._emittedToolResult.clear();

    const ac = new AbortController();
    this._activeController = ac;
    const timeoutSec = options?.timeoutSec ?? this.ctx.config?.timeoutSec;
    const timer =
      timeoutSec && timeoutSec > 0 ? setTimeout(() => ac.abort("timeout"), timeoutSec * 1000) : null;
    const onAbort = (): void => ac.abort("aborted");
    options?.signal?.addEventListener("abort", onAbort, { once: true });

    const body: Record<string, unknown> = { parts: [{ type: "text", text: message }] };
    if (this.model) body["model"] = this.model;

    try {
      const res = await fetch(`${this.url}/session/${this._sessionId}/message`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: ac.signal,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        return {
          summary: null,
          costUsd: null,
          status: "failed",
          errorCode: "http_error",
          errorMessage: `opencode message failed: ${res.status} ${text}`.trim(),
        };
      }
      const data = (await res.json()) as Record<string, unknown>;
      const info = rec(data["info"]);
      const status = turnStatusFromMessage(info);
      const usage = usageFromMessage(info);
      return {
        summary: assistantTextFromParts(data["parts"]) || null,
        ...(usage ? { usage } : {}),
        costUsd: info ? num(info["cost"]) : null,
        status,
        errorCode: status === "failed" ? "agent_error" : null,
        errorMessage: status === "failed" ? JSON.stringify(info?.["error"] ?? null) : null,
      };
    } catch (err) {
      if (ac.signal.aborted) {
        // Don't POST /abort if we're tearing the whole session down (close()
        // already killed the server); only interrupt on timeout/caller-abort.
        const reason = ac.signal.reason === "timeout" ? "timeout" : ac.signal.reason === "closed" ? "aborted" : "aborted";
        if (ac.signal.reason !== "closed") await this.interrupt().catch(() => {});
        return {
          summary: null,
          costUsd: null,
          status: reason,
          errorCode: reason,
          errorMessage: reason === "timeout" ? "Turn exceeded its timeout" : "Turn aborted",
        };
      }
      return {
        summary: null,
        costUsd: null,
        status: "failed",
        errorCode: "request_error",
        errorMessage: err instanceof Error ? err.message : String(err),
      };
    } finally {
      if (timer) clearTimeout(timer);
      options?.signal?.removeEventListener("abort", onAbort);
      if (this._activeController === ac) this._activeController = null;
      this.finishTurn();
    }
  }

  async cancel(_uuid: string): Promise<CancelResult> {
    return { cancelled: false };
  }

  async stopTask(_taskId: string): Promise<StopTaskResult> {
    // OpenCode has no per-task stop control; capabilities.stopTask is false.
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

  async interrupt(): Promise<void> {
    if (!this._sessionId) return;
    try {
      await fetch(`${this.url}/session/${this._sessionId}/abort`, { method: "POST" });
    } catch {
      /* best effort */
    }
  }

  async drain(): Promise<void> {
    this._draining = true;
    if (this._inFlight) {
      try {
        await this._inFlight;
      } catch {
        /* ignore */
      }
    }
    await this.close();
  }

  async close(): Promise<void> {
    this._state = "closed";
    // Abort an in-flight POST /message so close() doesn't leave it racing a
    // killed server (and so the turn settles as aborted, not a confusing error).
    if (this._activeController) {
      try {
        this._activeController.abort("closed");
      } catch {
        /* ignore */
      }
      this._activeController = null;
    }
    if (this._sse) {
      try {
        this._sse.abort();
      } catch {
        /* ignore */
      }
      this._sse = null;
    }
    if (this.server) {
      this.server.release();
      this.server = null;
    }
  }
}
