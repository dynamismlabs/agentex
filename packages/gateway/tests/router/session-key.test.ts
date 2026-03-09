import { describe, it, expect } from "vitest";
import { resolveSessionKey, resolveCanonicalPeerId } from "../../src/router/session-key.js";
import type { InboundMessage, SessionsConfig } from "../../src/types.js";

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

describe("resolveSessionKey", () => {
  it("main scope — all DMs share one session", () => {
    const config: SessionsConfig = { dmScope: "main" };
    expect(resolveSessionKey(makeMsg(), config, "main")).toBe("agent:main:main");
  });

  it("per-peer scope — each sender gets own session", () => {
    const config: SessionsConfig = { dmScope: "per-peer" };
    expect(resolveSessionKey(makeMsg({ senderId: "alice" }), config, "main")).toBe(
      "agent:main:direct:alice",
    );
  });

  it("per-peer scope — uses canonical peer ID from identity links", () => {
    const config: SessionsConfig = {
      dmScope: "per-peer",
      identityLinks: { alice: ["telegram:12345", "slack:U0123"] },
    };
    expect(
      resolveSessionKey(makeMsg({ senderId: "12345", channel: "telegram" }), config, "main"),
    ).toBe("agent:main:direct:alice");
  });

  it("per-channel-peer scope — separate per channel", () => {
    const config: SessionsConfig = { dmScope: "per-channel-peer" };
    expect(
      resolveSessionKey(makeMsg({ senderId: "alice", channel: "telegram" }), config, "main"),
    ).toBe("agent:main:telegram:direct:alice");
  });

  it("group messages — always scoped by channel + target", () => {
    const config: SessionsConfig = { dmScope: "main" };
    expect(
      resolveSessionKey(
        makeMsg({ chatType: "group", target: "group123", channel: "slack" }),
        config,
        "main",
      ),
    ).toBe("agent:main:slack:group:group123");
  });

  it("uses custom agentId in key", () => {
    const config: SessionsConfig = { dmScope: "main" };
    expect(resolveSessionKey(makeMsg(), config, "sales")).toBe("agent:sales:main");
  });

  it("thread messages scope like groups", () => {
    const config: SessionsConfig = { dmScope: "main" };
    expect(
      resolveSessionKey(
        makeMsg({ chatType: "thread", target: "channel1", channel: "discord" }),
        config,
        "main",
      ),
    ).toBe("agent:main:discord:group:channel1");
  });
});

describe("resolveCanonicalPeerId", () => {
  it("returns canonical name when linked", () => {
    const links = { alice: ["telegram:12345", "slack:U0123"] };
    expect(resolveCanonicalPeerId("12345", "telegram", links)).toBe("alice");
  });

  it("returns senderId when not linked", () => {
    const links = { alice: ["telegram:12345"] };
    expect(resolveCanonicalPeerId("99999", "telegram", links)).toBe("99999");
  });

  it("returns senderId when no links", () => {
    expect(resolveCanonicalPeerId("user1", "telegram")).toBe("user1");
  });

  it("matches correct channel in links", () => {
    const links = { alice: ["telegram:12345"] };
    // Same senderId but different channel — should not match
    expect(resolveCanonicalPeerId("12345", "slack", links)).toBe("12345");
  });
});
