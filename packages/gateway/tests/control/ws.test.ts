import { describe, it, expect, afterEach, beforeEach } from "vitest";
import * as http from "node:http";
import WebSocket from "ws";
import { mountWebSocket } from "../../src/control/ws.js";
import { GatewayEventEmitterImpl } from "../../src/events/emitter.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function waitForMessage(ws: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    ws.once("message", (data: WebSocket.Data) => {
      resolve(JSON.parse(data.toString()) as Record<string, unknown>);
    });
  });
}

function waitForOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    if (ws.readyState === WebSocket.OPEN) {
      resolve();
      return;
    }
    ws.once("open", resolve);
    ws.once("error", reject);
  });
}

function waitForClose(ws: WebSocket): Promise<void> {
  return new Promise((resolve) => {
    if (ws.readyState === WebSocket.CLOSED) {
      resolve();
      return;
    }
    ws.once("close", resolve);
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("mountWebSocket", () => {
  let server: http.Server;
  let port: number;
  let cleanup: (() => void) | undefined;

  beforeEach(async () => {
    server = http.createServer();
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const addr = server.address();
    port = typeof addr === "object" && addr !== null ? addr.port : 0;
  });

  afterEach(async () => {
    cleanup?.();
    cleanup = undefined;
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  });

  it("rejects connection with bad token", async () => {
    const emitter = new GatewayEventEmitterImpl();
    const ws_handle = mountWebSocket(server, emitter, "good-token");
    cleanup = ws_handle.closeAll;

    const client = new WebSocket(`ws://127.0.0.1:${port}?token=bad-token`);
    const closePromise = waitForClose(client);

    // We expect the connection to be rejected
    const errorOrClose = await Promise.race([
      new Promise<"error">((resolve) => client.once("error", () => resolve("error"))),
      closePromise.then(() => "close" as const),
    ]);
    expect(["error", "close"]).toContain(errorOrClose);
  });

  it("accepts connection with valid query token", async () => {
    const emitter = new GatewayEventEmitterImpl();
    const ws_handle = mountWebSocket(server, emitter, "good-token");
    cleanup = ws_handle.closeAll;

    const client = new WebSocket(`ws://127.0.0.1:${port}?token=good-token`);
    await waitForOpen(client);
    expect(client.readyState).toBe(WebSocket.OPEN);
    client.close();
  });

  it("accepts connection when no auth is configured", async () => {
    const emitter = new GatewayEventEmitterImpl();
    const ws_handle = mountWebSocket(server, emitter);
    cleanup = ws_handle.closeAll;

    const client = new WebSocket(`ws://127.0.0.1:${port}`);
    await waitForOpen(client);
    expect(client.readyState).toBe(WebSocket.OPEN);
    client.close();
  });

  it("broadcasts events to connected clients", async () => {
    const emitter = new GatewayEventEmitterImpl();
    const ws_handle = mountWebSocket(server, emitter);
    cleanup = ws_handle.closeAll;

    const client = new WebSocket(`ws://127.0.0.1:${port}`);
    await waitForOpen(client);

    const msgPromise = waitForMessage(client);
    emitter.emit("test.event", { foo: "bar" });

    const received = await msgPromise;
    expect(received["type"]).toBe("test.event");
    expect(received["data"]).toEqual({ foo: "bar" });

    client.close();
  });

  it("broadcasts to multiple clients", async () => {
    const emitter = new GatewayEventEmitterImpl();
    const ws_handle = mountWebSocket(server, emitter);
    cleanup = ws_handle.closeAll;

    const client1 = new WebSocket(`ws://127.0.0.1:${port}`);
    const client2 = new WebSocket(`ws://127.0.0.1:${port}`);
    await Promise.all([waitForOpen(client1), waitForOpen(client2)]);

    const msg1 = waitForMessage(client1);
    const msg2 = waitForMessage(client2);
    emitter.emit("broadcast", { n: 1 });

    const [r1, r2] = await Promise.all([msg1, msg2]);
    expect(r1["type"]).toBe("broadcast");
    expect(r2["type"]).toBe("broadcast");

    client1.close();
    client2.close();
  });

  it("scrubs sensitive fields in event data", async () => {
    const emitter = new GatewayEventEmitterImpl();
    const ws_handle = mountWebSocket(server, emitter);
    cleanup = ws_handle.closeAll;

    const client = new WebSocket(`ws://127.0.0.1:${port}`);
    await waitForOpen(client);

    const msgPromise = waitForMessage(client);
    emitter.emit("config.update", {
      apiToken: "secret-value",
      password: "hunter2",
      secretKey: "abc",
      authorization: "Bearer xyz",
      normalField: "visible",
      nested: {
        innerSecret: "hidden",
        innerNormal: "shown",
      },
    });

    const received = await msgPromise;
    const data = received["data"] as Record<string, unknown>;
    expect(data["apiToken"]).toBe("[REDACTED]");
    expect(data["password"]).toBe("[REDACTED]");
    expect(data["secretKey"]).toBe("[REDACTED]");
    expect(data["authorization"]).toBe("[REDACTED]");
    expect(data["normalField"]).toBe("visible");

    const nested = data["nested"] as Record<string, unknown>;
    expect(nested["innerSecret"]).toBe("[REDACTED]");
    expect(nested["innerNormal"]).toBe("shown");

    client.close();
  });

  it("closeAll closes all connections", async () => {
    const emitter = new GatewayEventEmitterImpl();
    const ws_handle = mountWebSocket(server, emitter);

    const client1 = new WebSocket(`ws://127.0.0.1:${port}`);
    const client2 = new WebSocket(`ws://127.0.0.1:${port}`);
    await Promise.all([waitForOpen(client1), waitForOpen(client2)]);

    const close1 = waitForClose(client1);
    const close2 = waitForClose(client2);

    ws_handle.closeAll();
    cleanup = undefined; // Already cleaned up

    await Promise.all([close1, close2]);
    expect(client1.readyState).toBe(WebSocket.CLOSED);
    expect(client2.readyState).toBe(WebSocket.CLOSED);
  });

  it("removes client from set on disconnect", async () => {
    const emitter = new GatewayEventEmitterImpl();
    const ws_handle = mountWebSocket(server, emitter);
    cleanup = ws_handle.closeAll;

    const client = new WebSocket(`ws://127.0.0.1:${port}`);
    await waitForOpen(client);

    // Close client
    client.close();
    await waitForClose(client);

    // Give the server a moment to process the close
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Connect a new client and verify events still work
    const client2 = new WebSocket(`ws://127.0.0.1:${port}`);
    await waitForOpen(client2);

    const msgPromise = waitForMessage(client2);
    emitter.emit("after.disconnect", { check: true });
    const received = await msgPromise;
    expect(received["type"]).toBe("after.disconnect");

    client2.close();
  });
});
