import { unsupportedSessionTelemetry } from "../../telemetry/integration.js";
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
  UserInputResponse,
} from "../../types.js";
import { GoalController, EMULATED_GOAL_CAPABILITY } from "../../goals/index.js";
import { findBinary } from "../../utils/binary.js";
import { buildEnv, ensurePathInEnv } from "../../utils/env.js";
import { uuidv7 } from "../../utils/uuid.js";
import { acquireOpenCodeServer, type OpenCodeServerHandle } from "./server.js";
import { OpenCodeHttpError, type OpenCodeClient } from "./client.js";
import { createSessionRecord } from "../../sessions/record.js";
import { opencodeSessionCodec } from "./codec.js";
import { prepareOpenCodeSkillConfig } from "./skill-config.js";
import {
  assistantTextFromParts,
  incompleteTurnMessage,
  mapOpenCodePart,
  mapOpenCodeToolCall,
  terminalOutcome,
  usageFromMessage,
  type OcBaseInfo,
} from "./event-parse.js";
import {
  normalizeV2MessageToEnvelope,
  serverApiVersion,
  v2DataArray,
  v2DataRecord,
  v2ErrorMessage,
  v2ToolContentText,
} from "./v2.js";

interface V2TurnOutcome {
  status: "succeeded" | "failed" | "interrupted" | "idle";
  error?: unknown;
  reason?: string;
}

interface V2TurnWaiter {
  promise: Promise<V2TurnOutcome>;
  resolve: (value: V2TurnOutcome) => void;
  started: boolean;
}

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
  return unsupportedSessionTelemetry(session);
}

class OpenCodeSession implements AgentSession {
  private _state: SessionState = "idle";
  private _sessionId: string | null = null;
  private server: OpenCodeServerHandle | null = null;
  private client: OpenCodeClient | null = null;
  private cwd = "";
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
  private readonly _v2ToolNames = new Map<string, string>();
  private _v2TurnWaiter: V2TurnWaiter | null = null;
  /**
   * messageID → role, learned from `message.updated` SSE frames. Lets `emitPart`
   * drop a user message's own text part, which opencode streams once a turn is
   * active and would otherwise surface as an assistant bubble echoing the prompt.
   */
  private readonly _messageRoles = new Map<string, string>();
  private _sse: AbortController | null = null;
  private readonly _handledInput = new Set<string>();
  private readonly _inputInFlight = new Set<string>();
  private readonly _inputReplies = new Map<string, { path: string; method?: string; body?: Record<string, unknown> }>();
  private readonly _inputAbort = new AbortController();
  private _pendingPoll: ReturnType<typeof setInterval> | null = null;
  private _skillConfigCleanup: (() => Promise<void>) | null = null;

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

  private get isV2(): boolean {
    return serverApiVersion(this.server) === 2;
  }

  private v2ModelRef(): Record<string, unknown> | null {
    if (!this.model) return null;
    return {
      providerID: this.model.providerID,
      id: this.model.modelID,
      ...(this.ctx.config?.modelVariant ? { variant: this.ctx.config.modelVariant } : {}),
    };
  }

  private selectedAgent(): string | undefined {
    return this.ctx.config?.planMode ? "plan" : (this.ctx.config?.modeId ?? this.ctx.config?.mode);
  }

  async connect(): Promise<void> {
    const config = this.ctx.config ?? {};
    const resolved = await findBinary("opencode", config.command);
    const baseEnv = buildEnv(this.ctx.env);
    ensurePathInEnv(baseEnv);
    const skillConfig = await prepareOpenCodeSkillConfig(baseEnv, config.skillDirs);
    const env = skillConfig.env;
    this._skillConfigCleanup = skillConfig.cleanup;
    const cwd = this.ctx.cwd ?? process.cwd();
    this.cwd = cwd;

    try {
      this.server = await acquireOpenCodeServer(resolved.bin, resolved.prefixArgs, env, cwd);
    } catch (error) {
      await this._skillConfigCleanup();
      this._skillConfigCleanup = null;
      throw error;
    }
    this.client = this.server.client;

    // Everything after acquiring the server must release it on failure, or the
    // pooled `opencode serve` process leaks (refCount stuck at 1 forever).
    try {
      const resumeId = readResumeId(this.ctx.sessionParams);
      if (this.isV2) {
        const modelRef = this.v2ModelRef();
        const agent = this.selectedAgent();
        if (resumeId) {
          this._sessionId = resumeId;
          if (modelRef) {
            await this.client.ok(`/api/session/${encodeURIComponent(resumeId)}/model`, {
              method: "POST",
              body: JSON.stringify({ model: modelRef }),
            });
          }
          if (agent) {
            await this.client.ok(`/api/session/${encodeURIComponent(resumeId)}/agent`, {
              method: "POST",
              body: JSON.stringify({ agent }),
            });
          }
        } else {
          const createBody: Record<string, unknown> = {};
          if (modelRef) createBody["model"] = modelRef;
          if (agent) createBody["agent"] = agent;
          const res = await this.client.request("/api/session", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(createBody),
          });
          if (!res.ok) throw new Error(`opencode: failed to create session (${res.status})`);
          const data = v2DataRecord(await res.json());
          this._sessionId = str(data["id"]);
        }
      } else if (resumeId) {
        this._sessionId = resumeId;
      } else {
        const res = await this.client.request("/session", {
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
      await this.startSse(this._sse.signal);
      await this.reconcilePendingInput();
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
      await this._skillConfigCleanup?.();
      this._skillConfigCleanup = null;
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

  private async startSse(signal: AbortSignal): Promise<void> {
    if (!this.client) throw new Error("OpenCode client is unavailable");
    const response = await this.client.request(this.isV2 ? "/api/event" : "/global/event", { signal });
    if (!response.ok || !response.body) {
      throw new Error(`opencode: failed to establish event stream (${response.status})`);
    }
    void this.readSse(response, signal);
  }

  private async readSse(res: Response, signal: AbortSignal): Promise<void> {
    try {
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
      // Reconciliation polling remains authoritative while a turn is active.
    } finally {
      if (!signal.aborted && this._state !== "closed") {
        await new Promise((resolve) => setTimeout(resolve, 250));
        try {
          await this.startSse(signal);
          await this.reconcilePendingInput();
        } catch {
          // The active-turn polling path will keep pending input visible.
        }
      }
    }
  }

  private async handleSse(json: string): Promise<void> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch {
      return;
    }
    if (this.isV2) {
      const event = rec(parsed);
      if (event) await this.handleV2Sse(event);
      return;
    }
    const payload = rec(rec(parsed)?.["payload"]);
    if (!payload) return;
    if (payload["type"] === "permission.asked" || payload["type"] === "permission.updated") {
      const request = rec(rec(payload["properties"])?.["request"]) ?? rec(payload["properties"]);
      if (request) await this.handlePermission(request);
      return;
    }
    if (payload["type"] === "question.asked") {
      const request = rec(rec(payload["properties"])?.["request"]) ?? rec(payload["properties"]);
      if (request) await this.handleQuestion(request);
      return;
    }
    if (payload["type"] === "message.updated") {
      // Track message roles so emitPart can distinguish a user message's own
      // text part (echoed onto the SSE feed) from real assistant output.
      const info = rec(rec(payload["properties"])?.["info"]) ?? rec(payload["properties"]);
      const mid = info ? str(info["id"]) : null;
      const role = info ? str(info["role"]) : null;
      if (mid && role && str(info!["sessionID"]) === this._sessionId) {
        this._messageRoles.set(mid, role);
      }
      return;
    }
    if (payload["type"] !== "message.part.updated") return;
    const props = rec(payload["properties"]);
    const part = rec(props?.["part"]);
    if (!part || str(part["sessionID"]) !== this._sessionId) return;
    await this.emitPart(part);
  }

  private async handleV2Sse(event: Record<string, unknown>): Promise<void> {
    const type = str(event["type"]);
    const data = rec(event["data"]);
    if (!type || !data) return;

    if (type === "permission.asked") {
      if (str(data["sessionID"]) === this._sessionId) {
        await this.handlePermission(data);
      }
      return;
    }
    if (type === "form.created") {
      const form = rec(data["form"]);
      if (form && str(form["sessionID"]) === this._sessionId) {
        await this.handleForm(form);
      }
      return;
    }

    if (str(data["sessionID"]) !== this._sessionId) return;

    if (type === "session.execution.started") {
      if (this._v2TurnWaiter) this._v2TurnWaiter.started = true;
      return;
    }
    if (type === "session.execution.succeeded") {
      this._v2TurnWaiter?.resolve({ status: "succeeded" });
      return;
    }
    if (type === "session.execution.failed") {
      this._v2TurnWaiter?.resolve({ status: "failed", error: data["error"] });
      return;
    }
    if (type === "session.execution.interrupted") {
      this._v2TurnWaiter?.resolve({ status: "interrupted", reason: str(data["reason"]) ?? undefined });
      return;
    }
    if (type === "session.idle") {
      if (this._v2TurnWaiter?.started) this._v2TurnWaiter.resolve({ status: "idle" });
      return;
    }

    if (!this._turnActive) return;

    const nowIso = new Date().toISOString();
    const messageId = str(data["assistantMessageID"]);
    const base = {
      timestamp: nowIso,
      providerType: "opencode",
      sessionId: this._sessionId,
      messageId,
      turnId: null,
      parentToolCallId: null,
      raw: event,
    };

    if (type === "session.text.delta") {
      const delta = typeof data["delta"] === "string" ? data["delta"] : "";
      if (!delta) return;
      const ordinal = num(data["ordinal"]);
      await this.emit({
        type: "assistant",
        text: delta,
        eventId: messageId && ordinal !== null ? `${messageId}:part:${ordinal}` : null,
        ...base,
      });
      return;
    }
    if (type === "session.reasoning.delta") {
      const delta = typeof data["delta"] === "string" ? data["delta"] : "";
      if (!delta) return;
      const ordinal = num(data["ordinal"]);
      await this.emit({
        type: "thinking",
        text: delta,
        eventId: messageId && ordinal !== null ? `${messageId}:part:${ordinal}` : null,
        ...base,
      });
      return;
    }
    if (type === "session.tool.input.started") {
      const toolId = str(data["id"]);
      const toolName = str(data["name"]);
      if (toolId && toolName) this._v2ToolNames.set(toolId, toolName);
      return;
    }
    if (type === "session.tool.called") {
      const callId = str(data["id"]);
      if (!callId || this._emittedToolCall.has(callId)) return;
      this._emittedToolCall.add(callId);
      const name = this._v2ToolNames.get(callId) ?? "tool";
      await this.emit({
        type: "tool_call",
        toolCallId: callId,
        name,
        input: data["input"],
        eventId: `${callId}:call`,
        ...base,
      });
      return;
    }
    if (type === "session.tool.success" || type === "session.tool.failed") {
      const callId = str(data["id"]);
      if (!callId || this._emittedToolResult.has(callId)) return;
      const name = this._v2ToolNames.get(callId) ?? null;
      if (!this._emittedToolCall.has(callId)) {
        this._emittedToolCall.add(callId);
        await this.emit({
          type: "tool_call",
          toolCallId: callId,
          name: name ?? "tool",
          input: undefined,
          eventId: `${callId}:call`,
          ...base,
        });
      }
      this._emittedToolResult.add(callId);
      const isError = type === "session.tool.failed";
      const content = isError
        ? (v2ErrorMessage(data["error"]) || v2ToolContentText(data["content"]) || "Tool error")
        : (v2ToolContentText(data["content"]) ?? "");
      await this.emit({
        type: "tool_result",
        toolCallId: callId,
        toolName: name,
        content,
        isError,
        exitCode: null,
        eventId: `${callId}:result`,
        ...base,
      });
    }
  }

  private async reconcilePendingInput(): Promise<void> {
    if (!this.client || !this._sessionId || this._state === "closed") return;
    if (this.isV2) {
      const encodedId = encodeURIComponent(this._sessionId);
      const [permissionsPayload, formsPayload] = await Promise.all([
        this.client.json<unknown>(`/api/session/${encodedId}/permission`).catch(() => []),
        this.client.json<unknown>(`/api/session/${encodedId}/form`).catch(() => []),
      ]);
      for (const value of v2DataArray(permissionsPayload)) {
        const request = rec(value);
        if (request && str(request["sessionID"]) === this._sessionId) await this.handlePermission(request);
      }
      for (const value of v2DataArray(formsPayload)) {
        const form = rec(value);
        if (form && str(form["sessionID"]) === this._sessionId) await this.handleForm(form);
      }
      return;
    }
    const [permissions, questions] = await Promise.all([
      this.client.json<unknown[]>("/permission").catch(() => []),
      this.client.json<unknown[]>("/question").catch(() => []),
    ]);
    for (const value of permissions) {
      const request = rec(value);
      if (request && str(request["sessionID"]) === this._sessionId) await this.handlePermission(request);
    }
    for (const value of questions) {
      const request = rec(value);
      if (request && str(request["sessionID"]) === this._sessionId) await this.handleQuestion(request);
    }
  }

  private async hostInput(
    request: Parameters<NonNullable<SessionContext["onUserInputRequest"]>>[0],
  ): Promise<UserInputResponse> {
    const fallback: UserInputResponse = {
      allow: (this.ctx.config?.unattendedPermissionPolicy ?? "allow") === "allow",
    };
    if (!this.ctx.onUserInputRequest) return fallback;
    const timeoutSec = this.ctx.config?.inputRequestTimeoutSec ?? 300;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let abortListener: (() => void) | null = null;
    try {
      const timeout = new Promise<typeof fallback>((resolve) => {
        timer = setTimeout(() => resolve(fallback), Math.max(0, timeoutSec) * 1000);
      });
      const closed = new Promise<typeof fallback>((resolve) => {
        abortListener = () => resolve(fallback);
        this._inputAbort.signal.addEventListener("abort", abortListener, { once: true });
      });
      return await Promise.race([
        Promise.resolve(this.ctx.onUserInputRequest(request)).catch(() => fallback),
        timeout,
        closed,
      ]);
    } finally {
      if (timer) clearTimeout(timer);
      if (abortListener) this._inputAbort.signal.removeEventListener("abort", abortListener);
    }
  }

  private restoreAfterInput(): void {
    if (this._state !== "closed") this._state = this._turnActive ? "thinking" : "idle";
  }

  private async handlePermission(request: Record<string, unknown>): Promise<void> {
    const id = str(request["id"]);
    if (!id || this._handledInput.has(id) || this._inputInFlight.has(id)
      || str(request["sessionID"]) !== this._sessionId || !this.client) return;
    this._inputInFlight.add(id);
    try {
      let reply = this._inputReplies.get(id);
      if (!reply) {
        this._state = "waiting_for_approval";
        const permission = str(request["permission"]) ?? str(request["action"]) ?? "Tool";
        const resourceList = Array.isArray(request["patterns"])
          ? request["patterns"]
          : Array.isArray(request["resources"])
            ? request["resources"]
            : [];
        const resourceText = resourceList.filter((item): item is string => typeof item === "string").join(", ");
        const msgText = str(request["message"]);
        const description = [msgText, resourceText].filter(Boolean).join(": ") || undefined;
        const response = await this.hostInput({
          toolName: permission,
          input: rec(request["metadata"]) ?? {},
          toolUseId: id,
          title: permission,
          description,
        });
        reply = this.isV2
          ? {
              path: `/api/session/${encodeURIComponent(this._sessionId!)}/permission/${encodeURIComponent(id)}/reply`,
              body: {
                decision: response.allow ? "once" : "reject",
                ...(response.message ? { message: response.message } : {}),
              },
            }
          : {
              path: `/permission/${encodeURIComponent(id)}/reply`,
              body: {
                reply: response.allow ? "once" : "reject",
                ...(response.message ? { message: response.message } : {}),
              },
            };
        this._inputReplies.set(id, reply);
      }
      await this.deliverInputReply(id, reply);
    } finally {
      this._inputInFlight.delete(id);
      this.restoreAfterInput();
    }
  }

  private async deliverInputReply(
    id: string,
    reply: { path: string; method?: string; body?: Record<string, unknown> },
  ): Promise<void> {
    if (!this.client) return;
    try {
      await this.client.ok(reply.path, {
        method: reply.method ?? "POST",
        ...(reply.body ? { body: JSON.stringify(reply.body) } : {}),
      });
      this._handledInput.add(id);
      this._inputReplies.delete(id);
    } catch (err) {
      if (err instanceof OpenCodeHttpError) {
        if (err.status === 404 || err.status === 409 || err.status === 410) {
          this._handledInput.add(id);
          this._inputReplies.delete(id);
        } else if (err.status >= 400 && err.status < 500 && err.status !== 408 && err.status !== 429) {
          this._inputReplies.delete(id);
        }
      }
      // Keep the cached host decision on transient errors so reconciliation retries only the reply.
    }
  }

  private async handleQuestion(request: Record<string, unknown>): Promise<void> {
    const id = str(request["id"]);
    if (!id || this._handledInput.has(id) || this._inputInFlight.has(id)
      || str(request["sessionID"]) !== this._sessionId || !this.client) return;
    this._inputInFlight.add(id);
    try {
      let reply = this._inputReplies.get(id);
      if (!reply) {
        this._state = "waiting_for_input";
        const questions = (Array.isArray(request["questions"]) ? request["questions"] : []).map((value) => {
          const question = rec(value) ?? {};
          return {
            question: str(question["question"]) ?? str(question["header"]) ?? "Question",
            header: str(question["header"]) ?? "Question",
            options: (Array.isArray(question["options"]) ? question["options"] : []).map((raw) => {
              const option = rec(raw) ?? {};
              return {
                label: str(option["label"]) ?? "",
                description: str(option["description"]) ?? "",
              };
            }).filter((option) => option.label),
            ...(question["multiple"] === true ? { multiSelect: true } : {}),
          };
        });
        const response = await this.hostInput({
          toolName: "AskUserQuestion",
          input: { questions },
          toolUseId: id,
        });
        if (!response.allow) {
          reply = { path: `/question/${encodeURIComponent(id)}/reject` };
        } else {
          const answerMap = rec(response.updatedInput?.["answers"]) ?? {};
          const answers = questions.map((question) => {
            const raw = answerMap[question.question] ?? answerMap[question.header];
            if (Array.isArray(raw)) return raw.filter((item): item is string => typeof item === "string");
            return typeof raw === "string" ? [raw] : [];
          });
          reply = { path: `/question/${encodeURIComponent(id)}/reply`, body: { answers } };
        }
        this._inputReplies.set(id, reply);
      }
      await this.deliverInputReply(id, reply);
    } finally {
      this._inputInFlight.delete(id);
      this.restoreAfterInput();
    }
  }

  private async handleForm(form: Record<string, unknown>): Promise<void> {
    const id = str(form["id"]);
    if (!id || this._handledInput.has(id) || this._inputInFlight.has(id)
      || str(form["sessionID"]) !== this._sessionId || !this.client) return;
    this._inputInFlight.add(id);
    try {
      let reply = this._inputReplies.get(id);
      if (!reply) {
        this._state = "waiting_for_input";
        const rawFields = Array.isArray(form["fields"]) ? form["fields"] : [];
        const fieldMetas: Array<{
          key: string;
          kind: string;
          questionText: string;
          header: string;
          labelToValue: Map<string, string>;
        }> = [];
        const questions = rawFields.map((value) => {
          const field = rec(value) ?? {};
          const key = str(field["key"]) ?? "answer";
          const kind = str(field["type"]) ?? "string";
          const questionText = str(field["title"]) ?? str(field["description"]) ?? key;
          const labelToValue = new Map<string, string>();
          let options: Array<{ label: string; description: string }> = [];
          if ((kind === "multiselect" || kind === "string") && Array.isArray(field["options"])) {
            options = field["options"]
              .map((rawOpt) => {
                const opt = rec(rawOpt) ?? {};
                const optLabel = str(opt["label"]) ?? str(opt["value"]) ?? "";
                const optValue = str(opt["value"]) ?? optLabel;
                if (optLabel && optValue) labelToValue.set(optLabel, optValue);
                return { label: optLabel, description: str(opt["description"]) ?? "" };
              })
              .filter((opt) => opt.label);
          } else if (kind === "boolean") {
            options = [
              { label: "Yes", description: "" },
              { label: "No", description: "" },
            ];
          }
          fieldMetas.push({ key, kind, questionText, header: key, labelToValue });
          const maxItems = num(field["maxItems"]);
          return {
            question: questionText,
            header: key,
            options,
            ...(kind === "multiselect" && (maxItems === null || maxItems > 1) ? { multiSelect: true } : {}),
          };
        });
        const response = await this.hostInput({
          toolName: "AskUserQuestion",
          input: { questions },
          toolUseId: id,
        });
        const encodedSession = encodeURIComponent(this._sessionId!);
        const encodedForm = encodeURIComponent(id);
        if (!response.allow) {
          reply = {
            path: `/api/session/${encodedSession}/form/${encodedForm}`,
            method: "DELETE",
          };
        } else {
          const answerMap = rec(response.updatedInput?.["answers"]) ?? {};
          const answer: Record<string, unknown> = {};
          for (const meta of fieldMetas) {
            const raw = answerMap[meta.questionText] ?? answerMap[meta.header] ?? answerMap[meta.key];
            if (meta.kind === "multiselect") {
              const list = Array.isArray(raw)
                ? raw.filter((item): item is string => typeof item === "string")
                : typeof raw === "string" && raw.length > 0 ? [raw] : [];
              answer[meta.key] = list.map((item) => meta.labelToValue.get(item) ?? item);
            } else if (meta.kind === "boolean") {
              const first = Array.isArray(raw) ? raw[0] : raw;
              answer[meta.key] = first === true || /^(yes|true|1)$/i.test(String(first ?? ""));
            } else if (meta.kind === "number" || meta.kind === "integer") {
              const first = Array.isArray(raw) ? raw[0] : raw;
              const parsedNum = typeof first === "number" ? first : Number(first);
              if (Number.isFinite(parsedNum)) {
                answer[meta.key] = meta.kind === "integer" ? Math.trunc(parsedNum) : parsedNum;
              }
            } else {
              const strVal = Array.isArray(raw)
                ? (raw.length === 1 ? raw[0] : raw.join(", "))
                : raw;
              if (typeof strVal === "string") {
                answer[meta.key] = meta.labelToValue.get(strVal) ?? strVal;
              } else if (strVal !== undefined) {
                const asString = String(strVal);
                answer[meta.key] = meta.labelToValue.get(asString) ?? asString;
              }
            }
          }
          reply = {
            path: `/api/session/${encodedSession}/form/${encodedForm}/reply`,
            method: "POST",
            body: { answer },
          };
        }
        this._inputReplies.set(id, reply);
      }
      await this.deliverInputReply(id, reply);
    } finally {
      this._inputInFlight.delete(id);
      this.restoreAfterInput();
    }
  }

  private async emitPart(part: Record<string, unknown>): Promise<void> {
    // The SSE feed is global and async: drop stragglers that arrive while no turn
    // is active so a finished turn's late parts don't surface against the next one.
    if (!this._turnActive) return;
    // Drop parts belonging to a user message — opencode re-streams the prompt's
    // own text part once the turn is active, which would echo as an assistant
    // bubble. Unknown role (message.updated not seen yet) falls through and
    // emits, so a race can never suppress genuine assistant output.
    const messageId = str(part["messageID"]);
    if (messageId && this._messageRoles.get(messageId) === "user") return;
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

  private async emit(ev: StreamEvent | null): Promise<void> {
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
    // Cleared at turn end, not with the sibling dedup maps at turn start: the
    // user message's role has to survive from its `message.updated` frame into
    // the part stream that follows within the same turn, so clearing at the
    // start would reintroduce the prompt echo. Bounding it here keeps the map
    // from growing for the whole life of a long-running session.
    this._messageRoles.clear();
    if (this._state !== "closed") this._state = "idle";
  }

  private async runTurn(message: string, options?: SendOptions): Promise<TurnResult> {
    const startedAt = Date.now();
    if (!this._sessionId) {
      const outcome: TurnResult = {
        summary: null,
        costUsd: null,
        status: "failed",
        errorCode: "not_initialized",
        errorMessage: "OpenCode session is not initialized",
      };
      await this.emitTerminal(outcome, {}, startedAt);
      this.finishTurn();
      return outcome;
    }

    // Fresh per-turn live-stream dedup so a previous turn's part ids can't
    // suppress this turn's events.
    this._seenTextLen.clear();
    this._emittedToolCall.clear();
    this._emittedToolResult.clear();
    this._v2ToolNames.clear();

    const ac = new AbortController();
    this._activeController = ac;
    const timeoutSec = options?.timeoutSec ?? this.ctx.config?.timeoutSec;
    const timer =
      timeoutSec && timeoutSec > 0 ? setTimeout(() => ac.abort("timeout"), timeoutSec * 1000) : null;
    const onAbort = (): void => ac.abort("aborted");
    options?.signal?.addEventListener("abort", onAbort, { once: true });

    const body: Record<string, unknown> = { parts: [{ type: "text", text: message }] };
    if (this.model) body["model"] = this.model;
    if (this.ctx.config?.modelVariant) body["variant"] = this.ctx.config.modelVariant;
    const agent = this.selectedAgent();
    if (agent) body["agent"] = agent;

    let outcome: TurnResult;
    let terminalRaw: Record<string, unknown> = {};
    try {
      if (!this.server?.isCurrent()) {
        outcome = {
          summary: null,
          costUsd: null,
          status: "failed",
          errorCode: "runtime_reconfigured",
          errorMessage: "OpenCode runtime configuration changed. Start a fresh session.",
        };
      } else if (this.isV2) {
        this._pendingPoll = setInterval(() => void this.reconcilePendingInput(), 750);
        const v2Result = await this.runV2Turn(message, ac.signal);
        outcome = v2Result.outcome;
        terminalRaw = v2Result.terminalRaw;
      } else {
        this._pendingPoll = setInterval(() => void this.reconcilePendingInput(), 750);
        const res = await this.client!.request(`/session/${this._sessionId}/message`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
          signal: ac.signal,
        });
        if (!res.ok) {
          outcome = {
            summary: null,
            costUsd: null,
            status: "failed",
            errorCode: "http_error",
            errorMessage: `OpenCode message request failed (${res.status})`,
          };
          terminalRaw = { status: res.status };
        } else {
          const data = (await res.json()) as Record<string, unknown>;
          terminalRaw = data;
          const info = rec(data["info"]);
          const usage = usageFromMessage(info);
          const summary = assistantTextFromParts(data["parts"]) || null;
          const costUsd = info ? num(info["cost"]) : null;
          const term = terminalOutcome(info, summary != null && summary.trim().length > 0);
          // A silent empty turn (upstream dropped the stream) would otherwise
          // render as a stall. Surface a visible note before the terminal result.
          if (term.incomplete && info) await this.emitIncompleteNote(info);
          outcome = {
            summary,
            ...(usage ? { usage } : {}),
            costUsd,
            status: term.status,
            errorCode: term.errorCode,
            errorMessage: term.errorMessage,
          };
        }
      }
    } catch (err) {
      if (ac.signal.aborted) {
        const reason = ac.signal.reason === "timeout" ? "timeout" : "aborted";
        if (ac.signal.reason !== "closed") await this.interrupt().catch(() => {});
        outcome = {
          summary: null,
          costUsd: null,
          status: reason,
          errorCode: reason,
          errorMessage: reason === "timeout" ? "Turn exceeded its timeout" : "Turn aborted",
        };
      } else {
        outcome = {
          summary: null,
          costUsd: null,
          status: "failed",
          errorCode: "request_error",
          errorMessage: err instanceof Error ? err.message : String(err),
        };
      }
    } finally {
      this._v2TurnWaiter = null;
      if (this._pendingPoll) clearInterval(this._pendingPoll);
      this._pendingPoll = null;
      if (timer) clearTimeout(timer);
      options?.signal?.removeEventListener("abort", onAbort);
      if (this._activeController === ac) this._activeController = null;
    }
    await this.emitTerminal(outcome, terminalRaw, startedAt);
    this.finishTurn();
    return outcome;
  }

  private async runV2Turn(
    message: string,
    signal: AbortSignal,
  ): Promise<{ outcome: TurnResult; terminalRaw: Record<string, unknown> }> {
    const encodedId = encodeURIComponent(this._sessionId!);
    let resolveWaiter!: (value: V2TurnOutcome) => void;
    const waiterPromise = new Promise<V2TurnOutcome>((resolve) => {
      resolveWaiter = resolve;
    });
    this._v2TurnWaiter = { promise: waiterPromise, resolve: resolveWaiter, started: false };

    const promptRes = await this.client!.request(`/api/session/${encodedId}/prompt`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: message }),
      signal,
    });
    if (!promptRes.ok) {
      return {
        outcome: {
          summary: null,
          costUsd: null,
          status: "failed",
          errorCode: "http_error",
          errorMessage: `OpenCode prompt request failed (${promptRes.status})`,
        },
        terminalRaw: { status: promptRes.status },
      };
    }

    const promptPayload = await promptRes.json().catch(() => null);
    const promptId = str(v2DataRecord(promptPayload)["id"]);

    const waitController = new AbortController();
    const onTurnAbort = (): void => waitController.abort(signal.reason);
    if (signal.aborted) {
      waitController.abort(signal.reason);
    } else {
      signal.addEventListener("abort", onTurnAbort, { once: true });
    }

    const waitFallback = (async (): Promise<V2TurnOutcome> => {
      try {
        const res = await this.client!.request(`/api/experimental/session/${encodedId}/wait`, {
          method: "POST",
          signal: waitController.signal,
        });
        if (!res.ok) return waiterPromise;
        return await new Promise<V2TurnOutcome>((resolve) => {
          const timer = setTimeout(() => {
            waitController.signal.removeEventListener("abort", onWaitAbort);
            resolve({ status: "idle" });
          }, 100);
          timer.unref?.();
          const onWaitAbort = (): void => {
            clearTimeout(timer);
            resolve({ status: "idle" });
          };
          if (waitController.signal.aborted) {
            onWaitAbort();
            return;
          }
          waitController.signal.addEventListener("abort", onWaitAbort, { once: true });
          void waiterPromise.then((value) => {
            clearTimeout(timer);
            waitController.signal.removeEventListener("abort", onWaitAbort);
            resolve(value);
          });
        });
      } catch {
        return waiterPromise;
      }
    })();

    let onRaceAbort: (() => void) | null = null;
    const abortedPromise = new Promise<never>((_, reject) => {
      const rejectAbort = (): void => {
        reject(signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason ?? "aborted")));
      };
      if (signal.aborted) {
        rejectAbort();
        return;
      }
      onRaceAbort = rejectAbort;
      signal.addEventListener("abort", onRaceAbort, { once: true });
    });

    let waitOutcome: V2TurnOutcome;
    try {
      waitOutcome = await Promise.race([waiterPromise, waitFallback, abortedPromise]);
    } finally {
      waitController.abort("settled");
      signal.removeEventListener("abort", onTurnAbort);
      if (onRaceAbort) signal.removeEventListener("abort", onRaceAbort);
    }

    const msgRes = await this.client!.request(`/api/session/${encodedId}/message?limit=20&order=desc`, { signal });
    const rawList = msgRes.ok ? v2DataArray(await msgRes.json().catch(() => [])) : [];
    let rawAssistant: Record<string, unknown> | null = null;
    let rawIdle: Record<string, unknown> | null = null;
    for (const item of rawList) {
      const entry = rec(item);
      if (!entry) continue;
      if (promptId && str(entry["id"]) === promptId) break;
      if (!rawIdle && entry["type"] === "idle") {
        rawIdle = entry;
      }
      if (!rawAssistant && entry["type"] === "assistant") {
        rawAssistant = entry;
      }
      if (rawIdle && rawAssistant) break;
    }

    const idleOutcome = rawIdle ? str(rawIdle["outcome"]) : null;
    const effectiveWaitOutcome: V2TurnOutcome =
      waitOutcome.status === "idle" && idleOutcome
        ? idleOutcome === "failed"
          ? { status: "failed", error: rawIdle?.["error"] ?? { type: "idle_failed", message: "OpenCode turn failed" } }
          : idleOutcome === "interrupted"
            ? { status: "interrupted", reason: str(rawIdle?.["reason"]) ?? undefined }
            : { status: "succeeded" }
        : waitOutcome;

    if (!rawAssistant) {
      if (effectiveWaitOutcome.status === "failed") {
        const msg = v2ErrorMessage(effectiveWaitOutcome.error)
          || JSON.stringify(effectiveWaitOutcome.error ?? "OpenCode turn failed");
        return {
          outcome: {
            summary: null,
            costUsd: null,
            status: "failed",
            errorCode: "agent_error",
            errorMessage: msg,
          },
          terminalRaw: { error: effectiveWaitOutcome.error, ...(rawIdle ? { idle: rawIdle } : {}) },
        };
      }
      if (effectiveWaitOutcome.status === "interrupted") {
        return {
          outcome: {
            summary: null,
            costUsd: null,
            status: "aborted",
            errorCode: "aborted",
            errorMessage: "The turn was interrupted.",
          },
          terminalRaw: { interrupted: true, reason: effectiveWaitOutcome.reason, ...(rawIdle ? { idle: rawIdle } : {}) },
        };
      }
      if (effectiveWaitOutcome.status === "idle") {
        const msg = "OpenCode turn became idle without a recorded completion or assistant response.";
        return {
          outcome: {
            summary: null,
            costUsd: null,
            status: "failed",
            errorCode: "incomplete_turn",
            errorMessage: msg,
          },
          terminalRaw: { idle: true },
        };
      }
    }

    const envelope = rawAssistant ? normalizeV2MessageToEnvelope(rawAssistant) : null;
    const baseInfo = envelope?.info ?? {};
    const effectiveInfo = !baseInfo["error"] && effectiveWaitOutcome.status === "failed" && effectiveWaitOutcome.error != null
      ? { ...baseInfo, error: effectiveWaitOutcome.error }
      : baseInfo;
    const usage = usageFromMessage(effectiveInfo);
    const summary = envelope ? (assistantTextFromParts(envelope.parts) || null) : null;
    const costUsd = num(effectiveInfo["cost"]);
    const terminalRaw: Record<string, unknown> = {
      info: effectiveInfo,
      parts: envelope?.parts ?? [],
      v2: rawAssistant,
      ...(rawIdle ? { idle: rawIdle } : {}),
    };

    if (effectiveWaitOutcome.status === "interrupted" && effectiveInfo["error"] == null) {
      return {
        outcome: {
          summary,
          ...(usage ? { usage } : {}),
          costUsd,
          status: "aborted",
          errorCode: "aborted",
          errorMessage: "The turn was interrupted.",
        },
        terminalRaw,
      };
    }

    if (effectiveWaitOutcome.status === "failed" && effectiveInfo["error"] != null && !effectiveInfo["finish"]) {
      const msg = v2ErrorMessage(effectiveInfo["error"]) || JSON.stringify(effectiveInfo["error"]);
      return {
        outcome: {
          summary,
          ...(usage ? { usage } : {}),
          costUsd,
          status: "failed",
          errorCode: "agent_error",
          errorMessage: msg,
        },
        terminalRaw,
      };
    }

    const term = terminalOutcome(effectiveInfo, summary != null && summary.trim().length > 0);
    if (term.incomplete && rawAssistant) await this.emitIncompleteNote(effectiveInfo);
    return {
      outcome: {
        summary,
        ...(usage ? { usage } : {}),
        costUsd,
        status: term.status,
        errorCode: term.errorCode,
        errorMessage: term.errorMessage,
      },
      terminalRaw,
    };
  }

  /**
   * Surface a turn that ended with no reply as a visible assistant note. The
   * stable `:incomplete` event id is shared with the reconcile path
   * (`historicalEvents`) so a later catch-up dedups against this live note
   * instead of duplicating it.
   *
   * This is library-authored prose, not model output. It is emitted as
   * `type: "assistant"` because that is the only surface a host renders, and is
   * tagged `raw.synthetic: "incomplete_turn"`. A host that replays transcript
   * history back into a model (context rebuilding, summarization) should filter
   * events carrying `raw.synthetic` so this note is never fed back as assistant
   * turn content.
   */
  private async emitIncompleteNote(info: Record<string, unknown>): Promise<void> {
    const messageId = str(info["id"]);
    await this.emit({
      type: "assistant",
      text: incompleteTurnMessage(str(info["finish"])),
      timestamp: new Date().toISOString(),
      providerType: "opencode",
      sessionId: this._sessionId,
      messageId,
      eventId: messageId ? `${messageId}:incomplete` : null,
      turnId: null,
      parentToolCallId: null,
      raw: { synthetic: "incomplete_turn", info },
    });
  }

  private async emitTerminal(
    outcome: TurnResult,
    raw: Record<string, unknown>,
    startedAt: number,
  ): Promise<void> {
    const info = rec(raw["info"]);
    const messageId = info ? str(info["id"]) : null;
    await this.emit({
      type: "result",
      text: outcome.summary ?? outcome.errorMessage ?? "",
      costUsd: outcome.costUsd,
      isError: outcome.status !== "completed",
      stopReason: null,
      terminalReason: outcome.status,
      numTurns: 1,
      durationMs: Date.now() - startedAt,
      timestamp: new Date().toISOString(),
      providerType: "opencode",
      sessionId: this._sessionId,
      messageId,
      // Match the reconcile path's `${messageId}:result` id so the live and
      // catch-up terminal markers dedup instead of both landing as rows.
      eventId: messageId ? `${messageId}:result` : null,
      turnId: null,
      parentToolCallId: null,
      raw,
    });
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
      const path = this.isV2
        ? `/api/session/${encodeURIComponent(this._sessionId)}/interrupt`
        : `/session/${this._sessionId}/abort`;
      await this.client?.ok(path, { method: "POST" });
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
    this._inputAbort.abort("closed");
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
    if (this._pendingPoll) clearInterval(this._pendingPoll);
    this._pendingPoll = null;
    if (this.server) {
      this.server.release();
      this.server = null;
    }
    await this._skillConfigCleanup?.();
    this._skillConfigCleanup = null;
    this.client = null;
  }

  describeHistory() {
    if (!this._sessionId) return null;
    return createSessionRecord({
      providerType: "opencode",
      params: { sessionId: this._sessionId, cwd: this.cwd },
      cwd: this.cwd,
      displayId: this._sessionId,
    });
  }
}
