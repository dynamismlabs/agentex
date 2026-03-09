import type { Server, IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, WebSocket } from "ws";
import type { GatewayEventEmitter, GatewayEventPayload } from "../types.js";

// ---------------------------------------------------------------------------
// Sensitive-field scrubbing
// ---------------------------------------------------------------------------

const SENSITIVE_KEY_PATTERN = /token|secret|key|password|authorization/i;

function scrubSensitive(obj: unknown): unknown {
  if (obj === null || obj === undefined) return obj;
  if (Array.isArray(obj)) return obj.map(scrubSensitive);
  if (typeof obj === "object") {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      if (typeof v === "string" && SENSITIVE_KEY_PATTERN.test(k)) {
        result[k] = "[REDACTED]";
      } else if (v !== null && typeof v === "object") {
        result[k] = scrubSensitive(v);
      } else {
        result[k] = v;
      }
    }
    return result;
  }
  return obj;
}

// ---------------------------------------------------------------------------
// mountWebSocket
// ---------------------------------------------------------------------------

export function mountWebSocket(
  server: Server,
  events: GatewayEventEmitter,
  authToken?: string,
): { closeAll(): void } {
  const wss = new WebSocketServer({ noServer: true });
  const clients = new Set<WebSocket>();

  // Wildcard listener — broadcast to all connected clients
  const handler = (payload: GatewayEventPayload): void => {
    const scrubbed = scrubSensitive(payload) as GatewayEventPayload;
    const message = JSON.stringify(scrubbed);
    for (const ws of clients) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(message);
      }
    }
  };
  events.on("*", handler);

  // Handle upgrade
  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    // Auth check
    if (authToken) {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
      const tokenFromQuery = url.searchParams.get("token");
      const authHeader = req.headers["authorization"];
      const tokenFromHeader = authHeader?.startsWith("Bearer ")
        ? authHeader.slice(7)
        : undefined;

      const providedToken = tokenFromQuery ?? tokenFromHeader;
      if (providedToken !== authToken) {
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      clients.add(ws);

      ws.on("close", () => {
        clients.delete(ws);
      });

      ws.on("error", () => {
        clients.delete(ws);
      });

      wss.emit("connection", ws, req);
    });
  });

  return {
    closeAll(): void {
      events.off("*", handler);
      for (const ws of clients) {
        ws.close();
      }
      clients.clear();
      wss.close();
    },
  };
}
