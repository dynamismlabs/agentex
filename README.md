# Agentex

Open-source infrastructure for running AI coding agents. Two packages:

- **[@agentex/agent](./packages/agent)** — Execute Claude Code, Codex, OpenClaw, or any CLI agent programmatically with streaming, sessions, and a unified interface.
- **[@agentex/gateway](./packages/gateway)** — Multi-channel communication gateway that connects agents to Telegram, Discord, Slack, WhatsApp, email, webhooks, and cron with a single YAML config.

## Getting Started

```bash
# Clone and install
git clone https://github.com/your-org/agentex.git
cd agentex
pnpm install

# Build
pnpm -r build

# Run tests (433 total)
pnpm -r test
```

## Packages

### @agentex/agent

Spawn AI agents as child processes with streaming output and session resume.

```typescript
import { getProvider } from "@agentex/agent";

const claude = getProvider("claude");
const result = await claude.execute({
  prompt: "Fix the bug in auth.ts",
  cwd: "/my/project",
  config: { skipPermissions: true, maxTurns: 5 },
  onEvent: (e) => {
    if (e.type === "assistant") process.stdout.write(e.text);
  },
});
```

Built-in providers: `claude`, `codex`, `openclaw`, `process`

### @agentex/gateway

Deploy an agent as a bot across any messaging platform.

```yaml
# agentex.yaml
agent:
  provider: claude
  cwd: .
  skipPermissions: true

channels:
  telegram:
    token: $TELEGRAM_BOT_TOKEN
    dm:
      policy: open
```

```typescript
import { createGateway } from "@agentex/gateway";

const gw = createGateway({ configPath: "./agentex.yaml" });
await gw.start();
// Your agent is now a Telegram bot
```

Features:
- 7 built-in channels (Telegram, Discord, Slack, WhatsApp, Email, Webhook, Cron)
- Session management with agent memory persistence
- Multi-agent routing based on channel, chat type, or target
- Access control (open, allowlist, pairing approval flow)
- Message queuing with collect/batch modes
- HTTP + WebSocket control API
- Custom channel plugins

## Project Structure

```
agentex/
├── packages/
│   ├── agent/             # @agentex/agent
│   │   ├── src/
│   │   │   ├── providers/  # claude, codex, openclaw, process
│   │   │   ├── utils/      # template, env, skills
│   │   │   ├── registry.ts
│   │   │   └── types.ts
│   │   └── tests/
│   └── gateway/           # @agentex/gateway
│       ├── src/
│       │   ├── channels/  # telegram, discord, slack, whatsapp, email, webhook, cron
│       │   ├── config/    # YAML loader + Zod schema
│       │   ├── control/   # HTTP + WebSocket API
│       │   ├── events/    # Event emitter + hooks
│       │   ├── router/    # access control, dispatch, queuing, sessions
│       │   ├── sessions/  # session store, transcript, reaper
│       │   └── gateway.ts # main entry point
│       └── tests/
└── demo/                  # example integrations
```

## Development

```bash
# Typecheck
pnpm -r typecheck

# Run tests with watch
pnpm -r test:watch

# Smoke test (no API keys needed)
cd packages/gateway && pnpm smoke

# Dev mode with real channels (needs .env with tokens)
cd packages/gateway && pnpm dev
```

## Requirements

- Node.js >= 18
- pnpm >= 10
- Agent CLIs on `$PATH` (e.g., `claude` for the Claude provider)

## License

MIT
