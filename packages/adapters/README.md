# @agentex/adapters

Programmatic execution of AI coding agents. Spawn and manage Claude Code, Codex, OpenClaw, or any CLI-based agent as a child process with streaming output, session resume, and a unified interface.

## Install

```bash
npm install @agentex/adapters
```

## Quick Start

```typescript
import { getAdapter } from "@agentex/adapters";

const claude = getAdapter("claude");

const result = await claude.execute({
  runId: "my-task-1",
  prompt: "Add error handling to server.ts",
  cwd: "/path/to/project",
  config: {
    skipPermissions: true,
    maxTurns: 5,
    timeoutSec: 120,
  },
  onEvent: (event) => {
    if (event.type === "assistant") process.stdout.write(event.text);
    if (event.type === "tool_call") console.log(`Tool: ${event.name}`);
  },
});

console.log(result.exitCode); // 0
console.log(result.summary);  // "Added try/catch to all route handlers..."
console.log(result.costUsd);  // 0.0342
```

## Built-in Adapters

| Adapter    | CLI              | Description                         |
| ---------- | ---------------- | ----------------------------------- |
| `claude`   | `claude`         | Claude Code (Anthropic)             |
| `codex`    | `codex`          | Codex CLI (OpenAI)                  |
| `openclaw` | `openclaw`       | OpenClaw agent                      |
| `process`  | any executable   | Generic process executor            |

## Custom Adapters

```typescript
import { registerAdapter } from "@agentex/adapters";
import type { AdapterModule } from "@agentex/adapters";

const myAdapter: AdapterModule = {
  type: "my-agent",
  async execute(ctx) {
    // Spawn your agent, stream events via ctx.onEvent, return result
    return { exitCode: 0, summary: "Done" };
  },
};

registerAdapter(myAdapter);
```

## API

### `getAdapter(type: string): AdapterModule`

Returns a registered adapter by name. Throws if not found.

### `listAdapters(): string[]`

Returns all registered adapter type names.

### `registerAdapter(adapter: AdapterModule): void`

Registers a custom adapter, making it available via `getAdapter()`.

### `renderTemplate(template: string, context: Record<string, string>): string`

Renders a template string with `{{variable}}` interpolation.

### `redactEnvForLogs(env: Record<string, string>): Record<string, string>`

Returns a copy of env vars with sensitive values redacted for safe logging.

## Execution Context

```typescript
interface ExecutionContext {
  runId: string;
  prompt: string;
  cwd: string;
  config?: AdapterConfig;
  onEvent?: (event: StreamEvent) => void;
  sessionCodec?: SessionCodec;
  signal?: AbortSignal;
}
```

## Execution Result

```typescript
interface ExecutionResult {
  exitCode: number | null;
  summary: string | null;
  costUsd: number | null;
  model: string | null;
  errorMessage: string | null;
  durationMs?: number;
  sessionParams?: Record<string, unknown>;
  clearSession?: boolean;
}
```

## Stream Events

Events emitted during execution via `onEvent`:

- `assistant` — Text output from the agent (`event.text`)
- `tool_call` — Agent invoked a tool (`event.name`, `event.input`)
- `tool_result` — Tool returned a result (`event.output`)
- `result` — Final result text (`event.text`)
- `system` — System info like session ID and model (`event.sessionId`, `event.model`)
- `error` — Error during execution (`event.message`)

## Requirements

- Node.js >= 18
- The CLI for each adapter must be installed and on `$PATH` (e.g., `claude` for the Claude adapter)

## License

MIT
