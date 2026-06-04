import { describe, it, expect } from "vitest";
import {
  assistantTextFromParts,
  turnStatusFromMessage,
  usageFromMessage,
  mapOpenCodePart,
  mapOpenCodeToolCall,
} from "../../../src/providers/opencode/event-parse.js";

const info = { provider: "opencode", sessionId: "s1", timestamp: "2026-01-01T00:00:00Z" };

describe("assistantTextFromParts", () => {
  it("concatenates visible text parts, skipping synthetic/ignored/reasoning", () => {
    expect(
      assistantTextFromParts([
        { type: "text", text: "Hello " },
        { type: "text", text: "world", synthetic: true },
        { type: "text", text: "!", ignored: true },
        { type: "reasoning", text: "hmm" },
        { type: "text", text: "done" },
      ]),
    ).toBe("Hello done");
  });
  it("returns '' for non-array", () => expect(assistantTextFromParts(null)).toBe(""));
});

describe("turnStatusFromMessage", () => {
  it("failed when info.error present, else completed", () => {
    expect(turnStatusFromMessage({ error: { name: "x" } })).toBe("failed");
    expect(turnStatusFromMessage({})).toBe("completed");
    expect(turnStatusFromMessage(null)).toBe("completed");
  });
});

describe("usageFromMessage", () => {
  it("maps tokens + model key + cache read", () => {
    expect(
      usageFromMessage({
        providerID: "anthropic",
        modelID: "claude-x",
        tokens: { input: 100, output: 50, cache: { read: 10 } },
      }),
    ).toEqual({ "anthropic/claude-x": { inputTokens: 100, outputTokens: 50, cachedInputTokens: 10 } });
  });
  it("undefined when no tokens", () => expect(usageFromMessage({})).toBeUndefined());
});

describe("mapOpenCodePart", () => {
  it("text → assistant", () => {
    const e = mapOpenCodePart({ id: "p", type: "text", text: "hi" }, info);
    expect(e?.type).toBe("assistant");
    if (e?.type === "assistant") expect(e.text).toBe("hi");
  });
  it("text honors a delta override", () => {
    const e = mapOpenCodePart({ id: "p", type: "text", text: "hello world" }, info, " world");
    expect(e?.type === "assistant" && e.text).toBe(" world");
  });
  it("reasoning → thinking", () => {
    expect(mapOpenCodePart({ type: "reasoning", text: "t" }, info)?.type).toBe("thinking");
  });
  it("skips synthetic text", () => {
    expect(mapOpenCodePart({ type: "text", text: "x", synthetic: true }, info)).toBeNull();
  });
  it("completed tool → tool_result", () => {
    const e = mapOpenCodePart(
      { type: "tool", callID: "c1", tool: "bash", state: { status: "completed", output: "files" } },
      info,
    );
    expect(e?.type).toBe("tool_result");
    if (e?.type === "tool_result") {
      expect(e.toolCallId).toBe("c1");
      expect(e.toolName).toBe("bash");
      expect(e.content).toBe("files");
      expect(e.isError).toBe(false);
    }
  });
  it("error tool → tool_result with isError, message from state.error (not output)", () => {
    const e = mapOpenCodePart(
      { type: "tool", callID: "c1", tool: "bash", state: { status: "error", error: "boom" } },
      info,
    );
    expect(e?.type === "tool_result" && e.isError).toBe(true);
    expect(e?.type === "tool_result" && e.content).toBe("boom");
  });
  it("pending tool → tool_call with input", () => {
    const e = mapOpenCodePart(
      { type: "tool", callID: "c1", tool: "bash", state: { status: "pending", input: { cmd: "ls" } } },
      info,
    );
    expect(e?.type).toBe("tool_call");
    if (e?.type === "tool_call") {
      expect(e.toolCallId).toBe("c1");
      expect(e.input).toEqual({ cmd: "ls" });
    }
  });
});

describe("mapOpenCodeToolCall", () => {
  it("always builds a tool_call from a tool part (regardless of state)", () => {
    const e = mapOpenCodeToolCall(
      { type: "tool", callID: "c2", tool: "read", state: { status: "completed", input: { path: "/x" } } },
      info,
    );
    expect(e.type).toBe("tool_call");
    expect(e.type === "tool_call" && e.name).toBe("read");
    expect(e.type === "tool_call" && e.input).toEqual({ path: "/x" });
  });
});
