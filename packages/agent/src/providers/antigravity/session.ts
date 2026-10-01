import type {
  AgentSession,
  CancelResult,
  ClearGoalResult,
  GoalOptions,
  GoalState,
  SendHandle,
  SendOptions,
  SessionContext,
  SessionState,
  SetGoalResult,
  StopTaskResult,
  StreamEvent,
  TurnResult,
  TurnTrigger,
} from "../../types.js";
import { GoalController, EMULATED_GOAL_CAPABILITY } from "../../goals/index.js";
import type { ResolvedBinary } from "../../utils/binary.js";
import { buildEnv, ensurePathInEnv } from "../../utils/env.js";
import { resolveInstructions } from "../../utils/instructions.js";
import { injectHomeSkills } from "../../utils/skills.js";
import { uuidv7 } from "../../utils/uuid.js";
import {
  AgyConnection,
  firstAgyErrorLine,
  interruptAgyTurn,
  type AgyTurnOutcome,
} from "./connection.js";
import {
  ANTIGRAVITY_PROVIDER_TYPE,
  AgyStreamParser,
  agyUsageRecord,
  classifyAgyFailure,
  mapAgyTurnStatus,
} from "./parse.js";
import { AGY_SIGN_IN_MESSAGE, buildAgyArgs, findAgyBinary, readAgyResumeId } from "./runtime.js";

interface ActiveTurn {
  turnId: string;
  abort: AbortController;
  done: Promise<TurnResult>;
}

/**
 * Open a multi-turn Antigravity session. Throws when `agy` is not installed.
 * The process starts on the first `send()`.
 */
export async function createAntigravitySession(ctx: SessionContext): Promise<AgentSession> {
  const binary = await findAgyBinary(ctx);
  const config = ctx.config ?? {};
  const instructions = await resolveInstructions(config.instructionsFile);
  if (config.skillDirs && config.skillDirs.length > 0) {
    try {
      await injectHomeSkills(config.skillDirs, "antigravity");
    } catch {
      // Non-fatal
    }
  }
  return new AntigravitySession(ctx, binary, instructions);
}

/**
 * One `agy --input-format stream-json --output-format stream-json` process
 * holds the conversation across turns. The CLI has no control protocol, so
 * an interrupt is a SIGINT (Ctrl+C); when that ends the process, the next
 * `send()` starts a new one on the same conversation with `--conversation`.
 */
class AntigravitySession implements AgentSession {
  private _state: SessionState = "idle";
  private conversationId: string | null;
  private connection: AgyConnection | null = null;
  private parser: AgyStreamParser | null = null;
  private active: ActiveTurn | null = null;
  /** Events received from agy processes, to tell whether one saw a message. */
  private connectionEvents = 0;
  private draining = false;
  /** Instructions go into the first message of a conversation this session starts. */
  private pendingInstructions: string | null;
  private readonly cwd: string;
  private readonly goals: GoalController;

  constructor(
    private readonly ctx: SessionContext,
    private readonly binary: ResolvedBinary,
    instructions: string | null,
  ) {
    this.cwd = ctx.cwd ?? process.cwd();
    this.conversationId = readAgyResumeId(ctx.sessionParams, this.cwd);
    this.pendingInstructions = this.conversationId ? null : instructions;
    this.goals = new GoalController({
      providerType: ANTIGRAVITY_PROVIDER_TYPE,
      capability: EMULATED_GOAL_CAPABILITY,
      getSessionId: () => this.sessionId,
      send: (message) => this.send(message),
      dispatch: (event) => void this.dispatch(event),
    });
    if (ctx.signal) {
      if (ctx.signal.aborted) void this.close();
      else ctx.signal.addEventListener("abort", () => void this.close(), { once: true });
    }
  }

  get sessionId(): string | null {
    return this.parser?.conversationId ?? this.conversationId;
  }

  get state(): SessionState {
    return this._state;
  }

  async send(message: string, options?: SendOptions): Promise<SendHandle> {
    if (this._state === "closed") throw new Error("Session is closed");
    if (this.draining) throw new Error("Session is draining — no new sends accepted");
    if (this.active) {
      throw new Error("Antigravity session is busy — a turn is already in progress (concurrentSend not supported)");
    }

    const uuid = uuidv7();
    const turnId = uuidv7();
    const abort = new AbortController();
    const text = this.pendingInstructions ? `${this.pendingInstructions}\n\n${message}` : message;
    this.pendingInstructions = null;

    this._state = "thinking";
    const done = this.runTurn(text, turnId, abort, options);
    this.active = { turnId, abort, done };
    void done.then((result) => this.goals.onTurnSettled(result)).catch(() => undefined);
    return { uuid, result: done };
  }

  private ensureConnection(): AgyConnection {
    if (this.connection?.alive) return this.connection;
    const config = this.ctx.config ?? {};
    // A replacement process picks the conversation back up where it stopped.
    this.conversationId = this.sessionId;
    const parser = new AgyStreamParser({
      includePartialMessages: config.includePartialMessages,
      conversationId: this.conversationId,
    });
    const env = buildEnv(this.ctx.env);
    ensurePathInEnv(env);
    this.ctx.onLifecycle?.({ phase: "spawning" });
    const connection = new AgyConnection({
      command: this.binary.bin,
      args: [
        ...this.binary.prefixArgs,
        ...buildAgyArgs(config, { resumeId: this.conversationId, model: config.model ?? null }),
      ],
      cwd: this.cwd,
      env,
      parser,
      // Lines a replaced process prints on its way out belong to no turn.
      onEvent: async (event): Promise<void> => {
        if (this.connection === connection) await this.onEvent(event);
      },
      ...(this.ctx.onOutput ? { onOutput: this.ctx.onOutput } : {}),
    });
    if (connection.pid != null) this.ctx.onLifecycle?.({ phase: "running", pid: connection.pid });
    this.connection = connection;
    this.parser = parser;
    return connection;
  }

  private async runTurn(
    text: string,
    turnId: string,
    abort: AbortController,
    options?: SendOptions,
  ): Promise<TurnResult> {
    await this.emitTurnEdge({ type: "turn_start", turnId, trigger: "send" });

    const timeoutSec = options?.timeoutSec ?? this.ctx.config?.timeoutSec;
    const graceSec = this.ctx.config?.graceSec;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const guards: Promise<"timeout" | "aborted">[] = [
      new Promise((resolve) => abort.signal.addEventListener("abort", () => resolve("aborted"), { once: true })),
    ];
    if (timeoutSec && timeoutSec > 0) {
      guards.push(new Promise((resolve) => { timer = setTimeout(() => resolve("timeout"), timeoutSec * 1000); }));
    }
    const onSendAbort = () => abort.abort();
    if (options?.signal) {
      if (options.signal.aborted) abort.abort();
      else options.signal.addEventListener("abort", onSendAbort, { once: true });
    }

    let connection = this.ensureConnection();
    try {
      let result: TurnResult | null = null;
      let reason: "result" | "cancelled" | "session_closed" = "result";
      for (let attempt = 0; result === null; attempt++) {
        const eventsBefore = this.connectionEvents;
        const pending = connection.nextTurn();
        connection.write(text);
        const first = await Promise.race([pending, ...guards]);
        if (first === "timeout" || first === "aborted") {
          const outcome = await interruptAgyTurn(connection, pending, graceSec);
          // agy may report INTERRUPTED and then exit. Learn which before the
          // next send, so it never lands on a process that is going away.
          if (outcome?.result) await connection.waitForExit(500);
          // Without an INTERRUPTED result the process was stopped; a late result
          // from it must never settle the next turn.
          if ((!outcome?.result || !connection.alive) && this.connection === connection) this.connection = null;
          result = {
            summary: outcome?.result?.response.trim() || null,
            ...this.usageOf(outcome),
            costUsd: null,
            status: first,
            errorCode: first,
            errorMessage: first === "timeout" ? "Turn exceeded its timeout" : "Turn aborted",
          };
          reason = "cancelled";
        } else if (
          attempt === 0 && !first.result && first.exited && !first.authRequired
          && this.connectionEvents === eventsBefore && this._state !== "closed"
        ) {
          // The process exited without ever acknowledging the message (it was
          // already shutting down). Run it on a fresh process for the same
          // conversation instead of failing a turn agy never started.
          if (this.connection === connection) this.connection = null;
          connection = this.ensureConnection();
        } else {
          result = this.toTurnResult(first);
          reason = first.result ? "result" : "session_closed";
        }
      }
      await this.emitTurnEdge({ type: "turn_end", turnId, trigger: "send", reason });
      return result;
    } finally {
      if (timer) clearTimeout(timer);
      options?.signal?.removeEventListener("abort", onSendAbort);
      this.active = null;
      if (!connection.alive && this.connection === connection) this.connection = null;
      if (this._state !== "closed") this._state = "idle";
    }
  }

  private usageOf(outcome: AgyTurnOutcome | null): { usage?: TurnResult["usage"] } {
    const usage = agyUsageRecord(outcome?.result?.turnUsage ?? null, this.parser?.model ?? this.ctx.config?.model ?? null);
    return usage ? { usage } : {};
  }

  private toTurnResult(outcome: AgyTurnOutcome): TurnResult {
    const { result } = outcome;
    if (result) {
      const status = mapAgyTurnStatus(result.status);
      if (status === "completed") {
        return { summary: result.response.trim() || null, ...this.usageOf(outcome), costUsd: null, status, errorCode: null, errorMessage: null };
      }
      const errorCode = status === "aborted"
        ? "aborted"
        : outcome.authRequired ? "auth_required" : classifyAgyFailure(result, outcome.agyError);
      return {
        summary: result.response.trim() || null,
        ...this.usageOf(outcome),
        costUsd: null,
        status,
        errorCode,
        errorMessage: errorCode === "auth_required"
          ? AGY_SIGN_IN_MESSAGE
          : result.error ?? outcome.agyError?.message ?? `Antigravity turn ended with ${result.status}`,
      };
    }
    if (outcome.authRequired) {
      return { summary: null, costUsd: null, status: "failed", errorCode: "auth_required", errorMessage: AGY_SIGN_IN_MESSAGE };
    }
    return {
      summary: null,
      costUsd: null,
      status: "failed",
      errorCode: "process_exited",
      errorMessage: outcome.agyError?.message
        ?? firstAgyErrorLine(outcome.stderr)
        ?? `Antigravity CLI exited (code ${outcome.exitCode ?? "null"}${outcome.signal ? `, ${outcome.signal}` : ""}) before finishing the turn`,
    };
  }

  private async onEvent(event: StreamEvent): Promise<void> {
    this.connectionEvents++;
    if (this._state !== "closed") {
      if (event.type === "tool_call") this._state = "tool_executing";
      else if (event.type === "assistant" || event.type === "thinking" || event.type === "tool_result") this._state = "thinking";
    }
    await this.dispatch(event);
  }

  private async emitTurnEdge(
    edge:
      | { type: "turn_start"; turnId: string; trigger: TurnTrigger }
      | { type: "turn_end"; turnId: string; trigger: TurnTrigger; reason: "result" | "cancelled" | "session_closed" },
  ): Promise<void> {
    await this.dispatch({
      ...edge,
      timestamp: new Date().toISOString(),
      providerType: ANTIGRAVITY_PROVIDER_TYPE,
      sessionId: this.sessionId,
      messageId: null,
      eventId: null,
      parentToolCallId: null,
      raw: {},
    } as StreamEvent);
  }

  private async dispatch(event: StreamEvent): Promise<void> {
    if (!this.ctx.onEvent) return;
    try {
      await this.ctx.onEvent(event);
    } catch {
      /* a throwing handler must not break the stream */
    }
  }

  async cancel(_uuid: string): Promise<CancelResult> {
    // One message per turn and no queue, so there is never a queued message to drop.
    return { cancelled: false };
  }

  async stopTask(_taskId: string): Promise<StopTaskResult> {
    return { stopped: false };
  }

  setGoal(objective: string, options?: GoalOptions): Promise<SetGoalResult> {
    return this.goals.setGoal(objective, options);
  }

  clearGoal(options?: { reason?: "cleared" | "blocked" }): Promise<ClearGoalResult> {
    return this.goals.clearGoal(options);
  }

  getGoal(): GoalState | null {
    return this.goals.getGoal();
  }

  async interrupt(): Promise<void> {
    const active = this.active;
    if (!active) return;
    active.abort.abort();
    await active.done.catch(() => undefined);
  }

  async drain(): Promise<void> {
    this.draining = true;
    if (this.active) await this.active.done.catch(() => undefined);
    await this.close();
  }

  async close(): Promise<void> {
    if (this._state === "closed" && !this.connection) return;
    this._state = "closed";
    const active = this.active;
    if (active) {
      active.abort.abort();
      await active.done.catch(() => undefined);
    }
    const connection = this.connection;
    this.connection = null;
    if (connection) await connection.terminate(this.ctx.config?.graceSec);
  }
}
