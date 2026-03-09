import { describe, it, expect } from "vitest";
import { MessageQueue } from "../../src/router/message-queue.js";
import type { InboundMessage, QueueConfig } from "../../src/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMsg(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    messageId: `msg-${Math.random().toString(36).slice(2, 8)}`,
    channel: "telegram",
    senderId: "user1",
    chatType: "direct",
    target: "bot1",
    text: "hello",
    timestamp: Date.now(),
    ...overrides,
  };
}

function makeConfig(overrides: Partial<QueueConfig> = {}): QueueConfig {
  return {
    mode: "queue",
    ...overrides,
  };
}

const SESSION = "agent:main:direct:user1";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("MessageQueue", () => {
  // -----------------------------------------------------------------------
  // Queue mode — FIFO
  // -----------------------------------------------------------------------

  describe("queue mode", () => {
    it("dequeues messages in FIFO order", () => {
      const mq = new MessageQueue();
      const config = makeConfig({ mode: "queue" });

      const m1 = makeMsg({ text: "first" });
      const m2 = makeMsg({ text: "second" });
      const m3 = makeMsg({ text: "third" });

      mq.enqueue(SESSION, m1, "queue", config);
      mq.enqueue(SESSION, m2, "queue", config);
      mq.enqueue(SESSION, m3, "queue", config);

      // With 3 messages in the buffer, dequeue returns all as an array
      const result = mq.dequeue(SESSION);
      expect(Array.isArray(result)).toBe(true);
      const arr = result as InboundMessage[];
      expect(arr).toHaveLength(3);
      expect(arr[0]!.text).toBe("first");
      expect(arr[1]!.text).toBe("second");
      expect(arr[2]!.text).toBe("third");
    });

    it("dequeue returns single message when only one in queue", () => {
      const mq = new MessageQueue();
      const config = makeConfig({ mode: "queue" });

      const m1 = makeMsg({ text: "only" });
      mq.enqueue(SESSION, m1, "queue", config);

      const result = mq.dequeue(SESSION);
      expect(Array.isArray(result)).toBe(false);
      expect((result as InboundMessage).text).toBe("only");
    });
  });

  // -----------------------------------------------------------------------
  // Steer mode — keeps only latest
  // -----------------------------------------------------------------------

  describe("steer mode", () => {
    it("keeps only the latest message", () => {
      const mq = new MessageQueue();
      const config = makeConfig({ mode: "steer" });

      mq.enqueue(SESSION, makeMsg({ text: "old" }), "steer", config);
      mq.enqueue(SESSION, makeMsg({ text: "newer" }), "steer", config);
      mq.enqueue(SESSION, makeMsg({ text: "latest" }), "steer", config);

      const result = mq.dequeue(SESSION);
      expect(Array.isArray(result)).toBe(false);
      expect((result as InboundMessage).text).toBe("latest");

      // Queue should be empty now
      expect(mq.dequeue(SESSION)).toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // Collect mode — accumulates messages
  // -----------------------------------------------------------------------

  describe("collect mode", () => {
    it("accumulates messages and dequeue returns all as array", () => {
      const mq = new MessageQueue();
      const config = makeConfig({ mode: "collect" });

      mq.enqueue(SESSION, makeMsg({ text: "a" }), "collect", config);
      mq.enqueue(SESSION, makeMsg({ text: "b" }), "collect", config);
      mq.enqueue(SESSION, makeMsg({ text: "c" }), "collect", config);

      const result = mq.dequeue(SESSION);
      expect(Array.isArray(result)).toBe(true);
      const arr = result as InboundMessage[];
      expect(arr).toHaveLength(3);
      expect(arr[0]!.text).toBe("a");
      expect(arr[1]!.text).toBe("b");
      expect(arr[2]!.text).toBe("c");

      // Queue should be empty after drain
      expect(mq.dequeue(SESSION)).toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // Interrupt mode — creates AbortController
  // -----------------------------------------------------------------------

  describe("interrupt mode", () => {
    it("creates an AbortController on enqueue", () => {
      const mq = new MessageQueue();
      const config = makeConfig({ mode: "interrupt" });

      expect(mq.getAbortController(SESSION)).toBeUndefined();

      mq.enqueue(SESSION, makeMsg({ text: "stop" }), "interrupt", config);

      const ac = mq.getAbortController(SESSION);
      expect(ac).toBeInstanceOf(AbortController);
      expect(ac!.signal.aborted).toBe(false);
    });

    it("replaces buffer with latest message", () => {
      const mq = new MessageQueue();
      const config = makeConfig({ mode: "interrupt" });

      mq.enqueue(SESSION, makeMsg({ text: "first" }), "interrupt", config);
      mq.enqueue(SESSION, makeMsg({ text: "second" }), "interrupt", config);

      const result = mq.dequeue(SESSION);
      expect(Array.isArray(result)).toBe(false);
      expect((result as InboundMessage).text).toBe("second");
    });

    it("creates a new AbortController on each enqueue", () => {
      const mq = new MessageQueue();
      const config = makeConfig({ mode: "interrupt" });

      mq.enqueue(SESSION, makeMsg({ text: "a" }), "interrupt", config);
      const ac1 = mq.getAbortController(SESSION);

      mq.enqueue(SESSION, makeMsg({ text: "b" }), "interrupt", config);
      const ac2 = mq.getAbortController(SESSION);

      expect(ac1).not.toBe(ac2);
    });
  });

  // -----------------------------------------------------------------------
  // maxQueueDepth — drops oldest messages
  // -----------------------------------------------------------------------

  describe("maxQueueDepth", () => {
    it("drops oldest messages when depth exceeded in queue mode", () => {
      const mq = new MessageQueue();
      const config = makeConfig({ mode: "queue", maxQueueDepth: 2 });

      mq.enqueue(SESSION, makeMsg({ text: "a" }), "queue", config);
      mq.enqueue(SESSION, makeMsg({ text: "b" }), "queue", config);
      mq.enqueue(SESSION, makeMsg({ text: "c" }), "queue", config);

      // Only the 2 most recent should remain
      const result = mq.dequeue(SESSION);
      expect(Array.isArray(result)).toBe(true);
      const arr = result as InboundMessage[];
      expect(arr).toHaveLength(2);
      expect(arr[0]!.text).toBe("b");
      expect(arr[1]!.text).toBe("c");
    });

    it("drops oldest messages when depth exceeded in collect mode", () => {
      const mq = new MessageQueue();
      const config = makeConfig({ mode: "collect", maxQueueDepth: 3 });

      for (let i = 0; i < 5; i++) {
        mq.enqueue(SESSION, makeMsg({ text: `msg-${i}` }), "collect", config);
      }

      const result = mq.dequeue(SESSION) as InboundMessage[];
      expect(result).toHaveLength(3);
      expect(result[0]!.text).toBe("msg-2");
      expect(result[1]!.text).toBe("msg-3");
      expect(result[2]!.text).toBe("msg-4");
    });
  });

  // -----------------------------------------------------------------------
  // isRunning / setRunning
  // -----------------------------------------------------------------------

  describe("isRunning / setRunning", () => {
    it("defaults to false for unknown session", () => {
      const mq = new MessageQueue();
      expect(mq.isRunning("nonexistent")).toBe(false);
    });

    it("tracks running state", () => {
      const mq = new MessageQueue();
      mq.setRunning(SESSION, true);
      expect(mq.isRunning(SESSION)).toBe(true);

      mq.setRunning(SESSION, false);
      expect(mq.isRunning(SESSION)).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // dequeue returns null for empty queue
  // -----------------------------------------------------------------------

  describe("dequeue empty", () => {
    it("returns null for unknown session", () => {
      const mq = new MessageQueue();
      expect(mq.dequeue("nonexistent")).toBeNull();
    });

    it("returns null after all messages dequeued", () => {
      const mq = new MessageQueue();
      const config = makeConfig({ mode: "queue" });

      mq.enqueue(SESSION, makeMsg(), "queue", config);
      mq.dequeue(SESSION);
      expect(mq.dequeue(SESSION)).toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // clear
  // -----------------------------------------------------------------------

  describe("clear", () => {
    it("removes session queue entirely", () => {
      const mq = new MessageQueue();
      const config = makeConfig({ mode: "queue" });

      mq.enqueue(SESSION, makeMsg(), "queue", config);
      mq.setRunning(SESSION, true);

      mq.clear(SESSION);

      expect(mq.dequeue(SESSION)).toBeNull();
      expect(mq.isRunning(SESSION)).toBe(false);
      expect(mq.getAbortController(SESSION)).toBeUndefined();
    });

    it("is a no-op for unknown session", () => {
      const mq = new MessageQueue();
      // Should not throw
      mq.clear("nonexistent");
    });
  });

  // -----------------------------------------------------------------------
  // drainAll
  // -----------------------------------------------------------------------

  describe("drainAll", () => {
    it("clears all sessions", () => {
      const mq = new MessageQueue();
      const config = makeConfig({ mode: "queue" });

      mq.enqueue("session-a", makeMsg(), "queue", config);
      mq.enqueue("session-b", makeMsg(), "queue", config);
      mq.setRunning("session-a", true);

      mq.drainAll();

      expect(mq.dequeue("session-a")).toBeNull();
      expect(mq.dequeue("session-b")).toBeNull();
      expect(mq.isRunning("session-a")).toBe(false);
    });
  });
});
