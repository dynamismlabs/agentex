import { describe, it, expect, afterEach, beforeEach } from "vitest";
import * as http from "node:http";
import { mountControlRoutes } from "../../src/control/http.js";
import type { ControlApiContext } from "../../src/control/http.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockContext(overrides?: Partial<ControlApiContext>): ControlApiContext {
  return {
    channelRegistry: {
      getAll: () => [
        { id: "telegram", status: async () => ({ ok: true }) },
        { id: "slack", status: async () => ({ ok: true }) },
      ],
    },
    sessionStore: {
      getAll: () => [
        { key: "s1", sessionParams: null, lastChannel: "telegram" },
        { key: "s2", sessionParams: { model: "claude-4" }, lastChannel: "slack" },
      ],
      get: (key: string) => {
        if (key === "s1") return { key: "s1", sessionParams: { foo: "bar" }, lastChannel: "telegram" };
        return undefined;
      },
      set: () => {},
      persist: async () => {},
    },
    pairingStore: {
      getAll: () => [{ id: "p1", senderId: "user-1", channel: "telegram" }],
      get: (id: string) => {
        if (id === "p1") return { id: "p1", senderId: "user-1", channel: "telegram", heldMessages: [] };
        return undefined;
      },
      approve: (id: string) => {
        if (id === "p1") return [{ text: "hello" }];
        return [];
      },
      deny: () => {},
    },
    config: {
      gateway: { bind: "loopback", port: 9090, auth: { mode: "token", token: "super-secret" } },
      agent: { adapter: "claude", cwd: "/tmp", secretKey: "abc123" },
      sessions: { dmScope: "main" },
      apiKey: "sk-12345",
      normalValue: "visible",
    },
    authToken: "test-token-123",
    ...overrides,
  };
}

function request(
  port: number,
  method: string,
  path: string,
  opts?: { body?: unknown; token?: string },
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {};
    if (opts?.token) {
      headers["Authorization"] = `Bearer ${opts.token}`;
    }
    let bodyStr: string | undefined;
    if (opts?.body !== undefined) {
      bodyStr = JSON.stringify(opts.body);
      headers["Content-Type"] = "application/json";
    }

    const req = http.request(
      { hostname: "127.0.0.1", port, path, method, headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf-8");
          try {
            resolve({ status: res.statusCode!, body: JSON.parse(text) });
          } catch {
            resolve({ status: res.statusCode!, body: text });
          }
        });
      },
    );
    req.on("error", reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("mountControlRoutes", () => {
  let server: http.Server;
  let port: number;

  beforeEach(async () => {
    server = http.createServer();
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const addr = server.address();
    port = typeof addr === "object" && addr !== null ? addr.port : 0;
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  });

  it("GET /healthz returns 200 without auth", async () => {
    const ctx = createMockContext();
    mountControlRoutes(server, ctx);

    const res = await request(port, "GET", "/healthz");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it("rejects requests without auth token", async () => {
    const ctx = createMockContext();
    mountControlRoutes(server, ctx);

    const res = await request(port, "GET", "/api/sessions");
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "unauthorized" });
  });

  it("rejects requests with wrong auth token", async () => {
    const ctx = createMockContext();
    mountControlRoutes(server, ctx);

    const res = await request(port, "GET", "/api/sessions", { token: "wrong" });
    expect(res.status).toBe(401);
  });

  it("allows requests with correct auth token", async () => {
    const ctx = createMockContext();
    mountControlRoutes(server, ctx);

    const res = await request(port, "GET", "/api/sessions", {
      token: "test-token-123",
    });
    expect(res.status).toBe(200);
  });

  it("skips auth when no authToken is configured", async () => {
    const ctx = createMockContext({ authToken: undefined });
    mountControlRoutes(server, ctx);

    const res = await request(port, "GET", "/api/sessions");
    expect(res.status).toBe(200);
  });

  it("GET /api/sessions returns sessions", async () => {
    const ctx = createMockContext();
    mountControlRoutes(server, ctx);

    const res = await request(port, "GET", "/api/sessions", {
      token: "test-token-123",
    });
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
  });

  it("GET /readyz returns 200 when all channels are ok", async () => {
    const ctx = createMockContext();
    mountControlRoutes(server, ctx);

    const res = await request(port, "GET", "/readyz", {
      token: "test-token-123",
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual(
      expect.objectContaining({ ok: true }),
    );
  });

  it("GET /readyz returns 503 when a channel is not ok", async () => {
    const ctx = createMockContext({
      channelRegistry: {
        getAll: () => [
          { id: "telegram", status: async () => ({ ok: true }) },
          { id: "slack", status: async () => ({ ok: false, error: "disconnected" }) },
        ],
      },
    });
    mountControlRoutes(server, ctx);

    const res = await request(port, "GET", "/readyz", {
      token: "test-token-123",
    });
    expect(res.status).toBe(503);
    expect(res.body).toEqual(
      expect.objectContaining({ ok: false }),
    );
  });

  it("GET /api/channels returns channel list with status", async () => {
    const ctx = createMockContext();
    mountControlRoutes(server, ctx);

    const res = await request(port, "GET", "/api/channels", {
      token: "test-token-123",
    });
    expect(res.status).toBe(200);
    const body = res.body as Array<{ id: string; ok: boolean }>;
    expect(body).toHaveLength(2);
    expect(body[0]).toEqual(expect.objectContaining({ id: "telegram", ok: true }));
  });

  it("GET /api/pairings returns pending pairings", async () => {
    const ctx = createMockContext();
    mountControlRoutes(server, ctx);

    const res = await request(port, "GET", "/api/pairings", {
      token: "test-token-123",
    });
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
  });

  it("POST /api/pairings/:id/approve calls approve and returns released", async () => {
    const ctx = createMockContext();
    mountControlRoutes(server, ctx);

    const res = await request(port, "POST", "/api/pairings/p1/approve", {
      token: "test-token-123",
    });
    expect(res.status).toBe(200);
    const body = res.body as { ok: boolean; released: unknown[] };
    expect(body.ok).toBe(true);
    expect(body.released).toEqual([{ text: "hello" }]);
  });

  it("POST /api/pairings/:id/approve returns 404 for unknown id", async () => {
    const ctx = createMockContext();
    mountControlRoutes(server, ctx);

    const res = await request(port, "POST", "/api/pairings/unknown/approve", {
      token: "test-token-123",
    });
    expect(res.status).toBe(404);
  });

  it("POST /api/pairings/:id/deny denies pairing", async () => {
    const ctx = createMockContext();
    mountControlRoutes(server, ctx);

    const res = await request(port, "POST", "/api/pairings/p1/deny", {
      token: "test-token-123",
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it("GET /api/config redacts secrets", async () => {
    const ctx = createMockContext();
    mountControlRoutes(server, ctx);

    const res = await request(port, "GET", "/api/config", {
      token: "test-token-123",
    });
    expect(res.status).toBe(200);

    const body = res.body as Record<string, unknown>;
    // Top-level key matching pattern
    expect(body["apiKey"]).toBe("[REDACTED]");
    // Normal value preserved
    expect(body["normalValue"]).toBe("visible");
    // Nested object secret redacted
    const agent = body["agent"] as Record<string, unknown>;
    expect(agent["secretKey"]).toBe("[REDACTED]");
    expect(agent["adapter"]).toBe("claude");
    // Auth nested
    const gw = body["gateway"] as Record<string, unknown>;
    const auth = gw["auth"] as Record<string, unknown>;
    expect(auth["token"]).toBe("[REDACTED]");
  });

  it("PATCH /api/config merges update and returns applied", async () => {
    const ctx = createMockContext();
    mountControlRoutes(server, ctx);

    const res = await request(port, "PATCH", "/api/config", {
      token: "test-token-123",
      body: { sessions: { dmScope: "per-peer" } },
    });
    expect(res.status).toBe(200);
    const body = res.body as { applied: boolean; requiresRestart: boolean };
    expect(body.applied).toBe(true);
    expect(body.requiresRestart).toBe(false);
  });

  it("PATCH /api/config flags requiresRestart for gateway changes", async () => {
    const ctx = createMockContext();
    mountControlRoutes(server, ctx);

    const res = await request(port, "PATCH", "/api/config", {
      token: "test-token-123",
      body: { gateway: { port: 8080 } },
    });
    expect(res.status).toBe(200);
    const body = res.body as { applied: boolean; requiresRestart: boolean };
    expect(body.requiresRestart).toBe(true);
  });

  it("POST /api/sessions/:key/send accepts JSON body", async () => {
    const ctx = createMockContext();
    mountControlRoutes(server, ctx);

    const res = await request(port, "POST", "/api/sessions/s1/send", {
      token: "test-token-123",
      body: { text: "hello" },
    });
    expect(res.status).toBe(200);
    const body = res.body as { ok: boolean; key: string };
    expect(body.ok).toBe(true);
    expect(body.key).toBe("s1");
  });

  it("POST /api/sessions/:key/reset clears sessionParams", async () => {
    let persistCalled = false;
    let setEntry: Record<string, unknown> | undefined;
    const ctx = createMockContext({
      sessionStore: {
        getAll: () => [],
        get: (key: string) => {
          if (key === "s1") return { key: "s1", sessionParams: { model: "test" }, lastChannel: "tg" };
          return undefined;
        },
        set: (_key: string, entry: Record<string, unknown>) => {
          setEntry = entry;
        },
        persist: async () => {
          persistCalled = true;
        },
      },
    });
    mountControlRoutes(server, ctx);

    const res = await request(port, "POST", "/api/sessions/s1/reset", {
      token: "test-token-123",
    });
    expect(res.status).toBe(200);
    expect(setEntry?.["sessionParams"]).toBeNull();
    expect(persistCalled).toBe(true);
  });

  it("POST /api/sessions/:key/reset returns 404 for unknown session", async () => {
    const ctx = createMockContext();
    mountControlRoutes(server, ctx);

    const res = await request(port, "POST", "/api/sessions/unknown/reset", {
      token: "test-token-123",
    });
    expect(res.status).toBe(404);
  });

  it("returns 404 for unknown routes", async () => {
    const ctx = createMockContext();
    mountControlRoutes(server, ctx);

    const res = await request(port, "GET", "/api/unknown", {
      token: "test-token-123",
    });
    expect(res.status).toBe(404);
  });
});
