import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { parseStreamLine, toStreamEvents } from "../../../src/providers/claude/parse.js";
import type { PartialStreamContext } from "../../../src/providers/claude/parse.js";
import type { StreamEvent } from "../../../src/types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Captured live from `claude 2.1.165 --include-partial-messages --model haiku`.
const FIXTURE = readFileSync(
  path.resolve(__dirname, "../../fixtures/claude-partial-stream.jsonl"),
  "utf-8",
);

function parseAll(stdout: string): StreamEvent[] {
  const ctx: PartialStreamContext = { messageId: null };
  const events: StreamEvent[] = [];
  for (const raw of stdout.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    events.push(...parseStreamLine(line, ctx));
  }
  return events;
}

describe("assistant_delta / thinking_delta (captured fixture)", () => {
  it("emits text deltas whose concatenation equals the consolidated assistant text", () => {
    const events = parseAll(FIXTURE);

    const deltas = events.filter((e) => e.type === "assistant_delta");
    expect(deltas.length).toBeGreaterThan(0);

    const consolidated = events.filter((e) => e.type === "assistant" && e.text.length > 0);
    expect(consolidated.length).toBe(1);

    const concat = deltas.map((d) => (d.type === "assistant_delta" ? d.text : "")).join("");
    expect(consolidated[0]!.type === "assistant" && consolidated[0]!.text).toBe(concat);
  });

  it("stamps deltas with the consolidated event's messageId (reconciliation contract)", () => {
    const events = parseAll(FIXTURE);
    const consolidated = events.find((e) => e.type === "assistant" && e.text.length > 0);
    const deltas = events.filter(
      (e) => e.type === "assistant_delta" || e.type === "thinking_delta",
    );
    expect(consolidated?.messageId).toMatch(/^msg_/);
    for (const d of deltas) {
      expect(d.messageId).toBe(consolidated!.messageId);
      // Per-line identity + session come from the wrapper.
      expect(d.eventId).toBeTruthy();
      expect(d.sessionId).toBeTruthy();
      expect(d.type === "assistant_delta" || d.type === "thinking_delta").toBe(true);
      if (d.type === "assistant_delta" || d.type === "thinking_delta") {
        expect(typeof d.blockIndex).toBe("number");
      }
    }
  });

  it("surfaces thinking prose via thinking_delta (the consolidated thinking block is withheld)", () => {
    const events = parseAll(FIXTURE);
    const thinkingDeltas = events.filter((e) => e.type === "thinking_delta");
    expect(thinkingDeltas.length).toBeGreaterThan(0);
    const prose = thinkingDeltas.map((d) => (d.type === "thinking_delta" ? d.text : "")).join("");
    expect(prose).toContain("hello world"); // the model reasoned about the request
  });

  it("consumes scaffolding silently — no unknown events for known stream_event subtypes", () => {
    const events = parseAll(FIXTURE);
    const unknownStream = events.filter(
      (e) => e.type === "unknown" && e.subtype.startsWith("stream_event:"),
    );
    expect(unknownStream).toEqual([]);
  });

  it("toStreamEvents (aggregate path) produces the same deltas", () => {
    const events = toStreamEvents(FIXTURE);
    expect(events.some((e) => e.type === "assistant_delta")).toBe(true);
  });
});

describe("assistant_delta (synthetic multi-delta)", () => {
  const wrap = (event: Record<string, unknown>, uuid: string) =>
    JSON.stringify({ type: "stream_event", event, session_id: "s1", parent_tool_use_id: null, uuid });

  it("multiple deltas accumulate in order with a shared messageId + blockIndex", () => {
    const lines = [
      wrap({ type: "message_start", message: { id: "msg_X" } }, "u0"),
      wrap({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hello " } }, "u1"),
      wrap({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "world" } }, "u2"),
      wrap({ type: "message_stop" }, "u3"),
    ];
    const events = parseAll(lines.join("\n"));
    const deltas = events.filter((e) => e.type === "assistant_delta");
    expect(deltas).toHaveLength(2);
    expect(deltas.map((d) => (d.type === "assistant_delta" ? d.text : ""))).toEqual(["hello ", "world"]);
    for (const d of deltas) {
      expect(d.messageId).toBe("msg_X");
      if (d.type === "assistant_delta") expect(d.blockIndex).toBe(0);
    }
    expect(deltas[0]!.eventId).toBe("u1");
    expect(deltas[1]!.eventId).toBe("u2");
  });

  it("message_stop resets the tracked messageId", () => {
    const lines = [
      wrap({ type: "message_start", message: { id: "msg_X" } }, "u0"),
      wrap({ type: "message_stop" }, "u1"),
      wrap({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "stray" } }, "u2"),
    ];
    const events = parseAll(lines.join("\n"));
    const delta = events.find((e) => e.type === "assistant_delta");
    expect(delta?.messageId).toBeNull();
  });

  it("an unrecognized stream_event subtype surfaces as unknown (forward-compat)", () => {
    const events = parseAll(wrap({ type: "totally_new_event" }, "u9"));
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("unknown");
    if (events[0]!.type === "unknown") {
      expect(events[0]!.subtype).toBe("stream_event:totally_new_event");
    }
  });

  it("works without a context (messageId stays null, no crash)", () => {
    const events = parseStreamLine(
      wrap({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "x" } }, "u1"),
    );
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("assistant_delta");
    expect(events[0]!.messageId).toBeNull();
  });
});

// Live end-to-end — opt in with AGENTEX_REAL_CLAUDE_PARTIAL=1 (needs an authed
// `claude` on PATH; uses the cheapest model). Validates the whole path: flag
// emission → CLI stream → parser → delta events + consolidated assistant.
describe("live partial messages (real binary)", () => {
  it.skipIf(process.env.AGENTEX_REAL_CLAUDE_PARTIAL !== "1")(
    "execute() with includePartialMessages streams assistant_delta events",
    async () => {
      const { getProvider } = await import("../../../src/index.js");
      const events: StreamEvent[] = [];
      const result = await getProvider("claude").execute({
        prompt: "Reply with exactly: ping",
        model: "haiku",
        config: { includePartialMessages: true, skipPermissions: true, timeoutSec: 120 },
        onEvent: (e) => {
          events.push(e);
        },
      });
      expect(result.status).toBe("completed");
      const deltas = events.filter((e) => e.type === "assistant_delta");
      expect(deltas.length).toBeGreaterThan(0);
      const consolidated = events.find((e) => e.type === "assistant" && e.text.includes("ping"));
      expect(consolidated).toBeDefined();
      // Reconciliation contract holds live, not just on the fixture.
      expect(deltas[0]!.messageId).toBe(consolidated!.messageId);
    },
    180_000,
  );
});

describe("flag-off equivalence", () => {
  it("a stream with no stream_event lines produces zero delta events", () => {
    const withoutPartial = FIXTURE.split("\n")
      .filter((l) => !l.includes('"stream_event"'))
      .join("\n");
    const events = parseAll(withoutPartial);
    expect(events.some((e) => e.type === "assistant_delta" || e.type === "thinking_delta")).toBe(false);
    // The consolidated assistant event is still there — same as 0.0.19 behavior.
    expect(events.some((e) => e.type === "assistant" && e.text === "hello world")).toBe(true);
  });
});
