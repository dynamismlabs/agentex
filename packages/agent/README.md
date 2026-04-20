# @agentex/agent

Programmatic execution of AI coding agents. Spawn and manage Claude Code, Codex, Gemini, Cursor, OpenCode, Pi, OpenClaw, or any CLI-based agent as a child process with streaming output, multi-turn sessions, auth detection, isolated workspaces, skill installation, and a unified interface.

## Install

```bash
npm install @agentex/agent
```

Node.js >= 18. Each provider requires its CLI to be installed and on `$PATH`.

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

console.log(result.status);     // "completed"
console.log(result.summary);    // "Added try/catch to all route handlers..."
console.log(result.durationMs); // 12340
console.log(result.costUsd);    // 0.0342
console.log(result.usage);      // { "claude-sonnet-4-6": { inputTokens: 1200, outputTokens: 350, ... } }
```

## Built-in Providers

| Provider   | CLI              | Description                                 |
| ---------- | ---------------- | ------------------------------------------- |
| `claude`   | `claude`         | Claude Code (Anthropic)                     |
| `codex`    | `codex`          | Codex CLI (OpenAI)                          |
| `gemini`   | `gemini`         | Gemini CLI (Google)                         |
| `cursor`   | `agent`          | Cursor CLI agent                            |
| `opencode` | `opencode`       | OpenCode                                    |
| `pi`       | `pi`             | Pi CLI                                      |
| `openclaw` | gateway HTTP     | OpenClaw HTTP-gateway agent                 |
| `process`  | any executable   | Generic process executor (arbitrary binary) |

Provider capabilities (sessions, skills, workspaces, MCP, model discovery, quota probing, instructions) are declared on each module's `capabilities` field — check `provider.capabilities` to branch on what's supported.

## Execution Context

Only `prompt` is required. Everything else has sensible defaults.

```typescript
interface ExecutionContext {
  prompt: string;
  model?: string;
  runId?: string;                   // Auto-generated UUIDv7 if omitted
  cwd?: string;                     // Defaults to process.cwd()
  env?: Record<string, string>;
  sessionParams?: Record<string, unknown> | null;
  config?: ProviderConfig;
  signal?: AbortSignal;             // Cancellation — SIGTERM then SIGKILL after graceSec
  onOutput?: (stream: "stdout" | "stderr", chunk: string) => void | Promise<void>;
  onEvent?: (event: StreamEvent) => void | Promise<void>;
  onStart?: (pid: number) => void;
  onLifecycle?: (event: LifecycleEvent) => void;
}
```

`ProviderConfig` covers the knobs most providers accept:

```typescript
interface ProviderConfig {
  command?: string;                 // Override CLI binary path
  model?: string;
  effort?: string;
  maxTurns?: number;
  timeoutSec?: number;
  graceSec?: number;
  skipPermissions?: boolean;
  skillDirs?: string[];
  instructionsFile?: string;
  mcpServers?: McpServerConfig[];
  extraArgs?: string[];
  search?: boolean;
  sandbox?: boolean;
  thinking?: string;
  mode?: string;
  workspace?: { strategy: "worktree"; baseBranch?: string; branchName?: string };
}
```

## Execution Result

```typescript
interface ExecutionResult {
  runId: string;
  exitCode: number | null;
  signal: string | null;
  status: ExecutionStatus;          // "completed" | "failed" | "aborted" | "timeout" | "blocked"
  startedAt: string;                // ISO timestamp
  completedAt: string;
  durationMs: number;
  errorMessage: string | null;
  errorCode: string | null;
  usage?: Record<string, TokenUsage>;  // keyed by model ID
  costUsd: number | null;
  model: string | null;
  summary: string | null;
  sessionParams: Record<string, unknown> | null;
  sessionDisplayId: string | null;
  clearSession: boolean;
  billingType: "api" | "subscription" | "metered_api" | null;
  raw?: Record<string, unknown> | null;
  workspace?: PreparedWorkspace;    // Present if config.workspace was set
}
```

Use `aggregateUsage(result.usage)` to collapse per-model usage into a single total.

## Stream Events

Emitted during execution via `onEvent`. All events include `timestamp`.

- `system` — Session init (`sessionId`, `model`, `subtype`)
- `assistant` — Text output from the agent (`text`)
- `thinking` — Agent's internal reasoning (`text`)
- `tool_call` — Agent invoked a tool (`name`, `input`, `callId?`)
- `tool_result` — Tool returned a result (`toolCallId`, `content`, `isError`)
- `result` — Final result (`text`, `cost`, `isError`)

Lifecycle events (via `onLifecycle`) report phases: `preparing`, `spawning`, `running`, `waiting_for_input`, `completed`, `cancelled`, `error`.

## Sessions (multi-turn)

Providers with `capabilities.sessions = true` (Claude, Codex) can host a persistent session where you send multiple user messages and reuse context across turns.

```typescript
import { getProvider, parseAskUserQuestion } from "@agentex/agent";

const claude = getProvider("claude");
const session = await claude.createSession!({
  cwd: process.cwd(),
  onEvent: (e) => { /* stream events */ },
  onUserInputRequest: async (req) => {
    const q = parseAskUserQuestion(req);
    if (q) return { allow: true, updatedInput: { answers: ["Yes"] } };
    return { allow: true };  // auto-approve other tool calls
  },
});

const first = await session.send("List the API routes in src/");
const followUp = await session.send("Now add rate limiting to each one.");

await session.close();
```

`session.send()` returns a `TurnResult` with `summary`, `usage`, `costUsd`, and a `status` of `completed | failed | max_turns | max_budget | aborted`. Handle elicitations (MCP forms), hook callbacks, and interrupts through the corresponding `SessionContext` callbacks.

## Auth

`@agentex/agent` models three billing modes explicitly — API key, Bedrock, and subscription — and refuses to collapse them into a single "is it ready?" boolean. Callers must name the mode they want so billing choices stay visible at the call site.

```typescript
import { getProvider, hasSubscription, hasApiKey, hasBedrock } from "@agentex/agent";

const codex = getProvider("codex");

await hasSubscription(codex);  // true — Codex authenticated via `codex login`
await hasApiKey(codex);        // true — OPENAI_API_KEY is set (metered billing)
```

### Common cases

```typescript
// 1. Just a Codex subscription (ChatGPT login, no metered billing)
const codex = getProvider("codex");
if (await hasSubscription(codex) && !(await hasApiKey(codex))) {
  /* safe to run — no API charges */
}

// 2. Just a Claude Code subscription
const claude = getProvider("claude");
if (await hasSubscription(claude) && !(await hasApiKey(claude))) {
  /* subscription-only */
}

// 3. API keys across providers
for (const p of [claude, codex, getProvider("gemini")]) {
  if (await hasApiKey(p)) console.log(`${p.type} has API-key auth available`);
}

// 4. Full report when you need conflict detection, bedrock, or source paths
const report = await claude.resolveAuth();
// report.options = [
//   { method: "api_key", source: { kind: "env", var: "ANTHROPIC_API_KEY" }, present: false },
//   { method: "bedrock", source: { kind: "env_combo", vars: ["ANTHROPIC_BEDROCK_BASE_URL", "AWS_ACCESS_KEY_ID", "AWS_REGION"] }, present: false },
//   { method: "subscription", source: { kind: "keychain", service: "Claude Code" }, present: "unknown" },
// ]
```

### What each provider reports

| Provider  | API key source(s)                          | Other                                                                          | Subscription source                                                             |
| --------- | ------------------------------------------ | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------- |
| `codex`   | `OPENAI_API_KEY`                           | —                                                                              | `$CODEX_HOME/auth.json` (default `~/.codex/auth.json`)                          |
| `claude`  | `ANTHROPIC_API_KEY`                        | Bedrock via `ANTHROPIC_BEDROCK_BASE_URL` or `AWS_ACCESS_KEY_ID`+`AWS_REGION`   | macOS: Keychain `Claude Code` · Linux/Win: `$CLAUDE_CONFIG_DIR/.credentials.json` |
| `gemini`  | `GEMINI_API_KEY`, `GOOGLE_API_KEY`         | —                                                                              | `$GEMINI_CONFIG_DIR/oauth_creds.json` (default `~/.gemini/oauth_creds.json`)    |
| `cursor`  | `CURSOR_API_KEY`, `OPENAI_API_KEY`         | —                                                                              | Detected at runtime                                                             |
| `opencode`| `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`      | —                                                                              | —                                                                               |
| `pi`      | `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`      | —                                                                              | —                                                                               |

### Safety notes

- Each sugar helper returns `true` only when a source is **confirmed** present. `"unknown"` presence (macOS Keychain — can't be checked without triggering an OS prompt) is treated as not-present.
- There is deliberately no blanket `canRun()` helper. If you want "any auth works," write it explicitly:
  ```typescript
  const anyReady = (await codex.resolveAuth()).options.some((o) => o.present === true);
  ```
- `provider.testEnvironment()` additionally surfaces conflict checks — e.g., Codex or Claude emit a `warn` when both an API key and subscription credentials are present, since the API key will win and cause metered billing.

### Auth types

```typescript
type AuthMethod = "api_key" | "bedrock" | "subscription";

type AuthSource =
  | { kind: "env"; var: string }
  | { kind: "env_combo"; vars: string[] }
  | { kind: "file"; path: string }
  | { kind: "keychain"; service: string; account?: string };

interface AuthOption {
  method: AuthMethod;
  source: AuthSource;
  present: boolean | "unknown";
}

interface AuthReport {
  providerType: string;
  options: AuthOption[];
}
```

## Environment Testing

`provider.testEnvironment()` is the heavyweight probe — binary resolution, auth presence, optional hello probe. It returns the same `AuthReport` as `resolveAuth()` plus human-readable `checks` for UI.

```typescript
const result = await claude.testEnvironment({ providerType: "claude" });

result.status        // "pass" | "warn" | "fail"
result.auth          // AuthReport (same shape as provider.resolveAuth())
result.checks        // [{ code, level: "info"|"warn"|"error", message, hint? }]
```

Use `resolveAuth()` for cheap yes/no auth checks; use `testEnvironment()` when you need end-to-end confidence (e.g., on a first-run setup screen).

## Workspaces (isolated git worktree)

Providers with `capabilities.workspace = true` can run in an isolated `git worktree`, letting you diff or discard the agent's changes without touching your main checkout.

```typescript
import { prepareWorkspace } from "@agentex/agent";

const ws = await prepareWorkspace({ strategy: "worktree", baseBranch: "main" });
const result = await claude.execute({ prompt: "Refactor utils.ts", cwd: ws.cwd });

const patch = await ws.diff();                        // all changes (default)
const summary = await ws.diff({ stat: true });        // --stat summary
const committed = await ws.diff({ scope: "committed" });

await ws.cleanup({ deleteBranch: true });
```

Or pass `config.workspace` to `execute()` and the provider will prepare and attach it — the result's `workspace` field exposes the same handle.

## Parallel Execution

```typescript
import { executeAll } from "@agentex/agent";

const results = await executeAll(
  [
    { provider: "claude", ctx: { prompt: "Review server.ts" } },
    { provider: "codex",  ctx: { prompt: "Review db.ts" } },
  ],
  { cancelOnFailure: true },
);
```

## Skills

Install and remove reusable agent skills across multiple runtimes at once, into either the user's home or a workspace directory.

```typescript
import { installSkills, listInstalledSkills, removeSkills } from "@agentex/agent";

await installSkills({
  location: "global",                 // or "workspace" with cwd
  includeNativeDirs: false,           // true also installs into ~/.gemini/skills/, etc.
});

const installed = await listInstalledSkills({ location: "global" });
await removeSkills({ location: "global" });
```

Channels and locations follow the emerging `.agents/skills/` + `.claude/skills/` convention — see the `SkillRuntime`, `SkillLocation`, and `SkillChannel` types.

## Temporary Config Override

Run a CLI with a throwaway config directory (useful for injecting system prompts or custom settings without touching the user's real home).

```typescript
import { withTempConfig } from "@agentex/agent";

const cfg = await withTempConfig({
  runtime: "codex",
  seedFromDefault: true,                          // optional: copy ~/.codex into the temp dir
  overrides: { "config.toml": "model = \"o3\"\n" },
});

await codex.execute({ prompt: "...", env: cfg.env });
await cfg.cleanup();
```

## AskUserQuestion / Elicitation / Hooks

Sessions can surface three distinct user-input requests. Handle each via a `SessionContext` callback:

- `onUserInputRequest` — tool permission requests (and interactive tools like Claude's `AskUserQuestion`). Use `parseAskUserQuestion(req)` to detect structured question payloads and return answers via `updatedInput`.
- `onElicitation` — MCP servers asking the host to render a form or open a URL (`form` / `url` modes, with a JSON-Schema `requestedSchema`).
- `onHookCallback` — CLI requesting the host to run a registered hook.

## Custom Providers

```typescript
import { registerProvider } from "@agentex/agent";
import type { ProviderModule } from "@agentex/agent";

const myProvider: ProviderModule = {
  type: "my-agent",
  capabilities: {
    sessions: false,
    modelDiscovery: false,
    quotaProbing: false,
    mcp: false,
    skills: false,
    instructions: false,
    workspace: false,
  },
  async execute(ctx) {
    const startedAt = new Date().toISOString();
    // Spawn your agent, stream events via ctx.onEvent...
    return {
      runId: ctx.runId ?? "generated-id",
      exitCode: 0,
      signal: null,
      status: "completed",
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
    return {
      providerType: ctx.providerType,
      status: "pass",
      auth: { providerType: ctx.providerType, options: [] },
      checks: [],
      testedAt: new Date().toISOString(),
    };
  },
  async resolveAuth() {
    return { providerType: "my-agent", options: [] };
  },
};

registerProvider(myProvider);
```

## API Reference

### Registry
- `getProvider(type)` — look up a registered provider. Throws if unknown.
- `listProviders()` — list all registered provider type names.
- `registerProvider(module)` — register a custom provider.

### Execution
- `provider.execute(ctx)` — run a single turn.
- `provider.createSession?(ctx)` — start a multi-turn session (when `capabilities.sessions`).
- `executeAll(tasks, { cancelOnFailure?, signal? })` — run multiple executions concurrently.

### Auth
- `provider.resolveAuth(ctx?)` — structured report of every auth path.
- `hasSubscription(provider, ctx?)` / `hasApiKey(provider, ctx?)` / `hasBedrock(provider, ctx?)` — presence sugar.
- `detectAuth(providerType, env)` — env-only auth classification used for billing hints.

### Environment
- `provider.testEnvironment(ctx)` — full probe: binary, auth, optional hello-probe.
- `provider.checkQuota?(ctx)` — rate-limit / quota status (when `capabilities.quotaProbing`).
- `provider.listModels?(opts?)` — enumerate models the binary can drive.

### Workspace
- `prepareWorkspace({ strategy, baseBranch?, branchName?, targetDir? })` → `PreparedWorkspace` with `cwd`, `diff()`, `cleanup()`.

### Skills
- `installSkills(opts)` / `removeSkills(opts)` / `listInstalledSkills(opts)`
- `resolveSkillsHome(channel)` / `resolveSkillsWorkspace(channel, cwd)`
- `resolveNativeSkillsHome(runtime)` / `resolveNativeSkillsWorkspace(runtime, cwd)`
- `ensureSkillSymlink(...)`

### Runtime config
- `withTempConfig({ runtime, seedFromDefault?, overrides? })` → env + configDir + cleanup.
- `getRuntimeHomeEnvVar(runtime)` / `getDefaultRuntimeHome(runtime)` — introspect each CLI's home dir override.

### Utilities
- `aggregateUsage(usage)` — collapse `Record<string, TokenUsage>` to a single total.
- `renderTemplate(template, ctx)` — `{{var}}` interpolation.
- `redactEnvForLogs(env)` — redact sensitive values before logging.
- `resolveInstructions(path?)` — read an instructions file, or `null` if no path.
- `parseAskUserQuestion(req)` — extract structured question/option data from a `UserInputRequest`.

## Requirements

- Node.js >= 18
- Each provider's CLI installed and resolvable on `$PATH` (`claude`, `codex`, `gemini`, `agent` for Cursor, `opencode`, `pi`, or a reachable OpenClaw gateway)
- For subscription auth, the relevant CLI must already be logged in (`codex login`, `claude login`, `gemini auth login`, etc.)

## License

MIT
