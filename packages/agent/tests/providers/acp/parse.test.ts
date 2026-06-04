import { describe, it, expect } from "vitest";
import {
  mapAcpUpdate,
  extractContentText,
  extractToolContentText,
  mapAcpStopReason,
} from "../../../src/providers/acp/parse.js";
import { parseAcpModes } from "../../../src/providers/acp/session.js";

const info = { provider: "acp-test", sessionId: "s1", timestamp: "2026-01-01T00:00:00Z" };

describe("mapAcpUpdate", () => {
  it("maps agent_message_chunk → assistant (with provider + sessionId on the event)", () => {
    const e = mapAcpUpdate({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hi" } }, info);
    expect(e?.type).toBe("assistant");
    if (e?.type === "assistant") expect(e.text).toBe("hi");
    expect(e?.providerType).toBe("acp-test");
    expect(e?.sessionId).toBe("s1");
    expect(e?.messageId).toBeNull();
  });

  it("maps agent_thought_chunk → thinking", () => {
    const e = mapAcpUpdate({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "hmm" } }, info);
    expect(e?.type).toBe("thinking");
  });

  it("skips user_message_chunk", () => {
    expect(mapAcpUpdate({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "x" } }, info)).toBeNull();
  });

  it("maps tool_call → tool_call with id/name/input", () => {
    const e = mapAcpUpdate(
      { sessionUpdate: "tool_call", toolCallId: "c1", title: "Read", kind: "read", rawInput: { path: "/x" } },
      info,
    );
    expect(e?.type).toBe("tool_call");
    if (e?.type === "tool_call") {
      expect(e.toolCallId).toBe("c1");
      expect(e.name).toBe("Read");
      expect(e.input).toEqual({ path: "/x" });
    }
  });

  it("maps completed tool_call_update → tool_result", () => {
    const e = mapAcpUpdate(
      {
        sessionUpdate: "tool_call_update",
        toolCallId: "c1",
        title: "Read",
        status: "completed",
        content: [{ type: "content", content: { type: "text", text: "out" } }],
      },
      info,
    );
    expect(e?.type).toBe("tool_result");
    if (e?.type === "tool_result") {
      expect(e.toolCallId).toBe("c1");
      expect(e.toolName).toBe("Read");
      expect(e.content).toBe("out");
      expect(e.isError).toBe(false);
    }
  });

  it("maps failed tool_call_update → tool_result with isError", () => {
    const e = mapAcpUpdate({ sessionUpdate: "tool_call_update", toolCallId: "c1", status: "failed", rawOutput: "boom" }, info);
    expect(e?.type === "tool_result" && e.isError).toBe(true);
    expect(e?.type === "tool_result" && e.content).toBe("boom");
  });

  it("skips in-progress tool_call_update", () => {
    expect(mapAcpUpdate({ sessionUpdate: "tool_call_update", toolCallId: "c1", status: "in_progress" }, info)).toBeNull();
  });

  it("maps unknown update kinds to a forward-compat unknown event", () => {
    const e = mapAcpUpdate({ sessionUpdate: "usage_update", size: 10, used: 3 }, info);
    expect(e?.type).toBe("unknown");
    if (e?.type === "unknown") expect(e.subtype).toBe("usage_update");
  });
});

describe("content extraction", () => {
  it("reads text content blocks", () => {
    expect(extractContentText({ type: "text", text: "yo" })).toBe("yo");
    expect(extractContentText({ type: "image" })).toBeNull();
    expect(extractContentText(null)).toBeNull();
  });

  it("joins tool content text parts (content + diff), ignoring terminal (no inline output)", () => {
    expect(
      extractToolContentText([
        { type: "content", content: { type: "text", text: "a" } },
        { type: "terminal", terminalId: "t1" }, // only a terminalId — no inline text
        { type: "diff", newText: "c" },
      ]),
    ).toBe("a\nc");
    expect(extractToolContentText("nope")).toBeNull();
  });
});

describe("mapAcpStopReason", () => {
  it("maps each ACP stop reason", () => {
    expect(mapAcpStopReason("end_turn")).toBe("completed");
    expect(mapAcpStopReason("cancelled")).toBe("aborted");
    expect(mapAcpStopReason("refusal")).toBe("failed");
    expect(mapAcpStopReason("max_tokens")).toBe("max_budget");
    expect(mapAcpStopReason("max_turn_requests")).toBe("max_turns");
    expect(mapAcpStopReason(undefined)).toBe("completed");
  });
});

describe("parseAcpModes", () => {
  it("parses a SessionModeState's availableModes", () => {
    expect(
      parseAcpModes({
        currentModeId: "default",
        availableModes: [
          { id: "default", name: "Default" },
          { id: "plan", name: "Plan", description: "RO" },
        ],
      }),
    ).toEqual([
      { id: "default", name: "Default" },
      { id: "plan", name: "Plan", description: "RO" },
    ]);
  });

  it("returns [] for missing/invalid input", () => {
    expect(parseAcpModes(null)).toEqual([]);
    expect(parseAcpModes({ availableModes: "x" })).toEqual([]);
    expect(parseAcpModes({})).toEqual([]);
  });
});
