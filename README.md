# Agentex

Open-source infrastructure for running AI coding agents. Four composable packages:

- **[@agentex/agent](./packages/agent)** — Execute Claude Code, Codex, OpenClaw, or any CLI agent programmatically with streaming, sessions, and a unified interface.
- **[@agentex/gateway](./packages/gateway)** — Multi-channel communication gateway that connects agents to Telegram, Discord, Slack, WhatsApp, email, webhooks, and cron with a single YAML config.
- **[@agentex/workspace](./packages/workspace)** — Isolation and lifecycle primitives: git worktrees, file cloning, port allocation, run-script process-group teardown, structured diff, per-worktree checkpoints, status / commit / push / merge / mergeFrom / pullLatestBase, file tree + watch, plus a `raw` git escape hatch.
- **[@agentex/github](./packages/github)** — Thin typed wrapper over the `gh` CLI for PRs, issues, and status checks. Pairs with `@agentex/workspace` (workspace owns git plumbing; github owns the host API).

The packages compose, but none depends on the others — `agent.execute({ cwd: ws.path })`, `github.repo(ws.path)`. Pick the ones you need.

## Getting Started

```bash
# Clone and install
git clone https://github.com/your-org/agentex.git
cd agentex
pnpm install

# Build
pnpm -r build

# Run tests
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

### @agentex/workspace

Manage isolated workspaces — bare directories or git worktrees — with status/diff/checkpoint/merge primitives, declarative `agentex.workspace.json` config, and process-group-safe `runScript`.

```typescript
import { workspace } from "@agentex/workspace";

const ws = await workspace.create({
  kind: "git",
  source: "/my/repo",
  baseBranch: "main",
  path: "/agentex/workspaces/my-task",
  branch: "agent/task-42",
});

if (ws.kind === "git") {
  // ... agent does work in ws.path ...
  const status = await ws.git.status();
  // → { dirty, untracked, modified, staged, ahead, behind }
  await ws.git.commit("agent: done");
  await ws.git.push();
}

await workspace.archive(ws.path); // status-checked teardown
```

See [`packages/workspace/README.md`](./packages/workspace/README.md) for the full API surface and [`demo/workspace-demo/`](./demo/workspace-demo) for a runnable end-to-end demo.

### @agentex/github

Wrap `gh` so PRs, issues, and status checks have a typed surface. Pairs with `@agentex/workspace`.

```typescript
import { github } from "@agentex/github";

const repo = github.repo(ws.path);
const pr = await repo.createPR({
  base: "main",
  head: ws.git.branch,
  title: "Agent: implement foo",
  body: longMarkdownBody, // piped via stdin — no E2BIG worries
  draft: true,
});

const [openPR] = await repo.listPRs({ head: ws.git.branch });
const checks = await repo.listChecks(pr.number);
```

Typed errors (`NotInstalledError`, `NotAuthenticatedError`, `RepoNotFoundError`, `BranchNotFoundError`, `RateLimitedError`, `GhCommandError`) for branchable error handling.

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
│   ├── gateway/           # @agentex/gateway
│   │   ├── src/
│   │   │   ├── channels/  # telegram, discord, slack, whatsapp, email, webhook, cron
│   │   │   ├── config/    # YAML loader + Zod schema
│   │   │   ├── control/   # HTTP + WebSocket API
│   │   │   ├── events/    # Event emitter + hooks
│   │   │   ├── router/    # access control, dispatch, queuing, sessions
│   │   │   ├── sessions/  # session store, transcript, reaper
│   │   │   └── gateway.ts # main entry point
│   │   └── tests/
│   ├── workspace/         # @agentex/workspace
│   │   ├── src/
│   │   │   ├── git/        # commands, status, diff, checkpoints, pull, remotes, …
│   │   │   ├── internal/   # detect, glob-walk, sparse, common-handle, bare/git handles
│   │   │   ├── util/       # exec, fs, paths, assertions
│   │   │   ├── workspace.ts # top-level: create / open / archive / detectKind / detectDefaultBranch
│   │   │   ├── context.ts   # ContextDir
│   │   │   ├── ports.ts     # PortAllocator
│   │   │   ├── scripts.ts   # runScript
│   │   │   ├── tree.ts      # tree()
│   │   │   ├── watch.ts     # watch()
│   │   │   └── from-source.ts # copyFromSource / linkFromSource
│   │   └── tests/
│   └── github/            # @agentex/github
│       ├── src/
│       │   ├── repo.ts      # repo-scoped ops (PRs, checks, issues)
│       │   ├── preflight.ts # checkInstalled, checkAuthenticated
│       │   └── error-mapping.ts
│       └── tests/
└── demo/
    ├── session-demo/      # @agentex/agent examples
    └── workspace-demo/    # @agentex/workspace + @agentex/github lifecycle (runnable)
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
