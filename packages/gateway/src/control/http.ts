import type { Server, IncomingMessage, ServerResponse } from "node:http";

// ---------------------------------------------------------------------------
// Context interface — decoupled from concrete implementations
// ---------------------------------------------------------------------------

export interface ControlApiContext {
  channelRegistry: {
    getAll(): Array<{
      id: string;
      status(): Promise<{ ok: boolean; error?: string }>;
    }>;
  };
  sessionStore: {
    getAll(): Array<Record<string, unknown>>;
    get(key: string): Record<string, unknown> | undefined;
    set(key: string, entry: Record<string, unknown>): void;
    persist(): Promise<void>;
  };
  pairingStore: {
    getAll(): Array<Record<string, unknown>>;
    get(id: string): Record<string, unknown> | undefined;
    approve(id: string): unknown[];
    deny(id: string): void;
  };
  config: Record<string, unknown>;
  authToken?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type RouteHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
) => void | Promise<void>;

function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
): void {
  const json = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(json);
}

function parseBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      try {
        const text = Buffer.concat(chunks).toString("utf-8");
        if (text.length === 0) {
          resolve({});
          return;
        }
        resolve(JSON.parse(text) as Record<string, unknown>);
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

const SENSITIVE_KEY_PATTERN = /token|secret|password|key|auth/i;

function redactSecrets(obj: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === "string" && SENSITIVE_KEY_PATTERN.test(k)) {
      result[k] = "[REDACTED]";
    } else if (v !== null && typeof v === "object" && !Array.isArray(v)) {
      result[k] = redactSecrets(v as Record<string, unknown>);
    } else {
      result[k] = v;
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Route matching
// ---------------------------------------------------------------------------

interface Route {
  method: string;
  segments: string[];
  paramNames: string[];
  handler: RouteHandler;
}

function compileRoute(
  key: string,
  handler: RouteHandler,
): Route {
  const [method, ...pathParts] = key.split(" ");
  const pathStr = pathParts.join(" ");
  const segments = pathStr!.split("/").filter(Boolean);
  const paramNames: string[] = [];
  for (const seg of segments) {
    if (seg.startsWith(":")) {
      paramNames.push(seg.slice(1));
    }
  }
  return { method: method!, segments, paramNames, handler };
}

function matchRoute(
  routes: Route[],
  method: string,
  pathname: string,
): { route: Route; params: Record<string, string> } | undefined {
  const reqSegments = pathname.split("/").filter(Boolean);
  for (const route of routes) {
    if (route.method !== method) continue;
    if (route.segments.length !== reqSegments.length) continue;

    const params: Record<string, string> = {};
    let matched = true;
    for (let i = 0; i < route.segments.length; i++) {
      const routeSeg = route.segments[i]!;
      const reqSeg = reqSegments[i]!;
      if (routeSeg.startsWith(":")) {
        params[routeSeg.slice(1)] = reqSeg;
      } else if (routeSeg !== reqSeg) {
        matched = false;
        break;
      }
    }
    if (matched) {
      return { route, params };
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// mountControlRoutes
// ---------------------------------------------------------------------------

export function mountControlRoutes(
  server: Server,
  ctx: ControlApiContext,
): void {
  const routeTable: Record<string, RouteHandler> = {
    "GET /healthz": (_req, res) => {
      sendJson(res, 200, { ok: true });
    },

    "GET /readyz": async (_req, res) => {
      const channels = ctx.channelRegistry.getAll();
      const statuses = await Promise.all(
        channels.map(async (ch) => {
          const s = await ch.status();
          return { id: ch.id, ...s };
        }),
      );
      const allOk = statuses.every((s) => s.ok);
      sendJson(res, allOk ? 200 : 503, { ok: allOk, channels: statuses });
    },

    "GET /api/channels": async (_req, res) => {
      const channels = ctx.channelRegistry.getAll();
      const result = await Promise.all(
        channels.map(async (ch) => {
          const s = await ch.status();
          return { id: ch.id, ...s };
        }),
      );
      sendJson(res, 200, result);
    },

    "GET /api/sessions": (_req, res) => {
      sendJson(res, 200, ctx.sessionStore.getAll());
    },

    "POST /api/sessions/:key/send": async (req, res, params) => {
      const body = await parseBody(req);
      const _key = params["key"];
      // Actual queue injection is done by the caller — we just acknowledge
      sendJson(res, 200, { ok: true, key: _key, body });
    },

    "POST /api/sessions/:key/reset": async (_req, res, params) => {
      const key = params["key"]!;
      const entry = ctx.sessionStore.get(key);
      if (!entry) {
        sendJson(res, 404, { error: "session not found" });
        return;
      }
      entry["sessionParams"] = null;
      ctx.sessionStore.set(key, entry);
      await ctx.sessionStore.persist();
      sendJson(res, 200, { ok: true });
    },

    "GET /api/pairings": (_req, res) => {
      sendJson(res, 200, ctx.pairingStore.getAll());
    },

    "POST /api/pairings/:id/approve": (_req, res, params) => {
      const id = params["id"]!;
      const pairing = ctx.pairingStore.get(id);
      if (!pairing) {
        sendJson(res, 404, { error: "pairing not found" });
        return;
      }
      const released = ctx.pairingStore.approve(id);
      sendJson(res, 200, { ok: true, released });
    },

    "POST /api/pairings/:id/deny": (_req, res, params) => {
      const id = params["id"]!;
      const pairing = ctx.pairingStore.get(id);
      if (!pairing) {
        sendJson(res, 404, { error: "pairing not found" });
        return;
      }
      ctx.pairingStore.deny(id);
      sendJson(res, 200, { ok: true });
    },

    "GET /api/config": (_req, res) => {
      sendJson(res, 200, redactSecrets(ctx.config));
    },

    "PATCH /api/config": async (req, res) => {
      const body = await parseBody(req);
      if (typeof body !== "object" || body === null) {
        sendJson(res, 400, { error: "invalid body" });
        return;
      }
      // Merge partial update
      for (const [k, v] of Object.entries(body)) {
        ctx.config[k] = v;
      }
      // Fields that would require a restart
      const restartFields = ["gateway", "agent", "agents"];
      const requiresRestart = Object.keys(body).some((k) =>
        restartFields.includes(k),
      );
      sendJson(res, 200, { applied: true, requiresRestart });
    },
  };

  // No-auth routes
  const noAuthRoutes = new Set(["GET /healthz"]);

  // Compile routes
  const routes = Object.entries(routeTable).map(([key, handler]) =>
    compileRoute(key, handler),
  );

  // Compile no-auth route keys for matching
  const noAuthSegments = new Set(
    [...noAuthRoutes].map((k) => {
      const parts = k.split(" ");
      return parts[1]!;
    }),
  );

  server.on("request", (req: IncomingMessage, res: ServerResponse) => {
    const urlObj = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const pathname = urlObj.pathname;
    const method = req.method ?? "GET";

    // Auth check
    if (ctx.authToken) {
      const isHealthz = noAuthSegments.has(pathname);
      if (!isHealthz) {
        const authHeader = req.headers["authorization"];
        const token = authHeader?.startsWith("Bearer ")
          ? authHeader.slice(7)
          : undefined;
        if (token !== ctx.authToken) {
          sendJson(res, 401, { error: "unauthorized" });
          return;
        }
      }
    }

    const match = matchRoute(routes, method, pathname);
    if (!match) {
      sendJson(res, 404, { error: "not found" });
      return;
    }

    // Run handler, catching async errors
    const maybePromise = match.route.handler(req, res, match.params);
    if (maybePromise instanceof Promise) {
      maybePromise.catch((err: unknown) => {
        sendJson(res, 500, {
          error: "internal server error",
          message: err instanceof Error ? err.message : String(err),
        });
      });
    }
  });
}
