import type {
  ClearGoalResult,
  GoalCapability,
  GoalOptions,
  GoalSentinel,
  GoalState,
  SendHandle,
  SetGoalResult,
  StreamEvent,
  TurnResult,
} from "../types.js";
import {
  GOAL_OBJECTIVE_MAX,
  type GoalStatusEvent,
  type NormalizedGoalFields,
  goalStateFromEvent,
  isTerminalGoalStatus,
} from "./normalize.js";
import {
  buildKickoffMessage,
  createDefaultSentinel,
  defaultNudge,
  runSentinel,
} from "./sentinel.js";

/**
 * Everything a session must supply so the `GoalController` can run goals on its
 * behalf. The two wiring seams every session already has — an event-dispatch
 * point and a turn-settle point — are exposed via `dispatch` and the session
 * calling `observe`/`onTurnSettled`.
 */
export interface GoalControllerDeps {
  /** Provider type, for `goal_status` event base fields + display. */
  providerType: string;
  /** Current session/thread id for event base fields. */
  getSessionId: () => string | null;
  /**
   * Drive one turn — a continuation, the initial kickoff, the default
   * sentinel's meta-turn, or (for native providers) the `/goal` command itself.
   * Usually `session.send` bound to the session.
   */
  send: (message: string) => Promise<SendHandle>;
  /**
   * Push a synthetic `goal_status` event to the host through the SAME channel
   * the session uses for parsed events. Only the controller calls this, and
   * only for emulation transitions — native transitions come from the parser.
   */
  dispatch: (event: StreamEvent) => void;
  /** Transcript path for sentinel context. */
  getTranscriptPath?: () => string | null;
  /** This provider's goal capability (undefined → treated as emulated). */
  capability?: GoalCapability;
  /**
   * Native arm. Implement for providers with native goal support (Claude sends
   * `/goal <objective>`; Codex seeds thread state). Return true if armed
   * natively — the controller then relies on parser-emitted `goal_status`
   * events and does NOT run the emulation loop. Return false to fall back to
   * emulation. Only invoked for `enforce:"provider"` with no custom sentinel.
   */
  armNative?: (objective: string) => Promise<boolean>;
  /** Native clear (Claude sends `/goal clear`; Codex clears thread state). */
  clearNative?: (reason: "cleared" | "blocked") => Promise<void>;
}

type Mode = "idle" | "native" | "emulate" | "advisory";

/**
 * Capability descriptor for providers with no native goal surface. The library
 * emulation engine enforces the goal via a sentinel + continuation loop.
 */
export const EMULATED_GOAL_CAPABILITY: GoalCapability = {
  mechanism: "emulated",
  enforced: true,
  statuses: ["active", "paused", "met", "blocked", "cleared"],
  clears: "manual",
  telemetry: false,
};

function nowIso(): string {
  return new Date().toISOString();
}

async function safeBool(p: Promise<boolean>): Promise<boolean> {
  try {
    return await p;
  } catch {
    return false;
  }
}

/**
 * Provider-agnostic goal engine. Each session constructs one and delegates
 * `setGoal`/`clearGoal`/`getGoal` to it, calls `observe(event)` for every
 * normalized event it dispatches, and `onTurnSettled(result)` whenever a turn
 * resolves. See internal-docs/spec-goals.md §8.
 */
export class GoalController {
  private state: GoalState | null = null;
  private mode: Mode = "idle";
  private sentinel: GoalSentinel | null = null;
  private maxIterations = 12;
  private iterations = 0;
  /** Guards re-entrancy: meta/nested settles during evaluation are ignored. */
  private evaluating = false;
  /** One-shot: skip advancing the loop for the next settle (set on interrupt). */
  private suspendNext = false;
  /** Bumped on every set/clear so a stale in-flight loop cancels itself. */
  private generation = 0;

  constructor(private readonly deps: GoalControllerDeps) {}

  getGoal(): GoalState | null {
    return this.state;
  }

  /**
   * True when a non-terminal goal is active. Sessions use this to decide whether
   * to parse + `observe()` native goal events even when the host attached no
   * `onEvent` handler — so `getGoal()` stays accurate without a subscriber.
   */
  isTracking(): boolean {
    return this.state !== null && !isTerminalGoalStatus(this.state.status);
  }

  /**
   * Signal that the active turn was interrupted/aborted by the host. For an
   * emulated goal this pauses the loop for one settle so the interrupt doesn't
   * immediately trigger a fresh continuation turn. The goal stays active; the
   * next normal turn (or a new setGoal) resumes it. clearGoal() abandons it.
   */
  notifyInterrupted(): void {
    if (this.mode === "emulate") this.suspendNext = true;
  }

  /**
   * Restore goal state on resume — reporting only. Use with `goalStateFromEvent`
   * / `latestGoalFromEvents` after reading a resumed session's transcript so
   * `getGoal()` reflects the prior goal. To resume ENFORCEMENT (re-arm the
   * sentinel/loop), call `setGoal` again; hydrate does not restart the loop.
   */
  hydrate(state: GoalState): void {
    this.state = state;
    this.mode = "idle";
  }

  async setGoal(objective: string, options: GoalOptions = {}): Promise<SetGoalResult> {
    if (typeof objective !== "string" || objective.trim() === "") {
      throw new Error("setGoal: objective must be a non-empty string");
    }
    if (objective.length > GOAL_OBJECTIVE_MAX) {
      throw new RangeError(
        `setGoal: objective exceeds ${GOAL_OBJECTIVE_MAX} chars (got ${objective.length}); point the goal at a file instead`,
      );
    }

    // Replace any active goal — emit a synthetic `cleared` for the old one.
    if (this.state && !isTerminalGoalStatus(this.state.status)) {
      this.transition({
        objective: this.state.objective,
        status: "cleared",
        met: false,
        enforced: this.state.enforced,
        source: "host",
      });
    }

    this.generation++;
    const gen = this.generation;
    this.iterations = 0;
    this.maxIterations = options.maxIterations ?? 12;
    this.sentinel = null;
    this.suspendNext = false;

    const enforce = options.enforce ?? "provider";
    const cap = this.deps.capability;
    const customSentinel = options.sentinel;

    // --- advisory: record only, never gate ---
    if (enforce === "advisory") {
      this.mode = "advisory";
      // Best-effort seed native state so a model-tools provider still "knows"
      // the goal, but without any enforcement loop.
      let nativeSeeded = false;
      if (cap?.mechanism === "model-tools" && this.deps.armNative) {
        nativeSeeded = await safeBool(this.deps.armNative(objective));
      }
      if (gen !== this.generation) return { armed: false, mechanism: "emulated" };
      if (nativeSeeded) {
        // The native provider will emit its own `active` goal_status; set
        // optimistic state WITHOUT dispatching (mirrors native mode) so the host
        // doesn't see a duplicate `active`.
        this.state = {
          objective,
          status: "active",
          met: false,
          enforced: false,
          source: "host",
          updatedAt: nowIso(),
        };
      } else {
        this.transition({
          objective,
          status: "active",
          met: false,
          enforced: false,
          source: "host",
        });
      }
      return { armed: true, mechanism: cap?.mechanism ?? "emulated" };
    }

    // --- native passthrough (default, no custom sentinel) ---
    const wantNative = enforce === "provider" && !customSentinel && !!this.deps.armNative;
    if (wantNative) {
      const armed = await safeBool(this.deps.armNative!(objective));
      if (gen !== this.generation) return { armed: false, mechanism: "emulated" };
      if (armed) {
        this.mode = "native";
        // Native providers emit goal_status through their parser; set optimistic
        // state for immediate getGoal() and let `observe` reconcile. Do NOT
        // dispatch here (the parser is the sole emitter in native mode).
        this.state = {
          objective,
          status: "active",
          met: false,
          enforced: cap?.enforced ?? true,
          source: "host",
          updatedAt: nowIso(),
        };
        return {
          armed: true,
          mechanism: cap?.mechanism === "model-tools" ? "model-tools" : "sentinel",
        };
      }
      // Native arm failed → fall through to emulation.
    }

    // --- emulation (forced, custom sentinel, or native fallback) ---
    this.mode = "emulate";
    this.sentinel = customSentinel ?? this.makeDefaultSentinel();
    this.transition({
      objective,
      status: "active",
      met: false,
      enforced: true,
      source: "agentex",
    });
    this.kickoff(objective, gen);
    return { armed: true, mechanism: "emulated" };
  }

  async clearGoal(options: { reason?: "cleared" | "blocked" } = {}): Promise<ClearGoalResult> {
    if (!this.state || isTerminalGoalStatus(this.state.status)) {
      return { cleared: false };
    }
    const reason = options.reason ?? "cleared";
    const objective = this.state.objective;
    const enforced = this.state.enforced;
    const wasNative = this.mode === "native";

    this.generation++; // cancel any in-flight emulation loop
    this.mode = "idle";
    this.sentinel = null;

    if (wasNative && this.deps.clearNative) {
      await this.deps.clearNative(reason).catch(() => {});
      if (reason === "blocked") {
        // Native providers (e.g. Codex) have no host-asserted "blocked" — their
        // clear emits a `cleared` notification. Emit `blocked` synthetically so
        // the host sees the intended terminal state; the observe terminal-guard
        // then ignores the provider's trailing `cleared`.
        this.transition({
          objective,
          status: "blocked",
          met: false,
          enforced,
          source: "host",
          blockedReason: "needs_input",
        });
      } else {
        // Cleared: rely on the provider's authoritative `cleared` notification;
        // set optimistic state (no dispatch) so getGoal() is immediate.
        this.state = {
          objective,
          status: "cleared",
          met: false,
          enforced,
          source: "host",
          updatedAt: nowIso(),
        };
      }
      return { cleared: true };
    }

    const fields: NormalizedGoalFields = {
      objective,
      status: reason === "blocked" ? "blocked" : "cleared",
      met: false,
      enforced,
      source: "host",
    };
    if (reason === "blocked") fields.blockedReason = "needs_input";
    this.transition(fields);
    return { cleared: true };
  }

  /**
   * Called by the session for every normalized event it dispatches to the host.
   * In native mode the parser is the source of truth for goal_status; adopt it.
   */
  observe(event: StreamEvent): void {
    if (event.type !== "goal_status") return;
    // Once a goal is terminal, suppress stale late events FOR THE SAME goal (a
    // clear-time `active`, or a `cleared` after a host-driven `blocked`) so they
    // can't resurrect/downgrade it — but accept a genuinely NEW goal (a
    // different, non-empty objective, e.g. the model created another).
    if (this.state && isTerminalGoalStatus(this.state.status)) {
      const isNewGoal = !!event.objective && event.objective !== this.state.objective;
      if (!isNewGoal) return;
    }
    let next = goalStateFromEvent(event);
    // Defensive: a provider's terminal event (e.g. Codex `thread/goal/cleared`)
    // may omit the objective. Don't let an empty objective erase the known one.
    if (!next.objective && this.state?.objective) {
      next = { ...next, objective: this.state.objective };
    }
    this.state = next;
    if (isTerminalGoalStatus(next.status)) {
      this.mode = "idle";
      this.sentinel = null;
    }
  }

  /**
   * Called by the session whenever a turn settles. Only the emulation engine
   * acts here; native/advisory goals are driven by provider events.
   */
  async onTurnSettled(turn: TurnResult): Promise<void> {
    if (this.mode !== "emulate") return;
    if (this.evaluating) return; // ignore the default sentinel's meta-turn + nested settles
    if (this.suspendNext) { this.suspendNext = false; return; } // interrupted → pause one turn
    if (turn.status !== "completed") return; // aborted/timeout/failed/max_* → don't advance
    if (!this.state || isTerminalGoalStatus(this.state.status)) return;
    if (!this.sentinel) return;

    const gen = this.generation;
    const objective = this.state.objective;
    this.evaluating = true;
    try {
      const verdict = await runSentinel(this.sentinel, {
        objective,
        lastTurn: turn,
        transcriptPath: this.deps.getTranscriptPath?.() ?? null,
        iterations: this.iterations,
      });
      if (gen !== this.generation) return; // goal replaced/cleared during eval

      if (verdict.met) {
        this.transition({
          objective,
          status: "met",
          met: true,
          enforced: true,
          source: "sentinel",
        });
        this.mode = "idle";
        this.sentinel = null;
        return;
      }

      this.iterations++;
      if (this.iterations >= this.maxIterations) {
        this.transition({
          objective,
          status: "blocked",
          met: false,
          enforced: true,
          source: "agentex",
          blockedReason: "max_iterations",
        });
        this.mode = "idle";
        this.sentinel = null;
        return;
      }

      // Drive one continuation turn. Don't await its result — its own settle
      // re-enters onTurnSettled and continues the loop.
      const nudge = verdict.nudge ?? defaultNudge(objective, this.iterations);
      void this.deps.send(nudge).catch(() => {});
    } finally {
      this.evaluating = false;
    }
  }

  // ---- internals ----

  private kickoff(objective: string, gen: number): void {
    if (gen !== this.generation) return;
    void this.deps.send(buildKickoffMessage(objective)).catch(() => {});
  }

  private makeDefaultSentinel(): GoalSentinel {
    return createDefaultSentinel({
      metaSend: async (message) => {
        const handle = await this.deps.send(message);
        return handle.result;
      },
    });
  }

  /** Build, record, and dispatch a synthetic goal_status transition. */
  private transition(fields: NormalizedGoalFields): void {
    const event = this.buildEvent(fields);
    this.state = goalStateFromEvent(event);
    this.deps.dispatch(event);
  }

  private buildEvent(fields: NormalizedGoalFields): GoalStatusEvent {
    const event: GoalStatusEvent = {
      type: "goal_status",
      objective: fields.objective,
      status: fields.status,
      met: fields.met,
      enforced: fields.enforced,
      source: fields.source,
      timestamp: nowIso(),
      providerType: this.deps.providerType,
      sessionId: this.deps.getSessionId(),
      messageId: null,
      eventId: null,
      turnId: null,
      parentToolCallId: null,
      raw: { synthetic: "goal", ...fields },
    };
    if (fields.blockedReason !== undefined) event.blockedReason = fields.blockedReason;
    if (fields.tokensUsed !== undefined) event.tokensUsed = fields.tokensUsed;
    if (fields.timeUsedSeconds !== undefined) event.timeUsedSeconds = fields.timeUsedSeconds;
    if (fields.tokenBudget !== undefined) event.tokenBudget = fields.tokenBudget;
    if (this.mode === "emulate") event.iterations = this.iterations;
    return event;
  }
}
