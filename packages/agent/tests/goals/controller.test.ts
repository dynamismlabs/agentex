import { describe, it, expect } from "vitest";
import type { GoalCapability, SendHandle, StreamEvent, TurnResult } from "../../src/index.js";
import { GoalController } from "../../src/index.js";

type GoalEvent = Extract<StreamEvent, { type: "goal_status" }>;

function completedTurn(summary = "did work"): TurnResult {
  return { summary, costUsd: null, status: "completed", errorCode: null, errorMessage: null };
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

function parserGoalEvent(over: Partial<GoalEvent>): GoalEvent {
  return {
    type: "goal_status",
    objective: "g",
    status: "met",
    met: true,
    enforced: true,
    source: "sentinel",
    timestamp: "2026-06-25T00:00:00.000Z",
    providerType: "test",
    sessionId: "s",
    messageId: null,
    eventId: null,
    turnId: null,
    parentToolCallId: null,
    raw: {},
    ...over,
  };
}

interface HarnessOpts {
  capability?: GoalCapability;
  armNative?: (objective: string) => Promise<boolean>;
  clearNative?: (reason: "cleared" | "blocked") => Promise<void>;
}

function makeHarness(opts: HarnessOpts = {}) {
  const events: GoalEvent[] = [];
  const sends: string[] = [];
  const controller = new GoalController({
    providerType: "test",
    ...(opts.capability ? { capability: opts.capability } : {}),
    getSessionId: () => "sess-1",
    send: (m: string): Promise<SendHandle> => {
      sends.push(m);
      // result never resolves on its own — tests drive onTurnSettled manually.
      return Promise.resolve({ uuid: "u", result: new Promise<TurnResult>(() => {}) });
    },
    dispatch: (ev: StreamEvent) => {
      if (ev.type === "goal_status") events.push(ev);
    },
    ...(opts.armNative ? { armNative: opts.armNative } : {}),
    ...(opts.clearNative ? { clearNative: opts.clearNative } : {}),
  });
  return { controller, events, sends };
}

const SENTINEL_CAP: GoalCapability = {
  mechanism: "sentinel",
  enforced: true,
  statuses: ["active", "met", "cleared"],
  clears: "both",
  telemetry: false,
};
const MODELTOOLS_CAP: GoalCapability = {
  mechanism: "model-tools",
  enforced: false,
  statuses: ["active", "paused", "met", "blocked", "cleared"],
  clears: "manual",
  telemetry: true,
};

describe("GoalController", () => {
  describe("validation", () => {
    it("rejects an over-long objective with RangeError", async () => {
      const { controller } = makeHarness();
      await expect(controller.setGoal("x".repeat(4001))).rejects.toBeInstanceOf(RangeError);
    });
    it("rejects an empty objective", async () => {
      const { controller } = makeHarness();
      await expect(controller.setGoal("   ")).rejects.toThrow();
    });
  });

  describe("emulation (no native support)", () => {
    it("arms, emits active, and kicks off the first turn with the objective", async () => {
      const { controller, events, sends } = makeHarness();
      const res = await controller.setGoal("make tests pass", { sentinel: () => false });
      expect(res).toEqual({ armed: true, mechanism: "emulated" });
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ status: "active", enforced: true, source: "agentex", objective: "make tests pass" });
      expect(sends).toEqual(["make tests pass"]); // kickoff
      expect(controller.getGoal()?.status).toBe("active");
    });

    it("drives continuation turns until the sentinel reports met", async () => {
      const { controller, events, sends } = makeHarness();
      let calls = 0;
      await controller.setGoal("goal", { sentinel: () => ++calls >= 3 });
      expect(sends).toEqual(["goal"]);

      await controller.onTurnSettled(completedTurn()); // call#1 not met → nudge
      expect(sends).toHaveLength(2);
      expect(controller.getGoal()?.status).toBe("active");

      await controller.onTurnSettled(completedTurn()); // call#2 not met → nudge
      expect(sends).toHaveLength(3);

      await controller.onTurnSettled(completedTurn()); // call#3 met → done, no new send
      expect(sends).toHaveLength(3);
      expect(controller.getGoal()?.status).toBe("met");
      expect(controller.getGoal()?.met).toBe(true);
      expect(events.at(-1)).toMatchObject({ status: "met", source: "sentinel" });
    });

    it("uses a custom nudge from the sentinel verdict", async () => {
      const { controller, sends } = makeHarness();
      await controller.setGoal("goal", { sentinel: () => ({ met: false, nudge: "keep going PLEASE" }) });
      await controller.onTurnSettled(completedTurn());
      expect(sends[1]).toBe("keep going PLEASE");
    });

    it("blocks with max_iterations after the cap", async () => {
      const { controller, events } = makeHarness();
      await controller.setGoal("goal", { sentinel: () => false, maxIterations: 2 });
      await controller.onTurnSettled(completedTurn()); // iter 1
      expect(controller.getGoal()?.status).toBe("active");
      await controller.onTurnSettled(completedTurn()); // iter 2 → cap
      expect(controller.getGoal()).toMatchObject({ status: "blocked", blockedReason: "max_iterations", source: "agentex" });
      expect(events.at(-1)).toMatchObject({ status: "blocked", blockedReason: "max_iterations" });
    });

    it("turns a rejected sentinel into a terminal blocked state", async () => {
      const { controller, events } = makeHarness();
      await controller.setGoal("goal", {
        sentinel: async () => { throw new Error("assessment unavailable"); },
      });

      await expect(controller.onTurnSettled(completedTurn())).resolves.toBeUndefined();
      expect(controller.getGoal()).toMatchObject({
        status: "blocked",
        blockedReason: "sentinel_error",
        errorMessage: "assessment unavailable",
      });
      expect(events.at(-1)).toMatchObject({
        status: "blocked",
        blockedReason: "sentinel_error",
        errorMessage: "assessment unavailable",
      });
    });

    it("stops driving once the goal is cleared mid-loop", async () => {
      const { controller, sends } = makeHarness();
      await controller.setGoal("goal", { sentinel: () => false });
      const before = sends.length;
      await controller.clearGoal();
      await controller.onTurnSettled(completedTurn()); // no-op now
      expect(sends.length).toBe(before);
      expect(controller.getGoal()?.status).toBe("cleared");
    });
  });

  describe("native passthrough", () => {
    it("arms natively, sets optimistic state, emits no synthetic event", async () => {
      const { controller, events, sends } = makeHarness({ capability: SENTINEL_CAP, armNative: async () => true });
      const res = await controller.setGoal("native goal");
      expect(res).toEqual({ armed: true, mechanism: "sentinel" });
      expect(sends).toEqual([]); // armNative handled it; no emulation kickoff
      expect(events).toEqual([]); // parser is the emitter in native mode
      expect(controller.getGoal()).toMatchObject({ status: "active", objective: "native goal" });
    });

    it("reports mechanism model-tools for an advisory native provider", async () => {
      const { controller } = makeHarness({ capability: MODELTOOLS_CAP, armNative: async () => true });
      const res = await controller.setGoal("g");
      expect(res.mechanism).toBe("model-tools");
    });

    it("adopts parser-emitted goal_status via observe", async () => {
      const { controller } = makeHarness({ capability: SENTINEL_CAP, armNative: async () => true });
      await controller.setGoal("g");
      controller.observe(parserGoalEvent({ status: "met", met: true }));
      expect(controller.getGoal()).toMatchObject({ status: "met", met: true });
      // does not run the emulation loop
      const { controller: c2 } = makeHarness({ capability: SENTINEL_CAP, armNative: async () => true });
      await c2.setGoal("g");
      await c2.onTurnSettled(completedTurn()); // native → no-op
      expect(c2.getGoal()?.status).toBe("active");
    });

    it("falls back to emulation when native arm fails", async () => {
      const { controller, sends } = makeHarness({ capability: SENTINEL_CAP, armNative: async () => false });
      const res = await controller.setGoal("g", {});
      expect(res.mechanism).toBe("emulated");
      expect(sends).toEqual(["g"]); // emulation kickoff
    });

    it("a custom sentinel forces emulation even when native is available", async () => {
      const { controller, sends } = makeHarness({ capability: SENTINEL_CAP, armNative: async () => true });
      const res = await controller.setGoal("g", { sentinel: () => true });
      expect(res.mechanism).toBe("emulated");
      expect(sends).toEqual(["g"]);
    });

    it("native clear calls clearNative and does not double-dispatch", async () => {
      let clearCalls = 0;
      const { controller, events } = makeHarness({
        capability: SENTINEL_CAP,
        armNative: async () => true,
        clearNative: async () => { clearCalls++; },
      });
      await controller.setGoal("g");
      const r = await controller.clearGoal();
      expect(r.cleared).toBe(true);
      expect(clearCalls).toBe(1);
      expect(controller.getGoal()?.status).toBe("cleared");
      expect(events).toEqual([]); // native: parser emits the cleared event, not us
    });

    it("native clearGoal({reason:'blocked'}) emits synthetic blocked and survives a trailing cleared", async () => {
      let clearReason: string | undefined;
      const { controller, events } = makeHarness({
        capability: MODELTOOLS_CAP,
        armNative: async () => true,
        clearNative: async (r) => { clearReason = r; },
      });
      await controller.setGoal("g");
      await controller.clearGoal({ reason: "blocked" });
      expect(clearReason).toBe("blocked");
      expect(controller.getGoal()).toMatchObject({ status: "blocked", blockedReason: "needs_input" });
      expect(events.at(-1)).toMatchObject({ status: "blocked" }); // host sees blocked
      // The provider's own clear notification (cleared) must not downgrade it.
      controller.observe(parserGoalEvent({ status: "cleared", met: false }));
      expect(controller.getGoal()?.status).toBe("blocked");
    });
  });

  describe("advisory", () => {
    it("records the goal without a kickoff turn or loop", async () => {
      const { controller, events, sends } = makeHarness();
      const res = await controller.setGoal("g", { enforce: "advisory" });
      expect(res.armed).toBe(true);
      expect(sends).toEqual([]);
      expect(events[0]).toMatchObject({ status: "active", enforced: false, source: "host" });
      await controller.onTurnSettled(completedTurn()); // advisory → no driving
      expect(sends).toEqual([]);
    });

    it("seeds native model-tools state WITHOUT a synthetic active (no double-emit)", async () => {
      let seeded = "";
      const { controller, events } = makeHarness({
        capability: MODELTOOLS_CAP,
        armNative: async (o) => { seeded = o; return true; },
      });
      const res = await controller.setGoal("advisory native", { enforce: "advisory" });
      expect(res).toEqual({ armed: true, mechanism: "model-tools" });
      expect(seeded).toBe("advisory native"); // RPC seeded
      expect(events).toEqual([]); // parser will emit active; we don't double it
      expect(controller.getGoal()).toMatchObject({ status: "active", enforced: false, objective: "advisory native" });
    });

    it("falls back to a synthetic active when native seeding is unavailable/fails", async () => {
      const { controller, events } = makeHarness({ capability: MODELTOOLS_CAP, armNative: async () => false });
      await controller.setGoal("g", { enforce: "advisory" });
      expect(events[0]).toMatchObject({ status: "active", enforced: false, source: "host" });
    });
  });

  describe("observe (native state tracking)", () => {
    it("isTracking reflects a non-terminal active goal", async () => {
      const { controller } = makeHarness({ capability: SENTINEL_CAP, armNative: async () => true });
      expect(controller.isTracking()).toBe(false);
      await controller.setGoal("g");
      expect(controller.isTracking()).toBe(true);
      controller.observe(parserGoalEvent({ status: "met", met: true }));
      expect(controller.isTracking()).toBe(false); // terminal
    });

    it("preserves the objective when a terminal event omits it (cleared with no objective)", async () => {
      const { controller } = makeHarness({ capability: SENTINEL_CAP, armNative: async () => true });
      await controller.setGoal("keep this objective");
      controller.observe(parserGoalEvent({ status: "cleared", met: false, objective: "" }));
      expect(controller.getGoal()).toMatchObject({ status: "cleared", objective: "keep this objective" });
    });

    it("ignores stale same-goal events once terminal — a late `active` can't resurrect a met goal", async () => {
      const { controller } = makeHarness({ capability: SENTINEL_CAP, armNative: async () => true });
      await controller.setGoal("g");
      controller.observe(parserGoalEvent({ status: "met", met: true, objective: "g" }));
      expect(controller.getGoal()?.status).toBe("met");
      controller.observe(parserGoalEvent({ status: "active", met: false, objective: "g" })); // stale, same goal
      expect(controller.getGoal()?.status).toBe("met");
    });

    it("accepts a genuinely new goal (different objective) after a terminal one", async () => {
      const { controller } = makeHarness({ capability: MODELTOOLS_CAP, armNative: async () => true });
      await controller.setGoal("first goal");
      controller.observe(parserGoalEvent({ status: "met", met: true, objective: "first goal" }));
      expect(controller.getGoal()?.status).toBe("met");
      // the model started a NEW goal → active with a different objective
      controller.observe(parserGoalEvent({ status: "active", met: false, objective: "second goal" }));
      expect(controller.getGoal()).toMatchObject({ status: "active", objective: "second goal" });
    });
  });

  describe("interrupt & non-completed turns (loop control)", () => {
    it("notifyInterrupted pauses the loop for exactly one settle", async () => {
      const { controller, sends } = makeHarness();
      await controller.setGoal("g", { sentinel: () => false });
      expect(sends).toEqual(["g"]); // kickoff
      controller.notifyInterrupted();
      await controller.onTurnSettled(completedTurn()); // suspended → no nudge
      expect(sends).toHaveLength(1);
      await controller.onTurnSettled(completedTurn()); // resumes
      expect(sends).toHaveLength(2);
    });

    it("does not advance the loop on an aborted/timeout turn", async () => {
      const { controller, sends } = makeHarness();
      await controller.setGoal("g", { sentinel: () => false });
      await controller.onTurnSettled({ summary: null, costUsd: null, status: "aborted", errorCode: "aborted", errorMessage: null });
      expect(sends).toHaveLength(1);
      await controller.onTurnSettled({ summary: null, costUsd: null, status: "timeout", errorCode: "timeout", errorMessage: null });
      expect(sends).toHaveLength(1);
      await controller.onTurnSettled(completedTurn()); // a real completion advances
      expect(sends).toHaveLength(2);
    });
  });

  describe("clear & replace", () => {
    it("clearGoal on an active emulated goal emits cleared", async () => {
      const { controller, events } = makeHarness();
      await controller.setGoal("g", { sentinel: () => false });
      const r = await controller.clearGoal();
      expect(r.cleared).toBe(true);
      expect(controller.getGoal()?.status).toBe("cleared");
      expect(events.at(-1)).toMatchObject({ status: "cleared", source: "host" });
    });

    it("clearGoal with reason blocked emits blocked", async () => {
      const { controller } = makeHarness();
      await controller.setGoal("g", { sentinel: () => false });
      await controller.clearGoal({ reason: "blocked" });
      expect(controller.getGoal()).toMatchObject({ status: "blocked", blockedReason: "needs_input" });
    });

    it("clearGoal with no active goal returns {cleared:false}", async () => {
      const { controller } = makeHarness();
      expect(await controller.clearGoal()).toEqual({ cleared: false });
    });

    it("setGoal replaces an active goal (cleared old, active new)", async () => {
      const { controller, events } = makeHarness();
      await controller.setGoal("first", { sentinel: () => false });
      events.length = 0;
      await controller.setGoal("second", { sentinel: () => false });
      expect(events[0]).toMatchObject({ status: "cleared", objective: "first" });
      expect(events[1]).toMatchObject({ status: "active", objective: "second" });
      expect(controller.getGoal()?.objective).toBe("second");
    });
  });

  describe("default sentinel loop (re-entrancy guard)", () => {
    // A realistic harness: every settled turn re-enters onTurnSettled, exactly
    // like a real session. This exercises the `evaluating` guard against the
    // default sentinel's own meta-turn settle triggering infinite recursion.
    function makeAutoHarness() {
      const sends: string[] = [];
      const events: GoalEvent[] = [];
      const resolvers: Array<(tr: TurnResult) => void> = [];
      const ref: { c?: GoalController } = {};
      const controller = new GoalController({
        providerType: "test",
        getSessionId: () => "s",
        send: (m: string): Promise<SendHandle> => {
          sends.push(m);
          let resolve!: (tr: TurnResult) => void;
          const result = new Promise<TurnResult>((res) => { resolve = res; });
          resolvers.push(resolve);
          // Simulate the session: a settled turn re-enters onTurnSettled.
          void result.then((tr) => ref.c?.onTurnSettled(tr));
          return Promise.resolve({ uuid: "u", result });
        },
        dispatch: (ev: StreamEvent) => { if (ev.type === "goal_status") events.push(ev); },
      });
      ref.c = controller;
      const settleNext = (tr: TurnResult): void => { resolvers.shift()?.(tr); };
      return { controller, sends, events, settleNext };
    }

    it("runs the meta-assessment loop to completion without runaway sends", async () => {
      const { controller, sends, settleNext } = makeAutoHarness();
      await controller.setGoal("reach the goal"); // emulated, default sentinel
      expect(sends).toEqual(["reach the goal"]); // kickoff

      settleNext(completedTurn()); // kickoff settles → sentinel sends assessment #1
      await flush();
      expect(sends).toHaveLength(2);

      settleNext(completedTurn("NO, not yet")); // assessment #1 → not met → nudge
      await flush();
      expect(sends).toHaveLength(3);
      expect(controller.getGoal()?.status).toBe("active");

      settleNext(completedTurn()); // nudge settles → sentinel sends assessment #2
      await flush();
      expect(sends).toHaveLength(4);

      settleNext(completedTurn("YES, fully done")); // assessment #2 → met
      await flush();
      expect(controller.getGoal()?.status).toBe("met");
      expect(sends).toHaveLength(4); // no runaway; meta-turn settles were ignored
    });
  });

  describe("hydrate (resume)", () => {
    it("restores reporting state without re-arming the loop", async () => {
      const { controller, sends } = makeHarness();
      controller.hydrate({
        objective: "resumed goal",
        status: "active",
        met: false,
        enforced: true,
        source: "host",
        updatedAt: "2026-06-25T00:00:00.000Z",
      });
      expect(controller.getGoal()?.objective).toBe("resumed goal");
      await controller.onTurnSettled(completedTurn()); // hydrate doesn't restart the loop
      expect(sends).toEqual([]);
    });

    it("never overwrites newer live goal state", async () => {
      const { controller } = makeHarness();
      await controller.setGoal("new live goal", { enforce: "advisory" });
      controller.hydrate({
        objective: "stale historical goal",
        status: "active",
        met: false,
        enforced: true,
        source: "host",
        updatedAt: "2026-06-25T00:00:00.000Z",
      });
      expect(controller.getGoal()?.objective).toBe("new live goal");
    });
  });
});
