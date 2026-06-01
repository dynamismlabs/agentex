import { describe, it, expect } from "vitest";
import { createToolNameTracker } from "../../src/utils/tool-names.js";
import type { StreamEvent } from "../../src/types.js";

function base() {
  return {
    timestamp: "",
    providerType: "test",
    sessionId: null,
    messageId: null,
    eventId: null,
    turnId: null,
    parentToolCallId: null,
    raw: {},
  };
}

function call(id: string | null, name: string): StreamEvent {
  return { type: "tool_call", toolCallId: id, name, input: {}, ...base() };
}

function result(id: string | null, toolName: string | null = null): StreamEvent {
  return { type: "tool_result", toolCallId: id, toolName, content: "", isError: false, exitCode: null, ...base() };
}

function toolNameOf(e: StreamEvent): string | null {
  return e.type === "tool_result" ? e.toolName : "<not-a-result>";
}

describe("createToolNameTracker", () => {
  it("fills tool_result.toolName from the matching tool_call", () => {
    const track = createToolNameTracker();
    track(call("c1", "Bash"));
    expect(toolNameOf(track(result("c1")))).toBe("Bash");
  });

  it("leaves toolName null when no matching call was seen", () => {
    const track = createToolNameTracker();
    expect(toolNameOf(track(result("orphan")))).toBeNull();
  });

  it("does not overwrite a toolName the parser already set (Codex case)", () => {
    const track = createToolNameTracker();
    track(call("c1", "FromCall"));
    expect(toolNameOf(track(result("c1", "FromParser")))).toBe("FromParser");
  });

  it("ignores tool_call events with no id or no name", () => {
    const track = createToolNameTracker();
    track(call(null, "NoId"));
    track(call("c2", ""));
    expect(toolNameOf(track(result("c2")))).toBeNull();
  });

  it("evicts the oldest entry past the cap but keeps recent correlations", () => {
    const track = createToolNameTracker();
    // MAX_TRACKED is 4096; fill it exactly, then push one more to evict c0.
    for (let i = 0; i < 4096; i++) track(call(`c${i}`, `tool${i}`));
    track(call("c4096", "tool4096"));
    expect(toolNameOf(track(result("c0")))).toBeNull(); // evicted
    expect(toolNameOf(track(result("c4096")))).toBe("tool4096"); // kept
  });

  it("passes non-tool events through unchanged (same reference)", () => {
    const track = createToolNameTracker();
    const ev: StreamEvent = { type: "assistant", text: "hi", ...base() };
    expect(track(ev)).toBe(ev);
  });
});
