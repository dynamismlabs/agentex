# @agentex/agent

Programmatic execution of AI coding agents. Spawn and manage Claude Code, Codex, OpenClaw, or any CLI-based agent as a child process with streaming output, session resume, and a unified interface.

## Install

```bash
npm install @agentex/agent
```

## Quick Start

```typescript
import { getProvider } from "@agentex/agent";

const claude = getProvider("claude");

const result = await claude.execute({
  prompt: "Add error handling to server.ts",
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

console.log(result.exitCode);   // 0
console.log(result.summary);    // "Added try/catch to all route handlers..."
console.log(result.durationMs); // 12340
console.log(result.costUsd);    // 0.0342
console.log(result.usage);      // { inputTokens: 1200, outputTokens: 350, cachedInputTokens: 800 }
```

## Built-in Providers

| Provider   | CLI              | Description                         |
| ---------- | ---------------- | ----------------------------------- |
| `claude`   | `claude`         | Claude Code (Anthropic)             |
| `codex`    | `codex`          | Codex CLI (OpenAI)                  |
| `openclaw` | `openclaw`       | OpenClaw agent                      |
| `process`  | any executable   | Generic process executor            |

## Custom Providers

```typescript
import { registerProvider } from "@agentex/agent";
import type { ProviderModule } from "@agentex/agent";

const myProvider: ProviderModule = {
  type: "my-agent",
  async execute(ctx) {
    const startedAt = new Date().toISOString();
    // Spawn your agent, stream events via ctx.onEvent...
    return {
      runId: ctx.runId ?? "generated-id",
      exitCode: 0,
      signal: null,
      timedOut: false,
      startedAt,
      completedAt: new Date().toISOString(),
      durationMs: 0,
      errorMessage: null,
      errorCode: null,
      costUsd: null,
      model: null,
      summary: "Done",
      sessionParams: null,
      sessionDisplayId: null,
      clearSession: false,
      billingType: null,
    };
  },
  async testEnvironment(ctx) {
    return { providerType: ctx.providerType, status: "pass", checks: [], testedAt: new Date().toISOString() };
  },
};

registerProvider(myProvider);
```

## API

### `getProvider(type: string): ProviderModule`

Returns a registered provider by name. Throws if not found.

### `listProviders(): string[]`

Returns all registered provider type names.

### `registerProvider(provider: ProviderModule): void`

Registers a custom provider, making it available via `getProvider()`.

### `renderTemplate(template: string, context: Record<string, string>): string`

Renders a template string with `{{variable}}` interpolation.

### `redactEnvForLogs(env: Record<string, string>): Record<string, string>`

Returns a copy of env vars with sensitive values redacted for safe logging.

## Execution Context

Only `prompt` is required. Everything else has sensible defaults.

```typescript
interface ExecutionContext {
  prompt: string;             // The task to execute
  model?: string;             // Model override (e.g. "claude-sonnet-4-20250514")
  runId?: string;             // Auto-generated UUIDv7 if omitted
  cwd?: string;               // Defaults to process.cwd()
  env?: Record<string, string>;
  sessionParams?: Record<string, unknown> | null;
  config?: ProviderConfig;
  onOutput?: (stream: "stdout" | "stderr", chunk: string) => void;
  onEvent?: (event: StreamEvent) => void;
}
```

## Execution Result

```typescript
interface ExecutionResult {
  runId: string;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  startedAt: string;          // ISO timestamp
  completedAt: string;        // ISO timestamp
  durationMs: number;         // Wall-clock duration
  errorMessage: string | null;
  errorCode: string | null;
  usage?: { inputTokens: number; outputTokens: number; cachedInputTokens?: number };
  costUsd: number | null;
  model: string | null;
  summary: string | null;
  sessionParams: Record<string, unknown> | null;
  sessionDisplayId: string | null;
  clearSession: boolean;
  billingType: "api" | "subscription" | null;
}
```

## Stream Events

Events emitted during execution via `onEvent`. All events include a `timestamp` field.

- `system` — Session init (`event.sessionId`, `event.model`)
- `assistant` — Text output from the agent (`event.text`)
- `thinking` — Agent's internal reasoning (`event.text`)
- `tool_call` — Agent invoked a tool (`event.name`, `event.input`)
- `tool_result` — Tool returned a result (`event.content`, `event.isError`)
- `result` — Final result (`event.text`, `event.cost`)

## Requirements

- Node.js >= 18
- The CLI for each provider must be installed and on `$PATH` (e.g., `claude` for the Claude provider)

## License

MIT
