import { describe, it, expect } from "vitest";
import { codexLineToStreamEvents } from "../../../src/providers/codex/transcript-normalize.js";
import { parseCodexLine } from "../../../src/providers/codex/transcript.js";
import type { CodexTranscriptLine } from "../../../src/providers/codex/transcript.js";

const CTX = { sessionId: "sess-1" };

/** Build a realistic CodexTranscriptLine via the same parser readCodexTranscript uses. */
function mk(obj: Record<string, unknown>): CodexTranscriptLine {
  const line = parseCodexLine(JSON.stringify(obj));
  if (!line) throw new Error("fixture did not parse");
  return line;
}

function only(events: ReturnType<typeof codexLineToStreamEvents>) {
  expect(events).toHaveLength(1);
  return events[0]!;
}

describe("codexLineToStreamEvents — §5.4 mapping table", () => {
  it("response_item/message (assistant) → assistant", () => {
    const ev = only(
      codexLineToStreamEvents(
        mk({
          type: "response_item",
          timestamp: "2026-05-08T22:01:59.250Z",
          payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "hi there" }] },
        }),
        CTX,
      ),
    );
    expect(ev.type).toBe("assistant");
    if (ev.type === "assistant") expect(ev.text).toBe("hi there");
  });

  it("response_item/message (user|developer) → [] (dropped)", () => {
    for (const role of ["user", "developer"]) {
      expect(
        codexLineToStreamEvents(
          mk({ type: "response_item", payload: { type: "message", role, content: [{ type: "input_text", text: "x" }] } }),
          CTX,
        ),
      ).toEqual([]);
    }
  });

  it("response_item/reasoning → thinking (summary extraction)", () => {
    const ev = only(
      codexLineToStreamEvents(
        mk({
          type: "response_item",
          payload: { type: "reasoning", summary: [{ type: "summary_text", text: "planning" }] },
        }),
        CTX,
      ),
    );
    expect(ev.type).toBe("thinking");
    if (ev.type === "thinking") expect(ev.text).toBe("planning");
  });

  it("response_item/reasoning with no readable summary → thinking with empty text (parity with live parser)", () => {
    const ev = only(
      codexLineToStreamEvents(
        mk({ type: "response_item", payload: { type: "reasoning", summary: [], encrypted_content: "opaque" } }),
        CTX,
      ),
    );
    expect(ev.type).toBe("thinking");
    if (ev.type === "thinking") expect(ev.text).toBe("");
  });

  it("response_item/function_call → tool_call (call_id, name, parsed input)", () => {
    const ev = only(
      codexLineToStreamEvents(
        mk({
          type: "response_item",
          payload: {
            type: "function_call",
            call_id: "call_42",
            name: "shell",
            arguments: JSON.stringify({ command: "ls" }),
          },
        }),
        CTX,
      ),
    );
    expect(ev.type).toBe("tool_call");
    if (ev.type === "tool_call") {
      expect(ev.toolCallId).toBe("call_42");
      expect(ev.name).toBe("shell");
      expect(ev.input).toEqual({ command: "ls" });
    }
  });

  it("function_call with unparseable arguments falls back to the raw string", () => {
    const ev = only(
      codexLineToStreamEvents(
        mk({ type: "response_item", payload: { type: "function_call", call_id: "c", name: "x", arguments: "{not json" } }),
        CTX,
      ),
    );
    if (ev.type === "tool_call") expect(ev.input).toBe("{not json");
  });

  it("function_call falls back to id when call_id absent, and default name", () => {
    const ev = only(
      codexLineToStreamEvents(
        mk({ type: "response_item", payload: { type: "function_call", id: "id_9", arguments: "{}" } }),
        CTX,
      ),
    );
    if (ev.type === "tool_call") {
      expect(ev.toolCallId).toBe("id_9");
      expect(ev.name).toBe("function_call");
    }
  });

  it("response_item/function_call_output → tool_result (string output)", () => {
    const ev = only(
      codexLineToStreamEvents(
        mk({ type: "response_item", payload: { type: "function_call_output", call_id: "call_42", output: "done\n" } }),
        CTX,
      ),
    );
    expect(ev.type).toBe("tool_result");
    if (ev.type === "tool_result") {
      expect(ev.toolCallId).toBe("call_42");
      expect(ev.toolName).toBeNull();
      expect(ev.content).toBe("done\n");
      expect(ev.isError).toBe(false);
      expect(ev.exitCode).toBeNull();
    }
  });

  it("function_call_output with wrapped object output extracts inner text", () => {
    const ev = only(
      codexLineToStreamEvents(
        mk({ type: "response_item", payload: { type: "function_call_output", call_id: "c", output: { output: "inner", metadata: { exit_code: 0 } } } }),
        CTX,
      ),
    );
    if (ev.type === "tool_result") expect(ev.content).toBe("inner");
  });

  it("event_msg/task_complete → result (completed)", () => {
    const ev = only(
      codexLineToStreamEvents(
        mk({ type: "event_msg", payload: { type: "task_complete", last_agent_message: "all done" } }),
        CTX,
      ),
    );
    expect(ev.type).toBe("result");
    if (ev.type === "result") {
      expect(ev.text).toBe("all done");
      expect(ev.isError).toBe(false);
      expect(ev.terminalReason).toBe("completed");
    }
  });

  it.each([
    ["session_meta", { type: "session_meta", payload: { id: "x", cwd: "/w" } }],
    ["turn_context", { type: "turn_context", payload: { type: "turn_context" } }],
    ["event_msg/task_started", { type: "event_msg", payload: { type: "task_started", turn_id: "t1" } }],
    ["event_msg/token_count", { type: "event_msg", payload: { type: "token_count", total: 10 } }],
    ["event_msg/agent_message (dup)", { type: "event_msg", payload: { type: "agent_message", message: "dup" } }],
    ["event_msg/user_message", { type: "event_msg", payload: { type: "user_message", message: "hi" } }],
    ["response_item/unknown", { type: "response_item", payload: { type: "web_search_call" } }],
  ])("drops %s → []", (_label, obj) => {
    expect(codexLineToStreamEvents(mk(obj as Record<string, unknown>), CTX)).toEqual([]);
  });

  it("drops unwrapped legacy lines (no payload) → []", () => {
    expect(codexLineToStreamEvents(mk({ type: "message", role: "user", content: [] }), CTX)).toEqual([]);
    expect(codexLineToStreamEvents(mk({ id: "abc", instructions: null }), CTX)).toEqual([]);
  });
});

describe("codexLineToStreamEvents — BaseStreamEventFields + robustness", () => {
  it("populates every base field (codex, ctx sessionId, null wire ids, raw verbatim)", () => {
    const raw = { type: "response_item", timestamp: "2026-05-08T22:01:59.250Z", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "hey" }] } };
    const line = mk(raw);
    const ev = only(codexLineToStreamEvents(line, CTX));
    expect(ev.providerType).toBe("codex");
    expect(ev.sessionId).toBe("sess-1");
    expect(ev.messageId).toBeNull();
    expect(ev.eventId).toBeNull();
    expect(ev.turnId).toBeNull();
    expect(ev.parentToolCallId).toBeNull();
    expect(ev.timestamp).toBe("2026-05-08T22:01:59.250Z");
    expect(ev.raw).toEqual(line.raw);
  });

  it("falls back to epoch timestamp when the line has none", () => {
    const ev = only(
      codexLineToStreamEvents(
        mk({ type: "event_msg", payload: { type: "task_complete", last_agent_message: "x" } }),
        CTX,
      ),
    );
    expect(ev.timestamp).toBe(new Date(0).toISOString());
  });

  it("passes ctx.sessionId=null through", () => {
    const ev = only(
      codexLineToStreamEvents(
        mk({ type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "x" }] } }),
        { sessionId: null },
      ),
    );
    expect(ev.sessionId).toBeNull();
  });

  it("never throws on malformed payloads (content/summary wrong types)", () => {
    const weird: Record<string, unknown>[] = [
      { type: "response_item", payload: { type: "message", role: "assistant", content: "not-an-array" } },
      { type: "response_item", payload: { type: "reasoning", summary: 42 } },
      { type: "response_item", payload: { type: "function_call", arguments: 999 } },
      { type: "response_item", payload: { type: "function_call_output", output: [1, 2, 3] } },
      { type: "response_item", payload: {} },
    ];
    for (const w of weird) {
      expect(() => codexLineToStreamEvents(mk(w), CTX)).not.toThrow();
    }
    // assistant with non-array content → text ""
    const ev = only(codexLineToStreamEvents(mk(weird[0]!), CTX));
    if (ev.type === "assistant") expect(ev.text).toBe("");
  });
});
