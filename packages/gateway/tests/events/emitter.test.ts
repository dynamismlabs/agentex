import { describe, it, expect, vi } from "vitest";
import { GatewayEventEmitterImpl } from "../../src/events/emitter.js";
import type { GatewayEventPayload } from "../../src/types.js";

describe("GatewayEventEmitterImpl", () => {
  it("calls subscribed handler on emit", () => {
    const emitter = new GatewayEventEmitterImpl();
    const handler = vi.fn();

    emitter.on("test.event", handler);
    emitter.emit("test.event", { foo: "bar" });

    expect(handler).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "test.event",
        data: { foo: "bar" },
      }),
    );
  });

  it("does not call handlers for other event types", () => {
    const emitter = new GatewayEventEmitterImpl();
    const handler = vi.fn();

    emitter.on("type.a", handler);
    emitter.emit("type.b", {});

    expect(handler).not.toHaveBeenCalled();
  });

  it("increments seq on each emit", () => {
    const emitter = new GatewayEventEmitterImpl();
    const payloads: GatewayEventPayload[] = [];
    const handler = (p: GatewayEventPayload) => payloads.push(p);

    emitter.on("e", handler);
    emitter.emit("e", {});
    emitter.emit("e", {});
    emitter.emit("e", {});

    expect(payloads).toHaveLength(3);
    expect(payloads[0]!.seq).toBe(1);
    expect(payloads[1]!.seq).toBe(2);
    expect(payloads[2]!.seq).toBe(3);
  });

  it("seq increments even across different event types", () => {
    const emitter = new GatewayEventEmitterImpl();
    const payloads: GatewayEventPayload[] = [];
    const handler = (p: GatewayEventPayload) => payloads.push(p);

    emitter.on("*", handler);
    emitter.emit("a", {});
    emitter.emit("b", {});

    expect(payloads[0]!.seq).toBe(1);
    expect(payloads[1]!.seq).toBe(2);
  });

  it("includes sessionKey when provided", () => {
    const emitter = new GatewayEventEmitterImpl();
    const handler = vi.fn();

    emitter.on("e", handler);
    emitter.emit("e", {}, "session-123");

    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ sessionKey: "session-123" }),
    );
  });

  it("omits sessionKey when not provided", () => {
    const emitter = new GatewayEventEmitterImpl();
    const handler = vi.fn();

    emitter.on("e", handler);
    emitter.emit("e", {});

    const payload = handler.mock.calls[0]![0] as GatewayEventPayload;
    expect(payload).not.toHaveProperty("sessionKey");
  });

  it("includes ts as a number", () => {
    const emitter = new GatewayEventEmitterImpl();
    const handler = vi.fn();

    emitter.on("e", handler);
    const before = Date.now();
    emitter.emit("e", {});
    const after = Date.now();

    const payload = handler.mock.calls[0]![0] as GatewayEventPayload;
    expect(payload.ts).toBeGreaterThanOrEqual(before);
    expect(payload.ts).toBeLessThanOrEqual(after);
  });

  it("calls wildcard handlers for all events", () => {
    const emitter = new GatewayEventEmitterImpl();
    const wildcard = vi.fn();

    emitter.on("*", wildcard);
    emitter.emit("foo", { a: 1 });
    emitter.emit("bar", { b: 2 });

    expect(wildcard).toHaveBeenCalledTimes(2);
    expect(wildcard).toHaveBeenCalledWith(
      expect.objectContaining({ type: "foo" }),
    );
    expect(wildcard).toHaveBeenCalledWith(
      expect.objectContaining({ type: "bar" }),
    );
  });

  it("calls both type-specific and wildcard handlers", () => {
    const emitter = new GatewayEventEmitterImpl();
    const specific = vi.fn();
    const wildcard = vi.fn();

    emitter.on("e", specific);
    emitter.on("*", wildcard);
    emitter.emit("e", {});

    expect(specific).toHaveBeenCalledOnce();
    expect(wildcard).toHaveBeenCalledOnce();
  });

  it("removes handler with off", () => {
    const emitter = new GatewayEventEmitterImpl();
    const handler = vi.fn();

    emitter.on("e", handler);
    emitter.emit("e", {});
    expect(handler).toHaveBeenCalledOnce();

    emitter.off("e", handler);
    emitter.emit("e", {});
    expect(handler).toHaveBeenCalledOnce(); // still just 1
  });

  it("off does nothing when handler was never registered", () => {
    const emitter = new GatewayEventEmitterImpl();
    const handler = vi.fn();

    // Should not throw
    emitter.off("e", handler);
  });

  it("off does nothing for unknown event type", () => {
    const emitter = new GatewayEventEmitterImpl();
    const handler = vi.fn();

    emitter.on("a", handler);
    emitter.off("b", handler); // different type — no effect

    emitter.emit("a", {});
    expect(handler).toHaveBeenCalledOnce();
  });

  it("supports multiple handlers for the same type", () => {
    const emitter = new GatewayEventEmitterImpl();
    const h1 = vi.fn();
    const h2 = vi.fn();

    emitter.on("e", h1);
    emitter.on("e", h2);
    emitter.emit("e", {});

    expect(h1).toHaveBeenCalledOnce();
    expect(h2).toHaveBeenCalledOnce();
  });

  it("removing one handler does not affect others", () => {
    const emitter = new GatewayEventEmitterImpl();
    const h1 = vi.fn();
    const h2 = vi.fn();

    emitter.on("e", h1);
    emitter.on("e", h2);

    emitter.off("e", h1);
    emitter.emit("e", {});

    expect(h1).not.toHaveBeenCalled();
    expect(h2).toHaveBeenCalledOnce();
  });

  it("emitting with no listeners does not throw", () => {
    const emitter = new GatewayEventEmitterImpl();
    expect(() => emitter.emit("unheard", {})).not.toThrow();
  });
});
