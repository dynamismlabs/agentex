/**
 * Start the gateway with a config file for manual testing.
 *
 * Usage:
 *   pnpm dev                          # loads ./agentex.yaml
 *   pnpm dev -- --config path/to.yaml # custom config
 *
 * Example agentex.yaml for Telegram:
 *
 *   gateway:
 *     port: 18789
 *     bind: loopback
 *     auth:
 *       mode: none
 *
 *   agent:
 *     adapter: claude
 *     cwd: /path/to/workspace
 *     skipPermissions: true
 *     maxTurns: 5
 *
 *   sessions:
 *     dmScope: per-peer
 *
 *   queue:
 *     mode: queue
 *
 *   channels:
 *     telegram:
 *       token: $TELEGRAM_BOT_TOKEN
 *       dm:
 *         policy: open
 */
import { resolve } from "node:path";
import { createGateway } from "../src/index.js";

const args = process.argv.slice(2);
const configIdx = args.indexOf("--config");
const configPath = configIdx >= 0 && args[configIdx + 1]
  ? resolve(args[configIdx + 1])
  : resolve("agentex.yaml");

console.log(`Loading config from: ${configPath}`);

const gw = createGateway({ configPath });

console.log(`Config: port=${gw.config.gateway.port}, adapter=${gw.config.agent.adapter}`);
console.log(`Channels: ${Object.keys(gw.config.channels).join(", ") || "(none)"}`);

gw.events.on("*", (payload) => {
  const summary = JSON.stringify(payload.data).slice(0, 120);
  console.log(`[event] ${payload.type} ${payload.sessionKey ?? ""} ${summary}`);
});

await gw.start();
console.log(`\nGateway running on http://127.0.0.1:${gw.config.gateway.port}`);
console.log("Press Ctrl+C to stop.\n");
