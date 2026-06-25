import { describe, it, expect } from "vitest";
import { parseStreamLine } from "../../../src/providers/claude/parse.js";

describe("claude parse — goal_status attachment", () => {
  it("met:false → active goal_status event with envelope", () => {
    const line = JSON.stringify({
      type: "attachment",
      uuid: "evt-1",
      session_id: "sess-1",
      attachment: { type: "goal_status", met: false, sentinel: true, condition: "all tests pass" },
    });
    const events = parseStreamLine(line);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "goal_status",
      objective: "all tests pass",
      status: "active",
      met: false,
      enforced: true,
      source: "sentinel",
      sessionId: "sess-1",
      eventId: "evt-1",
      providerType: "claude",
    });
  });

  it("met:true → met goal_status event", () => {
    const line = JSON.stringify({
      type: "attachment",
      attachment: { type: "goal_status", met: true, sentinel: true, condition: "done" },
    });
    const events = parseStreamLine(line);
    expect(events[0]).toMatchObject({ type: "goal_status", status: "met", met: true });
  });

  it("non-goal attachment falls through to forward-compat unknown", () => {
    const line = JSON.stringify({ type: "attachment", attachment: { type: "image", url: "x" } });
    const events = parseStreamLine(line);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "unknown", subtype: "attachment" });
  });
});
