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
          payload: {
            type: "message",
            role: "assistant",
            phase: "final_answer",
            content: [{ type: "output_text", text: "hi there" }],
          },
        }),
        CTX,
      ),
    );
    expect(ev.type).toBe("assistant");
    if (ev.type === "assistant") {
      expect(ev.text).toBe("hi there");
      expect(ev.phase).toBe("final_answer");
    }
  });

  it("response_item/message preserves commentary and omits unknown phases", () => {
    const commentary = only(codexLineToStreamEvents(mk({
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        phase: "commentary",
        content: [{ type: "output_text", text: "still working" }],
      },
    }), CTX));
    expect(commentary.type).toBe("assistant");
    if (commentary.type === "assistant") expect(commentary.phase).toBe("commentary");

    const unknown = only(codexLineToStreamEvents(mk({
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        phase: "future_phase",
        content: [{ type: "output_text", text: "text" }],
      },
    }), CTX));
    expect(unknown.type).toBe("assistant");
    if (unknown.type === "assistant") expect(unknown).not.toHaveProperty("phase");
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

  it("function_call_output with a list of content parts joins the text parts", () => {
    const ev = only(
      codexLineToStreamEvents(
        mk({
          type: "response_item",
          payload: {
            type: "function_call_output",
            call_id: "c",
            output: [{ type: "input_text", text: "line one" }, { type: "input_text", text: "line two" }],
          },
        }),
        CTX,
      ),
    );
    if (ev.type === "tool_result") expect(ev.content).toBe("line one\nline two");
  });

  it("response_item/custom_tool_call → tool_call with the freeform input string", () => {
    const script = "const r = await tools.exec_command({ cmd: \"ls\" });\ntext(r.output);";
    const ev = only(
      codexLineToStreamEvents(
        mk({
          type: "response_item",
          payload: { type: "custom_tool_call", id: "ctc_1", status: "completed", call_id: "call_7", name: "exec", input: script },
        }),
        CTX,
      ),
    );
    expect(ev.type).toBe("tool_call");
    if (ev.type === "tool_call") {
      expect(ev.toolCallId).toBe("call_7");
      expect(ev.name).toBe("exec");
      expect(ev.input).toBe(script);
    }
  });

  it("custom_tool_call keeps a JSON-looking input as the string the model wrote", () => {
    const ev = only(
      codexLineToStreamEvents(
        mk({ type: "response_item", payload: { type: "custom_tool_call", call_id: "c", name: "apply_patch", input: "{}" } }),
        CTX,
      ),
    );
    if (ev.type === "tool_call") expect(ev.input).toBe("{}");
  });

  it("custom_tool_call falls back to id and a default name, and a non-string input to null", () => {
    const ev = only(
      codexLineToStreamEvents(
        mk({ type: "response_item", payload: { type: "custom_tool_call", id: "ctc_9", input: 42 } }),
        CTX,
      ),
    );
    if (ev.type === "tool_call") {
      expect(ev.toolCallId).toBe("ctc_9");
      expect(ev.name).toBe("custom_tool_call");
      expect(ev.input).toBeNull();
    }
  });

  it("response_item/custom_tool_call_output → tool_result (text parts, images left in raw)", () => {
    const ev = only(
      codexLineToStreamEvents(
        mk({
          type: "response_item",
          payload: {
            type: "custom_tool_call_output",
            id: "ctco_1",
            call_id: "call_7",
            output: [
              { type: "input_text", text: "Script completed\nOutput:\n" },
              { type: "input_image", image_url: "data:image/png;base64,AAAA", detail: "high" },
              { type: "input_text", text: "a.txt" },
            ],
          },
        }),
        CTX,
      ),
    );
    expect(ev.type).toBe("tool_result");
    if (ev.type === "tool_result") {
      expect(ev.toolCallId).toBe("call_7");
      expect(ev.toolName).toBeNull();
      expect(ev.content).toBe("Script completed\nOutput:\na.txt");
      expect(ev.isError).toBe(false);
    }
  });

  it("custom_tool_call_output with a string output passes it through", () => {
    const ev = only(
      codexLineToStreamEvents(
        mk({ type: "response_item", payload: { type: "custom_tool_call_output", call_id: "c", output: "Exit code: 0\n" } }),
        CTX,
      ),
    );
    if (ev.type === "tool_result") expect(ev.content).toBe("Exit code: 0\n");
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

  it("event_msg/task_complete carries duration_ms through", () => {
    const ev = only(
      codexLineToStreamEvents(
        mk({ type: "event_msg", payload: { type: "task_complete", last_agent_message: "ok", duration_ms: 2135 } }),
        CTX,
      ),
    );
    if (ev.type === "result") expect(ev.durationMs).toBe(2135);
  });

  it("event_msg/task_complete with error → failed result with the API's message", () => {
    const ev = only(
      codexLineToStreamEvents(
        mk({
          type: "event_msg",
          payload: {
            type: "task_complete",
            turn_id: "t1",
            last_agent_message: null,
            error: {
              message: JSON.stringify({
                type: "error",
                status: 400,
                error: { type: "invalid_request_error", message: "The 'gpt-mini' model is not supported." },
              }),
              codex_error_info: "other",
            },
            duration_ms: 2041,
          },
        }),
        CTX,
      ),
    );
    expect(ev.type).toBe("result");
    if (ev.type === "result") {
      expect(ev.isError).toBe(true);
      expect(ev.terminalReason).toBe("failed");
      expect(ev.text).toBe("The 'gpt-mini' model is not supported.");
      expect(ev.durationMs).toBe(2041);
    }
  });

  it("task_complete error with a plain message, or none, still fails the result", () => {
    const plain = only(codexLineToStreamEvents(
      mk({ type: "event_msg", payload: { type: "task_complete", error: { message: "stream disconnected" } } }),
      CTX,
    ));
    if (plain.type === "result") {
      expect(plain.isError).toBe(true);
      expect(plain.text).toBe("stream disconnected");
    }
    const bare = only(codexLineToStreamEvents(
      mk({ type: "event_msg", payload: { type: "task_complete", error: { codex_error_info: "other" } } }),
      CTX,
    ));
    if (bare.type === "result") {
      expect(bare.isError).toBe(true);
      expect(bare.text).toBe("Turn failed");
    }
    const none = only(codexLineToStreamEvents(
      mk({ type: "event_msg", payload: { type: "task_complete", last_agent_message: "fine", error: null } }),
      CTX,
    ));
    if (none.type === "result") {
      expect(none.isError).toBe(false);
      expect(none.terminalReason).toBe("completed");
    }
  });

  it("event_msg/turn_aborted → result (interrupted, not an error)", () => {
    const ev = only(
      codexLineToStreamEvents(
        mk({
          type: "event_msg",
          payload: { type: "turn_aborted", turn_id: "t2", reason: "interrupted", duration_ms: 4310 },
        }),
        CTX,
      ),
    );
    expect(ev.type).toBe("result");
    if (ev.type === "result") {
      expect(ev.isError).toBe(false);
      expect(ev.terminalReason).toBe("interrupted");
      expect(ev.text).toBe("");
      expect(ev.durationMs).toBe(4310);
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
    ["response_item/agent_message (inter-agent)", {
      type: "response_item",
      payload: { type: "agent_message", author: "/root", recipient: "/root/worker", content: [{ type: "input_text", text: "Message Type: NEW_TASK" }] },
    }],
    ["event_msg/item_completed (mirror)", {
      type: "event_msg",
      payload: { type: "item_completed", item: { type: "AgentMessage", content: [{ type: "Text", text: "dup" }] } },
    }],
    ["event_msg/item_completed UserMessage", {
      type: "event_msg",
      payload: { type: "item_completed", item: { type: "UserMessage", content: [{ type: "text", text: "hi" }] } },
    }],
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
      { type: "response_item", payload: { type: "custom_tool_call_output", output: [null, { text: 5 }] } },
      { type: "event_msg", payload: { type: "task_complete", error: { message: 42 } } },
      { type: "event_msg", payload: { type: "turn_aborted", reason: 7, duration_ms: "slow" } },
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
