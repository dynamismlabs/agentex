import { describe, expect, it } from "vitest";
import { historyFromSessionAttachment } from "../../src/sessions/history.js";
import type { SessionAttachment, StreamEvent } from "../../src/types.js";

const event: StreamEvent = {
  type: "assistant",
  text: "hello",
  timestamp: new Date(0).toISOString(),
  providerType: "claude",
  sessionId: "session",
  messageId: "message",
  eventId: "event",
  turnId: null,
  parentToolCallId: null,
  raw: {},
};

describe("historyFromSessionAttachment", () => {
  it("adapts the legacy API without changing its byte-offset contract", async () => {
    const attachment = {
      record: {
        version: 1,
        providerType: "claude",
        params: { sessionId: "session" },
        cwd: "/tmp",
        displayId: "session",
        updatedAt: new Date(0).toISOString(),
      },
      transcript: { filePath: "/tmp/transcript.jsonl", cwd: "/tmp" },
      lastTurn: "completed",
      async *catchUp() {
        yield { event, offset: 42, eventId: "event" };
      },
      async resume() { throw new Error("not used"); },
    } satisfies SessionAttachment;

    const history = historyFromSessionAttachment("claude", attachment);
    const items = [];
    for await (const item of history.catchUp()) items.push(item);
    expect(history.historySource).toEqual({ kind: "file", path: "/tmp/transcript.jsonl" });
    expect(items).toEqual([{
      event,
      eventId: "event",
      checkpoint: {
        kind: "claude:byte-offset:v1",
        value: { offset: 42, eventId: "event" },
      },
    }]);
  });

  it("rejects a checkpoint owned by another provider", async () => {
    const attachment = {
      record: {
        version: 1, providerType: "claude", params: {}, cwd: null,
        displayId: null, updatedAt: new Date(0).toISOString(),
      },
      transcript: null,
      lastTurn: "unknown",
      async *catchUp() {},
      async resume() { throw new Error("not used"); },
    } satisfies SessionAttachment;
    const history = historyFromSessionAttachment("claude", attachment);
    expect(() => history.catchUp({ after: { kind: "codex:byte-offset:v1", value: { offset: 0 } } }))
      .toThrow(/checkpoint kind/);
  });
});
