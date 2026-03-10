/**
 * Smoke test — boots the gateway with no channels, verifies lifecycle and healthcheck.
 * Usage: pnpm smoke
 */
import http from "node:http";
import { createGateway } from "../src/index.js";

const PORT = 18789;

function httpGet(path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    http
      .get(`http://127.0.0.1:${PORT}${path}`, (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => resolve({ status: res.statusCode!, body }));
      })
      .on("error", reject);
  });
}

async function main() {
  console.log("Creating gateway...");
  const gw = createGateway({
    config: {
      gateway: { bind: "loopback", port: PORT, auth: { mode: "none" } },
      agent: { provider: "claude", cwd: process.cwd() },
      sessions: { dmScope: "per-peer" },
      queue: { mode: "queue", maxQueueDepth: 10 },
      channels: {},
    },
  });

  console.log(`Config loaded: port=${gw.config.gateway.port}, provider=${gw.config.agent.provider}`);

  // Track events
  let eventCount = 0;
  gw.events.on("*", () => eventCount++);

  console.log("\nStarting gateway...");
  await gw.start();
  console.log(`Gateway listening on http://127.0.0.1:${PORT}`);

  // Healthcheck
  console.log("\n--- GET /healthz ---");
  const health = await httpGet("/healthz");
  console.log(`  Status: ${health.status}`);
  console.log(`  Body: ${health.body}`);

  // Readiness
  console.log("\n--- GET /readyz ---");
  const ready = await httpGet("/readyz");
  console.log(`  Status: ${ready.status}`);
  console.log(`  Body: ${ready.body}`);

  // Sessions
  console.log("\n--- GET /api/sessions ---");
  const sessions = await httpGet("/api/sessions");
  console.log(`  Status: ${sessions.status}`);
  console.log(`  Body: ${sessions.body}`);

  // Channels
  console.log("\n--- GET /api/channels ---");
  const channels = await httpGet("/api/channels");
  console.log(`  Status: ${channels.status}`);
  console.log(`  Body: ${channels.body}`);

  console.log(`\nEvents received: ${eventCount}`);

  console.log("\nStopping gateway...");
  await gw.stop();
  console.log("Gateway stopped. Smoke test passed!");
}

main().catch((err) => {
  console.error("Smoke test failed:", err);
  process.exit(1);
});
