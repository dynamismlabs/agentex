import { describe, it, expect } from "vitest";
import { resolveAgent } from "../../src/router/agent-router.js";
import type { InboundMessage, RoutingConfig } from "../../src/types.js";

function makeMsg(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    messageId: "msg1",
    channel: "telegram",
    senderId: "user1",
    chatType: "direct",
    target: "bot1",
    text: "hello",
    timestamp: Date.now(),
    ...overrides,
  };
}

describe("resolveAgent", () => {
  it("returns 'main' when no routing config", () => {
    expect(resolveAgent(makeMsg())).toBe("main");
  });

  it("returns default when no rules match", () => {
    const routing: RoutingConfig = {
      rules: [{ match: { channel: "slack" }, agent: "sales" }],
      default: "main",
    };
    expect(resolveAgent(makeMsg({ channel: "telegram" }), routing)).toBe("main");
  });

  it("matches single-field rule", () => {
    const routing: RoutingConfig = {
      rules: [{ match: { channel: "slack" }, agent: "sales" }],
      default: "main",
    };
    expect(resolveAgent(makeMsg({ channel: "slack" }), routing)).toBe("sales");
  });

  it("matches multi-field AND rule", () => {
    const routing: RoutingConfig = {
      rules: [
        { match: { channel: "slack", chatType: "group" }, agent: "support" },
      ],
      default: "main",
    };
    // Matches both fields
    expect(
      resolveAgent(makeMsg({ channel: "slack", chatType: "group" }), routing),
    ).toBe("support");

    // Only matches one field — should NOT match
    expect(
      resolveAgent(makeMsg({ channel: "slack", chatType: "direct" }), routing),
    ).toBe("main");
  });

  it("first-match-wins ordering", () => {
    const routing: RoutingConfig = {
      rules: [
        { match: { channel: "slack" }, agent: "first" },
        { match: { channel: "slack" }, agent: "second" },
      ],
      default: "main",
    };
    expect(resolveAgent(makeMsg({ channel: "slack" }), routing)).toBe("first");
  });

  it("matches by target", () => {
    const routing: RoutingConfig = {
      rules: [{ match: { target: "C0123" }, agent: "sales" }],
      default: "main",
    };
    expect(resolveAgent(makeMsg({ target: "C0123" }), routing)).toBe("sales");
  });

  it("matches by chatType", () => {
    const routing: RoutingConfig = {
      rules: [{ match: { chatType: "group" }, agent: "group-agent" }],
      default: "main",
    };
    expect(resolveAgent(makeMsg({ chatType: "group" }), routing)).toBe(
      "group-agent",
    );
  });

  it("omitted match fields are wildcards", () => {
    const routing: RoutingConfig = {
      rules: [{ match: {}, agent: "catch-all" }],
      default: "main",
    };
    expect(resolveAgent(makeMsg(), routing)).toBe("catch-all");
  });
});
