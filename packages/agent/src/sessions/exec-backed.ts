import type {
  AgentSession,
  CancelResult,
  ClearGoalResult,
  ExecutionContext,
  ExecutionResult,
  GoalOptions,
  GoalState,
  ProviderCapabilities,
  SendHandle,
  SendOptions,
  SessionCodec,
  SessionContext,
  SessionState,
  SetGoalResult,
  StopTaskResult,
  StreamEvent,
  TurnResult,
} from "../types.js";
import { GoalController, EMULATED_GOAL_CAPABILITY } from "../goals/index.js";
import { uuidv7 } from "../utils/uuid.js";

export interface ExecBackedSessionOptions {
  providerType: string;
  execute(ctx: ExecutionContext): Promise<ExecutionResult>;
  sessionCodec: SessionCodec;
  ctx: SessionContext;
  capabilities?: Pick<ProviderCapabilities, "goals">;
}

function turnResult(result: ExecutionResult): TurnResult {
  return {
    summary: result.summary,
    ...(result.usage ? { usage: result.usage } : {}),
    costUsd: result.costUsd,
    status: result.status === "blocked" ? "failed" : result.status,
    errorCode: result.errorCode,
    errorMessage: result.errorMessage,
  };
}

export function createExecBackedSession(options: ExecBackedSessionOptions): AgentSession {
  return new ExecBackedSession(options);
}

class ExecBackedSession implements AgentSession {
  private _state: SessionState = "idle";
  private params: Record<string, unknown> | null;
  private active: AbortController | null = null;
  private inFlight: Promise<TurnResult> | null = null;
  private draining = false;
  private readonly goals: GoalController;

  constructor(private readonly options: ExecBackedSessionOptions) {
    this.params = options.sessionCodec.deserialize(options.ctx.sessionParams ?? null);
    this.goals = new GoalController({
      providerType: options.providerType,
      capability: options.capabilities?.goals ?? EMULATED_GOAL_CAPABILITY,
      getSessionId: () => this.sessionId,
      send: (message) => this.send(message),
      dispatch: (event) => void Promise.resolve(options.ctx.onEvent?.(event)).catch(() => undefined),
    });
    if (options.ctx.signal) {
      if (options.ctx.signal.aborted) void this.close();
      else options.ctx.signal.addEventListener("abort", () => void this.close(), { once: true });
    }
  }

  get sessionId(): string | null {
    return this.options.sessionCodec.getDisplayId?.(this.params) ?? null;
  }

  get state(): SessionState {
    return this._state;
  }

  async send(message: string, sendOptions?: SendOptions): Promise<SendHandle> {
    if (this._state === "closed") throw new Error("Session is closed");
    if (this.draining) throw new Error("Session is draining");
    if (this.inFlight) throw new Error(`${this.options.providerType} session is busy`);
    const uuid = uuidv7();
    const result = this.run(message, sendOptions);
    this.inFlight = result;
    void result.then((settled) => this.goals.onTurnSettled(settled)).catch(() => undefined);
    return { uuid, result };
  }

  private async run(message: string, sendOptions?: SendOptions): Promise<TurnResult> {
    this._state = "thinking";
    const controller = new AbortController();
    this.active = controller;
    const onAbort = () => controller.abort();
    sendOptions?.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const result = await this.options.execute({
        prompt: message,
        cwd: this.options.ctx.cwd,
        env: this.options.ctx.env,
        config: {
          ...this.options.ctx.config,
          ...(sendOptions?.timeoutSec !== undefined ? { timeoutSec: sendOptions.timeoutSec } : {}),
        },
        sessionParams: this.params,
        signal: controller.signal,
        onOutput: this.options.ctx.onOutput,
        onLifecycle: (event) => this.options.ctx.onLifecycle?.(event),
        onEvent: async (event: StreamEvent) => {
          if (event.sessionId) {
            this.params = this.options.sessionCodec.serialize({
              sessionId: event.sessionId,
              ...(this.options.ctx.cwd ? { cwd: this.options.ctx.cwd } : {}),
            });
          }
          if (event.type === "tool_call") this._state = "tool_executing";
          else if (event.type === "assistant" || event.type === "thinking") this._state = "thinking";
          await this.options.ctx.onEvent?.(event);
        },
      });
      if (result.clearSession) this.params = null;
      if (result.sessionParams) this.params = this.options.sessionCodec.serialize(result.sessionParams);
      return turnResult(result);
    } finally {
      sendOptions?.signal?.removeEventListener("abort", onAbort);
      this.active = null;
      this.inFlight = null;
      this.restoreIdle();
    }
  }

  private restoreIdle(): void {
    if (this._state !== "closed") this._state = "idle";
  }

  async cancel(_uuid: string): Promise<CancelResult> {
    return { cancelled: false };
  }

  async stopTask(_taskId: string): Promise<StopTaskResult> {
    return { stopped: false };
  }

  setGoal(objective: string, goalOptions?: GoalOptions): Promise<SetGoalResult> {
    return this.goals.setGoal(objective, goalOptions);
  }

  clearGoal(clearOptions?: { reason?: "cleared" | "blocked" }): Promise<ClearGoalResult> {
    return this.goals.clearGoal(clearOptions);
  }

  getGoal(): GoalState | null {
    return this.goals.getGoal();
  }

  async interrupt(): Promise<void> {
    this.active?.abort();
  }

  async drain(): Promise<void> {
    this.draining = true;
    if (this.inFlight) await this.inFlight.catch(() => undefined);
    await this.close();
  }

  async close(): Promise<void> {
    this._state = "closed";
    this.active?.abort();
    if (this.inFlight) await this.inFlight.catch(() => undefined);
  }
}
