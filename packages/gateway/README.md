# @agentex/gateway

Multi-channel AI agent communication gateway. Connect AI agents to Telegram, Discord, Slack, WhatsApp, email, webhooks, and cron — with a single YAML config.

## Install

```bash
npm install @agentex/gateway @agentex/agent
```

Install channel peer dependencies as needed:

```bash
npm install node-telegram-bot-api  # for Telegram
npm install discord.js             # for Discord
npm install @slack/bolt            # for Slack
```

## Quick Start

**1. Create `agentex.yaml`:**

```yaml
gateway:
  port: 18789
  bind: loopback
  auth:
    mode: none

agent:
  provider: claude
  cwd: .
  skipPermissions: true
  maxTurns: 5
  timeoutSec: 120

sessions:
  dmScope: per-peer

queue:
  mode: queue

channels:
  telegram:
    token: $TELEGRAM_BOT_TOKEN
    dm:
      policy: open
```

**2. Create `.env`:**

```
TELEGRAM_BOT_TOKEN=your-token-from-botfather
```

**3. Run:**

```typescript
import { createGateway } from "@agentex/gateway";

const gw = createGateway({ configPath: "./agentex.yaml" });

gw.events.on("*", (payload) => {
  console.log(`[${payload.type}]`, JSON.stringify(payload.data).slice(0, 120));
});

await gw.start();
// Gateway is now listening and forwarding messages to your agent
```

Or use the dev script:

```bash
node --env-file=.env --import=tsx/esm scripts/dev.ts
```

## How It Works

```
User Message → Channel Plugin → Access Control → Session → Queue → Agent Provider → Reply
     ↑                                                                                  |
     └──────────────────────────────────────────────────────────────────────────────────────┘
```

1. A **channel plugin** receives a message (Telegram DM, Slack mention, etc.)
2. **Access control** checks if the sender is allowed (open, allowlist, or pairing flow)
3. The **session resolver** maps the sender to a persistent session (with agent memory)
4. The **message queue** batches or queues messages per session
5. The **agent dispatcher** sends the prompt to the configured provider (Claude, Codex, etc.)
6. The **reply router** sends the response back through the originating channel

## Built-in Channels

| Channel    | Transport          | Peer Dependency              |
| ---------- | ------------------ | ---------------------------- |
| Telegram   | Polling            | `node-telegram-bot-api`      |
| Discord    | Gateway WebSocket  | `discord.js`                 |
| Slack      | Socket Mode        | `@slack/bolt`                |
| WhatsApp   | Baileys            | `@whiskeysockets/baileys`    |
| Email      | IMAP + SMTP        | `imapflow` + `nodemailer`    |
| Webhook    | HTTP (on gateway)  | none                         |
| Cron       | Timer-based        | `cron`                       |

Channels are lazy-loaded — only the ones you configure are imported.

## Configuration

All configuration lives in `agentex.yaml`. Environment variables are substituted using `$VAR` or `${VAR}` syntax.

### Gateway

```yaml
gateway:
  port: 18789          # HTTP + WebSocket port (default: 18789)
  bind: loopback       # loopback | lan | 0.0.0.0 (default: loopback)
  auth:
    mode: token        # token | none (default: token)
    token: $API_TOKEN  # required when mode is "token"
```

### Agent

```yaml
agent:
  provider: claude              # claude | codex | openclaw | process
  cwd: /path/to/project       # working directory for the agent
  model: claude-sonnet-4-5-20250514           # optional model override
  maxTurns: 10                 # max tool-use turns
  timeoutSec: 300              # execution timeout
  skipPermissions: true        # skip interactive permission prompts
  instructionsFile: AGENT.md   # custom instructions file
  systemPromptTemplate: "..." # system prompt override
  mcpServers:                  # MCP servers available to the agent
    - name: fs
      command: mcp-fs
      args: ["--root", "/tmp"]
```

### Sessions

```yaml
sessions:
  dmScope: per-peer           # main | per-peer | per-channel-peer
  resetOnIdle: 24h            # auto-reset after inactivity
  identityLinks:              # link identities across channels
    alice: ["slack:U123", "telegram:456"]
```

### Queue Modes

```yaml
queue:
  mode: queue                 # queue | collect | steer | interrupt
  collectDebounceMs: 500      # collect mode: wait for more messages
  collectMaxMessages: 5       # collect mode: max batch size
  maxQueueDepth: 10           # max queued messages per session
```

### Multi-Agent Routing

```yaml
agents:
  coder:
    provider: claude
    cwd: /code
  reviewer:
    provider: claude
    cwd: /code
    instructionsFile: REVIEW.md

routing:
  rules:
    - match: { channel: slack, chatType: direct }
      agent: coder
    - match: { channel: telegram }
      agent: reviewer
  default: coder
```

### Access Control (per channel)

```yaml
channels:
  telegram:
    token: $TELEGRAM_BOT_TOKEN
    dm:
      policy: open          # open | allowlist | pairing | disabled
    groups:
      policy: mention       # open | allowlist | mention | disabled
      mentionPattern: "@bot"
```

## Control API

The gateway exposes HTTP and WebSocket endpoints on the same port:

| Endpoint                      | Method | Description               |
| ----------------------------- | ------ | ------------------------- |
| `/healthz`                    | GET    | Health check              |
| `/readyz`                     | GET    | Readiness check           |
| `/api/sessions`               | GET    | List active sessions      |
| `/api/sessions/:key`          | DELETE | Reset a session           |
| `/api/channels`               | GET    | Channel status            |
| `/api/pairings`               | GET    | Pending pairing requests  |
| `/api/pairings/:id/approve`   | POST   | Approve a pairing         |
| `/api/pairings/:id/deny`      | POST   | Deny a pairing            |

**WebSocket** at `ws://localhost:18789/ws` streams all gateway events in real time.

## Custom Channels

```typescript
import { createGateway, defineChannel } from "@agentex/gateway";

const myChannel = defineChannel({
  id: "my-channel",
  label: "My Channel",
  capabilities: { chatTypes: ["direct"] },
  async start(ctx) {
    // Set up your message source
    // Call ctx.onMessage(msg) when a message arrives
  },
  async stop() { /* cleanup */ },
  async status() { return { ok: true }; },
  async send(msg) {
    // Send outbound message
    return { ok: true, messageId: "123" };
  },
});

const gw = createGateway({
  configPath: "./agentex.yaml",
  channels: [myChannel],
});

await gw.start();
```

## Events

Subscribe to gateway events programmatically:

```typescript
gw.events.on("message.inbound", (payload) => { /* ... */ });
gw.events.on("agent.complete", (payload) => { /* ... */ });
gw.events.on("*", (payload) => { /* all events */ });
```

Event types: `message.inbound`, `message.outbound`, `agent.start`, `agent.event`, `agent.complete`, `session.created`, `session.reset`, `channel.status`, `pairing.requested`, `pairing.approved`, `pairing.denied`

## Requirements

- Node.js >= 18
- `@agentex/agent` (peer dependency)
- Channel-specific peer dependencies (installed only for channels you use)
- The agent CLI must be installed (e.g., `claude` for the Claude provider)

## License

MIT
