import { createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { defineChannel } from "../define.js";
import { renderGatewayTemplate } from "../../utils/template.js";
import type { ChannelContext, InboundMessage } from "../../types.js";

interface WebhookRoute {
  path: string;
  sessionKey: string;
  promptTemplate?: string;
  hmacHeader?: string;
  hmacAlgo?: string;
}

interface WebhookConfig {
  hmacSecret?: string;
  routes: WebhookRoute[];
}

export default defineChannel({
  id: "webhook",
  label: "Webhook",
  capabilities: {
    chatTypes: ["direct"],
    streaming: false,
  },

  async start(ctx: ChannelContext) {
    const config = ctx.config as unknown as WebhookConfig;
    const routes = config.routes ?? [];
    const hmacSecret = config.hmacSecret as string | undefined;

    const server = ctx.httpServer;

    // Store existing listeners so we can chain
    const existingListeners = server.listeners("request").slice();

    server.removeAllListeners("request");

    server.on("request", (req: IncomingMessage, res: ServerResponse) => {
      const url = req.url ?? "";
      const method = req.method ?? "GET";

      // Check if this is a webhook route
      const route = routes.find((r) => url === r.path || url.startsWith(r.path + "?"));

      if (route && method === "POST") {
        handleWebhook(req, res, route, hmacSecret, ctx).catch((err) => {
          ctx.log.error(`Webhook error on ${route.path}: ${String(err)}`);
          if (!res.headersSent) {
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Internal server error" }));
          }
        });
        return;
      }

      // Pass through to existing listeners (control API, etc.)
      for (const listener of existingListeners) {
        (listener as (req: IncomingMessage, res: ServerResponse) => void)(req, res);
      }
    });

    ctx.log.info(`Webhook channel started with ${routes.length} route(s)`);
  },

  async stop() {
    // Nothing to clean up — routes are on the shared HTTP server
  },

  async status() {
    return { ok: true };
  },

  async send() {
    // Webhooks are typically one-way (inbound only)
    return { ok: true };
  },
});

async function handleWebhook(
  req: IncomingMessage,
  res: ServerResponse,
  route: WebhookRoute,
  hmacSecret: string | undefined,
  ctx: ChannelContext,
): Promise<void> {
  // Collect raw body
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  const rawBody = Buffer.concat(chunks);

  // HMAC validation
  if (route.hmacHeader && hmacSecret) {
    const algo = route.hmacAlgo ?? "sha256";
    const signature = req.headers[route.hmacHeader.toLowerCase()] as string | undefined;

    if (!signature) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Missing HMAC signature" }));
      return;
    }

    const computed = createHmac(algo, hmacSecret).update(rawBody).digest("hex");

    // Handle signatures that may have a prefix like "sha256="
    const signatureValue = signature.includes("=")
      ? signature.split("=").slice(1).join("=")
      : signature;

    try {
      const a = Buffer.from(computed, "hex");
      const b = Buffer.from(signatureValue, "hex");
      if (a.length !== b.length || !timingSafeEqual(a, b)) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid HMAC signature" }));
        return;
      }
    } catch {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid HMAC signature" }));
      return;
    }
  }

  // Parse body
  let body: unknown;
  try {
    body = JSON.parse(rawBody.toString("utf-8"));
  } catch {
    body = rawBody.toString("utf-8");
  }

  // Render prompt template
  const promptData = {
    event: {
      headers: Object.fromEntries(
        Object.entries(req.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(", ") : v]),
      ),
      body,
    },
  };

  const text = route.promptTemplate
    ? renderGatewayTemplate(route.promptTemplate, promptData)
    : typeof body === "string" ? body : JSON.stringify(body);

  // Dispatch as InboundMessage
  const msg: InboundMessage = {
    messageId: `webhook-${Date.now()}`,
    channel: "webhook",
    senderId: "webhook",
    chatType: "direct",
    target: route.sessionKey,
    text,
    timestamp: Date.now(),
    raw: { headers: req.headers, body },
  };

  ctx.onMessage(msg);

  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok: true }));
}
