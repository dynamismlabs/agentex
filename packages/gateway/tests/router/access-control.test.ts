import { describe, it, expect } from "vitest";
import { checkAccess, PairingStore } from "../../src/router/access-control.js";
import type { InboundMessage, ChannelAccessConfig } from "../../src/types.js";

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

describe("checkAccess — DM policies", () => {
  it("allows with open policy", () => {
    const result = checkAccess(makeMsg(), { dm: { policy: "open" } });
    expect(result.allowed).toBe(true);
  });

  it("rejects with disabled policy", () => {
    const result = checkAccess(makeMsg(), { dm: { policy: "disabled" } });
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("disabled");
  });

  it("allows sender in allowlist", () => {
    const result = checkAccess(makeMsg({ senderId: "user1" }), {
      dm: { policy: "allowlist", allowFrom: ["user1", "user2"] },
    });
    expect(result.allowed).toBe(true);
  });

  it("rejects sender not in allowlist", () => {
    const result = checkAccess(makeMsg({ senderId: "stranger" }), {
      dm: { policy: "allowlist", allowFrom: ["user1"] },
    });
    expect(result.allowed).toBe(false);
  });

  it("returns pendingPairing for pairing policy", () => {
    const result = checkAccess(makeMsg(), { dm: { policy: "pairing" } });
    expect(result.allowed).toBe(false);
    expect(result.pendingPairing).toBe(true);
  });

  it("defaults to pairing when no config", () => {
    const result = checkAccess(makeMsg(), {});
    expect(result.allowed).toBe(false);
    expect(result.pendingPairing).toBe(true);
  });
});

describe("checkAccess — Group policies", () => {
  const groupMsg = (overrides: Partial<InboundMessage> = {}) =>
    makeMsg({ chatType: "group", target: "group1", ...overrides });

  it("allows with open policy", () => {
    const result = checkAccess(groupMsg(), { groups: { policy: "open" } });
    expect(result.allowed).toBe(true);
  });

  it("rejects with disabled policy", () => {
    const result = checkAccess(groupMsg(), { groups: { policy: "disabled" } });
    expect(result.allowed).toBe(false);
  });

  it("allows group in allowlist", () => {
    const result = checkAccess(groupMsg({ target: "group1" }), {
      groups: { policy: "allowlist", allowFrom: ["group1"] },
    });
    expect(result.allowed).toBe(true);
  });

  it("rejects group not in allowlist", () => {
    const result = checkAccess(groupMsg({ target: "group99" }), {
      groups: { policy: "allowlist", allowFrom: ["group1"] },
    });
    expect(result.allowed).toBe(false);
  });

  it("allows when mention pattern found", () => {
    const result = checkAccess(
      groupMsg({ text: "Hey @bot what's up?" }),
      { groups: { policy: "mention", mentionPattern: "@bot" } },
    );
    expect(result.allowed).toBe(true);
  });

  it("rejects when mention pattern not found", () => {
    const result = checkAccess(
      groupMsg({ text: "Just chatting" }),
      { groups: { policy: "mention", mentionPattern: "@bot" } },
    );
    expect(result.allowed).toBe(false);
  });

  it("allows when mention policy but no pattern configured", () => {
    const result = checkAccess(groupMsg(), { groups: { policy: "mention" } });
    expect(result.allowed).toBe(true);
  });
});

describe("PairingStore", () => {
  it("creates a new pairing request", () => {
    const store = new PairingStore();
    const msg = makeMsg();
    const pairing = store.request(msg);
    expect(pairing.id).toBeTruthy();
    expect(pairing.channel).toBe("telegram");
    expect(pairing.senderId).toBe("user1");
    expect(pairing.heldMessages).toEqual([msg]);
  });

  it("appends to existing pairing for same sender", () => {
    const store = new PairingStore();
    const msg1 = makeMsg({ messageId: "m1" });
    const msg2 = makeMsg({ messageId: "m2" });
    const p1 = store.request(msg1);
    const p2 = store.request(msg2);
    expect(p1.id).toBe(p2.id);
    expect(p1.heldMessages).toHaveLength(2);
  });

  it("approve releases held messages", () => {
    const store = new PairingStore();
    const msg = makeMsg();
    const pairing = store.request(msg);
    const released = store.approve(pairing.id);
    expect(released).toEqual([msg]);
    expect(store.get(pairing.id)).toBeUndefined();
  });

  it("approve returns empty for unknown id", () => {
    const store = new PairingStore();
    expect(store.approve("nonexistent")).toEqual([]);
  });

  it("deny discards held messages", () => {
    const store = new PairingStore();
    const msg = makeMsg();
    const pairing = store.request(msg);
    store.deny(pairing.id);
    expect(store.get(pairing.id)).toBeUndefined();
  });

  it("getAll returns all pairings", () => {
    const store = new PairingStore();
    store.request(makeMsg({ senderId: "a", channel: "telegram" }));
    store.request(makeMsg({ senderId: "b", channel: "slack" }));
    expect(store.getAll()).toHaveLength(2);
  });

  it("findBySender finds existing pairing", () => {
    const store = new PairingStore();
    store.request(makeMsg({ senderId: "alice", channel: "telegram" }));
    const found = store.findBySender("telegram", "alice");
    expect(found).toBeTruthy();
    expect(found!.senderId).toBe("alice");
  });

  it("findBySender returns undefined for non-existing", () => {
    const store = new PairingStore();
    expect(store.findBySender("telegram", "nobody")).toBeUndefined();
  });
});
