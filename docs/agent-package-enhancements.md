# @agentex/agent Package Enhancements

Spec for feature enhancements to the `@agentex/agent` library. These changes bring the primitives layer to full parity with application-layer agent orchestrators (e.g., Paperclip) while keeping the library composable, unopinionated, and suitable for any app that uses agents.

> **Key principle:** This is a **library of primitives**, not an application. We provide mechanisms and building blocks. The consumer decides policy, lifecycle, and orchestration.

---

## Table of Contents

- [A. Instructions Resolution](#a-instructions-resolution)
- [B. Runtime Home Env Var Lookup](#b-runtime-home-env-var-lookup)
- [C. Billing Type Expansion](#c-billing-type-expansion)
- [D. Auth Detection + Bedrock Support](#d-auth-detection--bedrock-support)
- [E. AbortSignal on Execute](#e-abortsignal-on-execute)
- [F. Lifecycle Events](#f-lifecycle-events)
- [G. Dynamic Model Discovery](#g-dynamic-model-discovery)
- [H. Quota Probing](#h-quota-probing)
- [I. Workspace Preparation (Git Worktrees)](#i-workspace-preparation-git-worktrees)
- [J. Runtime Config Injection](#j-runtime-config-injection)
- [K. Tool Call Event Coverage](#k-tool-call-event-coverage)
- [L. Codex JSON-RPC 2.0 Session Mode](#l-codex-json-rpc-20-session-mode)
- [M. Codex Token Usage from Session Logs](#m-codex-token-usage-from-session-logs)
- [N. Per-Model Usage Tracking](#n-per-model-usage-tracking)
- [O. Execution State Refinement](#o-execution-state-refinement)

---

## Current File Structure

```
packages/agent/src/
├── index.ts              # Public API exports
├── types.ts              # Core interfaces
├── registry.ts           # Provider registry
├── providers/
│   ├── claude/           # codec.ts, execute.ts, index.ts, parse.ts, session.ts, test.ts
│   ├── codex/            # codec.ts, execute.ts, index.ts, parse.ts, test.ts
│   ├── cursor/           # codec.ts, execute.ts, index.ts, parse.ts, test.ts
│   ├── gemini/           # codec.ts, execute.ts, index.ts, parse.ts, test.ts
│   ├── openclaw/         # codec.ts, execute.ts, index.ts, test.ts
│   ├── opencode/         # codec.ts, execute.ts, index.ts, parse.ts, test.ts
│   ├── pi/               # codec.ts, execute.ts, index.ts, parse.ts, test.ts
│   └── process/          # execute.ts, index.ts
└── utils/
    ├── ask-user-question.ts
    ├── binary.ts
    ├── env.ts
    ├── process.ts
    ├── skills.ts
    ├── template.ts
    └── uuid.ts
```

---

## A. Instructions Resolution

**Problem:** `config.instructionsFile` exists on `ProviderConfig` but only the Claude provider uses it (via `--append-system-prompt-file`). All other providers silently ignore it.

**Solution:** Create a shared utility that reads the instructions file. Providers without a native flag prepend the content to the prompt.

### New File

**`src/utils/instructions.ts`**

```typescript
/**
 * Read an instructions file and return its content.
 * Returns null if no path is provided.
 */
export async function resolveInstructions(filePath?: string): Promise<string | null>;
```

- Read the file at `filePath`, return content as string
- Return `null` if `filePath` is undefined/empty
- Throw a clear error if the file doesn't exist (don't silently fail)

### Provider Changes

For each non-Claude provider's `execute.ts`:

1. Import `resolveInstructions`
2. At the start of `execute()`, resolve the instructions:
   ```typescript
   const instructions = await resolveInstructions(config.instructionsFile);
   const fullPrompt = instructions ? `${instructions}\n\n${prompt}` : prompt;
   ```
3. Use `fullPrompt` instead of `prompt` when passing to the CLI

**Providers to update:**
- `providers/codex/execute.ts` — prepend to stdin prompt
- `providers/gemini/execute.ts` — prepend to positional arg prompt
- `providers/cursor/execute.ts` — prepend to stdin prompt
- `providers/opencode/execute.ts` — prepend to stdin prompt
- `providers/pi/execute.ts` — Pi has `--append-system-prompt`, so use native flag (like Claude)
- `providers/process/execute.ts` — prepend to stdin if applicable

**Claude provider:** No change needed — already uses `--append-system-prompt-file` natively.

### Export

Add to `src/index.ts`:
```typescript
export { resolveInstructions } from "./utils/instructions.js";
```

---

## B. Runtime Home Env Var Lookup

**Problem:** Each CLI tool has a global home directory (`~/.claude/`, `~/.codex/`, etc.) that stores auth, config, sessions, and skills. When running multiple agents concurrently, they can collide on this shared state. The library should tell consumers which env var to override for isolation, without managing the directories itself.

**Context:**
- `config.skillDirs` already handles injecting skills without touching the home directory (ephemeral symlinks via `--add-dir` or workspace injection)
- Home directory override is the sledgehammer for **full isolation** (auth, config, sessions, AND skills) — only needed for multi-tenant orchestration
- Most users will only ever need `skillDirs`

### New File

**`src/utils/runtime-homes.ts`**

```typescript
import type { SkillRuntime } from "./skills.js";

/**
 * Returns the environment variable name that overrides the global home
 * directory for the given runtime CLI tool.
 *
 * Returns null for runtimes that don't support home directory override.
 */
export function getRuntimeHomeEnvVar(runtime: SkillRuntime): string | null;

/**
 * Returns the default global home directory path for the given runtime.
 */
export function getDefaultRuntimeHome(runtime: SkillRuntime): string;
```

**Mapping:**

| Runtime | Env Var | Default Home |
|---------|---------|--------------|
| `claude` | `CLAUDE_CONFIG_DIR` | `~/.claude` |
| `codex` | `CODEX_HOME` | `~/.codex` |
| `gemini` | `GEMINI_CONFIG_DIR` | `~/.gemini` |
| `cursor` | `CURSOR_CONFIG_DIR` | `~/.cursor` |
| `opencode` | `XDG_CONFIG_HOME` (affects `~/.config/opencode/`) | `~/.config/opencode` |
| `pi` | `PI_HOME` | `~/.pi` |

> **Note:** Verify exact env var names against each CLI tool's documentation before implementing. The names above are based on observed behavior in Paperclip and may need adjustment.

### Export

Add to `src/index.ts`:
```typescript
export { getRuntimeHomeEnvVar, getDefaultRuntimeHome } from "./utils/runtime-homes.js";
```

---

## C. Billing Type Expansion

**Problem:** `ExecutionResult.billingType` is currently `"api" | "subscription" | null`. Bedrock uses metered API billing which doesn't fit either category.

### Type Change

**`src/types.ts`** — Update `ExecutionResult`:

```typescript
// Before
billingType: "api" | "subscription" | null;

// After
billingType: "api" | "subscription" | "metered_api" | null;
```

No other changes needed — this just widens the type for the auth detection work in section D.

---

## D. Auth Detection + Bedrock Support

**Problem:** Auth detection is currently a single line in the Claude provider checking `ANTHROPIC_API_KEY`. Bedrock requires detecting different env vars and rewriting model IDs. Other providers need similar per-provider auth detection.

### New File

**`src/utils/auth.ts`**

```typescript
export interface ResolvedAuth {
  /** How the user is authenticated */
  method: "api_key" | "bedrock" | "oauth" | "subscription";
  /** How usage is billed */
  billingType: "api" | "metered_api" | "subscription";
  /** If the auth method requires model ID transformation (e.g., Bedrock), this resolves it */
  resolveModelId?(requestedModel: string): string;
  /** Cloud region, if applicable (Bedrock) */
  region?: string;
}

/**
 * Detect authentication method for a given provider based on environment variables.
 */
export function detectAuth(providerType: string, env: Record<string, string>): ResolvedAuth;
```

**Detection logic per provider:**

| Provider | API Key Env Var | Bedrock Detection | Subscription Fallback |
|----------|----------------|-------------------|----------------------|
| `claude` | `ANTHROPIC_API_KEY` | `ANTHROPIC_BEDROCK_BASE_URL` or `AWS_ACCESS_KEY_ID` + `AWS_REGION` | Yes |
| `codex` | `OPENAI_API_KEY` | N/A | Yes |
| `gemini` | `GEMINI_API_KEY` or `GOOGLE_API_KEY` | N/A | Yes |
| `cursor` | N/A (subscription-based) | N/A | Yes |
| `opencode` | Provider-dependent | N/A | Yes |
| `pi` | Provider-dependent | N/A | Yes |

**Bedrock model ID mapping** (internal helper):

```typescript
function bedrockModelId(model: string, region?: string): string;
```

Maps standard model names to Bedrock-qualified IDs:
- `"claude-sonnet-4-6"` → `"us.anthropic.claude-sonnet-4-6-v1"` (region-prefixed)
- `"claude-opus-4-6"` → `"us.anthropic.claude-opus-4-6-v1"`
- Unknown models pass through unchanged

### Provider Changes

**`providers/claude/execute.ts`:**

Replace the current inline billing detection:
```typescript
// Before
const billingType = hasNonEmptyEnvValue(env, "ANTHROPIC_API_KEY") ? "api" : "subscription";

// After
import { detectAuth } from "../../utils/auth.js";
const auth = detectAuth("claude", env);
const model = auth.resolveModelId?.(config.model ?? ctx.model ?? "") ?? config.model ?? ctx.model;
// Use auth.billingType in the result
```

**Other providers:** Update billing detection in each provider's execute.ts to use `detectAuth()` instead of inline checks.

### Export

Add to `src/index.ts`:
```typescript
export { detectAuth } from "./utils/auth.js";
export type { ResolvedAuth } from "./utils/auth.js";
```

---

## E. AbortSignal on Execute

**Problem:** `execute()` returns a `Promise<ExecutionResult>` with no way to cancel a running agent. Sessions have `interrupt()` but single-turn execution does not.

### Type Changes

**`src/types.ts`** — Add to `ExecutionContext`:

```typescript
export interface ExecutionContext {
  // ... existing fields ...

  /** AbortSignal to cancel execution. When aborted, the process receives SIGTERM
   *  followed by SIGKILL after the grace period. */
  signal?: AbortSignal;
}
```

**Note:** The `ExecutionResult` does NOT get a separate `aborted: boolean` field. Instead, section O introduces `status: ExecutionStatus` where `"aborted"` is one of the status values. When the signal fires, the result has `status: "aborted"`.

**`src/types.ts`** — Also add to `SessionContext`:

```typescript
export interface SessionContext {
  // ... existing fields ...

  /** AbortSignal to cancel the session. When aborted, the session is closed
   *  and the underlying process is terminated. Composable with
   *  AbortSignal.timeout() for session-level timeouts. */
  signal?: AbortSignal;
}
```

When the signal fires on a session, it should call `close()` internally — terminating the process and resolving any pending `send()` with `status: "aborted"`.

### Implementation

**`src/utils/process.ts`** — Update `runChildProcess()`:

1. Accept `signal?: AbortSignal` in options
2. If `signal` is already aborted when called, skip spawn and return immediately
3. Add abort listener that calls `killProcessTree(pid, "SIGTERM")`, then SIGKILL after `graceSec`
4. Clean up listener on process exit
5. Set `aborted: true` on result if signal triggered the kill

### Provider Changes

All providers pass `ctx.signal` through to `runChildProcess()`. In the result, set `aborted: true` if the signal was triggered. This is mechanical — same pattern in every provider's execute.ts.

---

## F. Lifecycle Events

**Problem:** `StreamEvent` covers what the agent says and does, but callers (especially UIs) need to know about execution lifecycle phases — when skills are being prepared, when the process is spawning, when it's waiting for user input, etc.

### Type Changes

**`src/types.ts`** — New types:

```typescript
export type LifecycleEvent =
  | { phase: "preparing"; step: "workspace" | "skills" | "auth" | "instructions" | "binary" }
  | { phase: "spawning" }
  | { phase: "running"; pid: number }
  | { phase: "waiting_for_input"; request: UserInputRequest }
  | { phase: "completed" }
  | { phase: "cancelled" }
  | { phase: "error"; message: string };
```

**`src/types.ts`** — Add callback to `ExecutionContext`:

```typescript
export interface ExecutionContext {
  // ... existing fields ...
  onLifecycle?: (event: LifecycleEvent) => void;
}
```

**`src/types.ts`** — Add callback to `SessionContext`:

```typescript
export interface SessionContext {
  // ... existing fields ...
  onLifecycle?: (event: LifecycleEvent) => void;
}
```

### Provider Changes

Add `ctx.onLifecycle?.()` calls at key points in each provider's `execute()`:

```typescript
async function execute(ctx: ExecutionContext): Promise<ExecutionResult> {
  ctx.onLifecycle?.({ phase: "preparing", step: "binary" });
  const binary = await findBinary(...);

  ctx.onLifecycle?.({ phase: "preparing", step: "instructions" });
  const instructions = await resolveInstructions(...);

  ctx.onLifecycle?.({ phase: "preparing", step: "skills" });
  const skillsDir = await buildSkillsDir(...);

  ctx.onLifecycle?.({ phase: "preparing", step: "auth" });
  const auth = detectAuth(...);

  ctx.onLifecycle?.({ phase: "spawning" });
  const proc = await runChildProcess(...);

  ctx.onLifecycle?.({ phase: "running", pid: proc.pid });
  // ... streaming ...

  ctx.onLifecycle?.({ phase: "completed" });
  return result;
}
```

Not every provider will have every step (e.g., `process` provider may skip skills). Only emit events for steps that actually occur.

### Export

Add to type exports in `src/index.ts`:
```typescript
export type { LifecycleEvent } from "./types.js";
```

---

## G. Dynamic Model Discovery

**Problem:** `listModels()` returns static arrays. Models change frequently and static lists go stale. Paperclip shells out to `pi --list-models` and `opencode models` for dynamic discovery.

### Interface Change

**`src/types.ts`** — Update `ProviderModule`:

```typescript
export interface ProviderModule {
  // ... existing fields ...

  /** List available models. Pass cacheTtlMs to cache results (0 = no cache, default). */
  listModels?(options?: { cacheTtlMs?: number }): Promise<ProviderModel[]>;
}
```

### Implementation Per Provider

Each provider implements model discovery differently:

| Provider | Discovery Method | Fallback |
|----------|-----------------|----------|
| `claude` | Static list (Claude Code doesn't have a model list command) | N/A |
| `codex` | `codex models` or similar CLI command | Static list |
| `gemini` | `gemini models` or similar CLI command | Static list |
| `opencode` | `opencode models` (parse provider/model output) | Static list |
| `pi` | `pi --list-models` (parse columnar output) | Static list |
| `cursor` | Static list (Cursor uses many provider models) | N/A |

**Cache implementation** (shared utility):

```typescript
// src/utils/model-cache.ts

export class ModelCache {
  private cache: ProviderModel[] | null = null;
  private cachedAt: number = 0;

  async get(ttlMs: number, fetcher: () => Promise<ProviderModel[]>): Promise<ProviderModel[]> {
    if (ttlMs > 0 && this.cache && Date.now() - this.cachedAt < ttlMs) {
      return this.cache;
    }
    this.cache = await fetcher();
    this.cachedAt = Date.now();
    return this.cache;
  }
}
```

Each provider creates its own `ModelCache` instance. If `cacheTtlMs` is 0 or omitted, always calls the fetcher. Otherwise returns cached result if within TTL.

### Export

Add to `src/index.ts`:
```typescript
// ModelCache is internal — not exported. Only the interface change matters.
```

---

## H. Quota Probing

**Problem:** No way to check if a provider has available quota before spawning a run. Important for orchestration layers that need to decide which agent to dispatch work to.

### Interface Change

**`src/types.ts`** — New types:

```typescript
export interface QuotaStatus {
  /** Whether the provider currently has available capacity */
  available: boolean;
  /** Remaining tokens in current window, if known */
  remainingTokens?: number;
  /** When the current rate limit window resets, if known */
  resetAt?: string;
  /** Billing type detected */
  billingType: "api" | "subscription" | "metered_api";
  /** Additional provider-specific info */
  detail?: Record<string, unknown>;
}

export interface QuotaContext {
  config?: ProviderConfig;
  env?: Record<string, string>;
}
```

**`src/types.ts`** — Add to `ProviderModule`:

```typescript
export interface ProviderModule {
  // ... existing fields ...

  /** Check current quota/rate limit status. Not all providers support this. */
  checkQuota?(ctx: QuotaContext): Promise<QuotaStatus>;
}
```

### Implementation

Start with Claude only (it exposes quota info). Other providers can be added as their CLIs support quota queries.

**`providers/claude/index.ts`:** Implement `checkQuota` that probes Claude CLI for quota status.

### Export

Add to type exports in `src/index.ts`:
```typescript
export type { QuotaStatus, QuotaContext } from "./types.js";
```

---

## I. Workspace Preparation (Git Worktrees)

**Problem:** Running multiple agents on the same repo causes file conflicts. Git worktrees provide lightweight, isolated working directories that share the same git history.

**Context — What is a git worktree?**

A worktree creates a second checkout of a repo in a separate directory, on its own branch, sharing the same `.git` database. Files are independent (agents can edit without conflicts), but git history is shared (you can diff, merge, create PRs).

```
/Users/trey/myrepo/              ← main worktree (branch: main)
  .git/                           ← THE git database
  src/

/tmp/agentex-ws-abc123/          ← secondary worktree (branch: agent-fix-auth)
  .git                            ← a FILE pointing to main .git
  src/                            ← independent file state
```

### New File

**`src/utils/workspace.ts`**

```typescript
export interface WorkspaceOptions {
  /** Isolation strategy */
  strategy: "worktree";
  /** Base branch to create worktree from (default: current HEAD) */
  baseBranch?: string;
  /** Custom branch name (default: auto-generated) */
  branchName?: string;
  /** Custom directory for the worktree (default: os.tmpdir()) */
  targetDir?: string;
}

export interface PreparedWorkspace {
  /** Path to the worktree directory — use as `cwd` for execute() */
  cwd: string;
  /** Branch name created for this worktree */
  branch: string;
  /** The strategy that was used */
  strategy: "worktree";
  /** The original repo path */
  originalCwd: string;
  /** Get a unified diff of changes against a base branch */
  diff(base?: string): Promise<string>;
  /** Remove the worktree and optionally delete the branch */
  cleanup(options?: { deleteBranch?: boolean }): Promise<void>;
}

/**
 * Create an isolated workspace for agent execution.
 *
 * Uses `git worktree add` to create a lightweight checkout on a new branch.
 * The worktree shares git history with the original repo, so diffs, merges,
 * and PRs all work normally.
 */
export async function prepareWorkspace(
  cwd: string,
  options: WorkspaceOptions,
): Promise<PreparedWorkspace>;
```

### Implementation Details

**`prepareWorkspace()`:**

1. Validate that `cwd` is a git repository (`git rev-parse --git-dir`)
2. Generate branch name if not provided: `agentex/<timestamp>-<short-uuid>`
3. Generate target directory: `os.tmpdir()/agentex-ws-<short-uuid>`
4. Run: `git worktree add <targetDir> -b <branchName> [baseBranch]`
5. Return `PreparedWorkspace` object

**`PreparedWorkspace.diff(base?)`:**
- Default base: the `baseBranch` option or `"main"`
- Run: `git diff <base>...<branch>` from the original repo
- Return the unified diff string

**`PreparedWorkspace.cleanup({ deleteBranch? })`:**
- Run: `git worktree remove <cwd>`
- If `deleteBranch: true`, also run: `git branch -D <branch>`

### Convenience on ProviderConfig (Option A)

**`src/types.ts`** — Add to `ProviderConfig`:

```typescript
export interface ProviderConfig {
  // ... existing fields ...

  /** Run the agent in an isolated workspace. The library creates a worktree
   *  before execution and uses it as the working directory. The worktree
   *  persists after the run for inspection; call cleanup() to remove. */
  workspace?: {
    strategy: "worktree";
    baseBranch?: string;
    branchName?: string;
  };
}
```

When `config.workspace` is set, the provider's `execute()` internally calls `prepareWorkspace()`, runs the agent in the worktree cwd, and attaches the `PreparedWorkspace` to the result.

**`src/types.ts`** — Add to `ExecutionResult`:

```typescript
export interface ExecutionResult {
  // ... existing fields ...

  /** If the run used a workspace, this contains the workspace handle for diffing/cleanup */
  workspace?: PreparedWorkspace;
}
```

### Export

Add to `src/index.ts`:
```typescript
export { prepareWorkspace } from "./utils/workspace.js";
export type { WorkspaceOptions, PreparedWorkspace } from "./utils/workspace.js";
```

---

## J. Runtime Config Injection

**Problem:** Some providers need temporary config overrides that shouldn't mutate the user's global settings. Paperclip's OpenCode adapter creates a temp `XDG_CONFIG_HOME` with permission overrides.

### New File

**`src/utils/runtime-config.ts`**

```typescript
export interface TempConfigResult {
  /** Modified env vars to pass to the spawned process */
  env: Record<string, string>;
  /** Notes about what was overridden (for logging) */
  notes: string[];
  /** Clean up the temporary config directory */
  cleanup(): Promise<void>;
}

/**
 * Create a temporary config directory for a runtime with overrides applied.
 * The original config is seeded from the runtime's default home, then overrides
 * are merged on top.
 *
 * Returns modified env vars that redirect the runtime to the temp config,
 * and a cleanup function.
 */
export async function withTempConfig(
  runtime: SkillRuntime,
  overrides: Record<string, unknown>,
  baseEnv?: Record<string, string>,
): Promise<TempConfigResult>;
```

### Implementation

1. Read the runtime's home env var (from `getRuntimeHomeEnvVar()`)
2. Create a temp directory
3. Copy/seed config files from the default home directory
4. Apply overrides (merge into config JSON/TOML as appropriate)
5. Return env with the home env var pointing to the temp dir
6. Cleanup removes the temp dir

### Provider Changes

**`providers/opencode/execute.ts`:** Refactor to use `withTempConfig()` instead of inline temp config logic.

### Export

Add to `src/index.ts`:
```typescript
export { withTempConfig } from "./utils/runtime-config.js";
export type { TempConfigResult } from "./utils/runtime-config.js";
```

---

## K. Tool Call Event Coverage

**Problem:** `StreamEvent` defines `tool_call` and `tool_result` event types, but not all providers parse and emit them. The type system promises events that the implementations don't deliver.

### Current State

| Provider | `assistant` | `thinking` | `tool_call` | `tool_result` | `system` | `result` |
|----------|:-----------:|:----------:|:-----------:|:-------------:|:--------:|:--------:|
| Claude   | Yes | Yes | Yes | Yes | Yes | Yes |
| Codex    | Yes | ? | No | No | Yes | Yes |
| Gemini   | Yes | ? | No | No | Yes | Yes |
| Cursor   | Yes | ? | No | No | Yes | Yes |
| OpenCode | Yes | ? | No | No | Yes | Yes |
| Pi       | Yes | ? | No | No | Yes | Yes |

### Changes Per Provider

Audit each provider's `parse.ts` and update to emit `tool_call` and `tool_result` events where the CLI output contains tool usage information:

- **Codex:** JSONL events include `item.completed` with function call details — parse and emit
- **Gemini:** JSONL may include tool use — parse and emit if present
- **Pi:** Already has `tool_call_start`, `tool_call_end`, `tool_call_error` events — map to `StreamEvent` tool types
- **Cursor:** Check if stream-json output includes tool use details
- **OpenCode:** Check JSONL format for tool call information

For providers whose CLI doesn't expose tool call details in output, document the gap — don't fabricate events.

### StreamEvent Type Fix

Also fix the `tool_call` variant in `StreamEvent` — it's missing a `callId` to correlate with `tool_result.toolCallId`:

```typescript
// Before
| { type: "tool_call"; name: string; input: unknown; timestamp: string }

// After
| { type: "tool_call"; callId: string; name: string; input: unknown; timestamp: string }
```

This is needed for SessionState tracking (section O) — correlating results to calls to drive state transitions.

---

## L. Codex JSON-RPC 2.0 Session Mode

**Problem:** The Codex provider only supports `codex exec --json` (fire-and-forget JSONL). Multica uses `codex app-server --listen stdio://` which gives a persistent JSON-RPC 2.0 server over stdin/stdout — enabling bidirectional communication, granular tool approvals, and proper thread/turn lifecycle. This is the Codex equivalent of what we already have for Claude's session protocol.

**Context — How Multica does it:**

```
# Current agex approach (limited)
codex exec --json --dangerously-bypass-approvals-and-sandbox <prompt>

# Multica approach (full bidirectional)
codex app-server --listen stdio://
  → JSON-RPC: initialize { clientInfo, capabilities }
  → JSON-RPC: thread/start { model, cwd, sandbox, developerInstructions }
  → JSON-RPC: turn/start { threadId, input: [{ type: "text", text: prompt }] }
  ← Notifications: item/started, item/completed, turn/completed
  ← Server requests: item/commandExecution/requestApproval
  → Response: { decision: "accept" }
```

### New File

**`src/providers/codex/session.ts`**

Implement `createSession()` for Codex using JSON-RPC 2.0 over stdio:

```typescript
// JSON-RPC 2.0 message types
interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}
```

### Handshake Protocol

The session must perform a three-step handshake:

1. **`initialize`** — Announce client capabilities:
   ```typescript
   await rpc.request("initialize", {
     clientInfo: { name: "agentex-sdk", title: "Agentex Agent SDK", version: "0.1.0" },
     capabilities: { experimentalApi: true },
   });
   ```

2. **`thread/start`** — Create a conversation thread:
   ```typescript
   const { threadId } = await rpc.request("thread/start", {
     model: config.model,
     cwd: ctx.cwd,
     approvalPolicy: null,            // we handle approvals ourselves
     sandbox: "workspace-write",
     developerInstructions: systemPrompt,
     persistExtendedHistory: true,
   });
   ```

3. **`turn/start`** — Send a user message (called on each `session.send()`):
   ```typescript
   await rpc.request("turn/start", {
     threadId,
     input: [{ type: "text", text: message }],
   });
   ```

### Tool Approval Protocol

The Codex server sends JSON-RPC **requests** (not notifications) for tool approvals. The session must respond:

```typescript
// Server → Client (request)
{ "jsonrpc": "2.0", "id": 42, "method": "item/commandExecution/requestApproval", "params": { ... } }
{ "jsonrpc": "2.0", "id": 43, "method": "item/fileChange/requestApproval", "params": { ... } }

// Client → Server (response)
{ "jsonrpc": "2.0", "id": 42, "result": { "decision": "accept" } }
{ "jsonrpc": "2.0", "id": 43, "result": { "decision": "accept" } }
```

The approval handling should integrate with the existing `onUserInputRequest` callback from `SessionContext`. If the callback is not provided or `config.skipPermissions` is true, auto-approve all requests (like Multica does). If the callback IS provided, forward the approval request so the consumer can approve/deny granularly.

### Notification Handling

Two protocol variants exist (detect at runtime):

**Legacy (older Codex versions):**
- `codex/event` notifications with `msg` field: `task_started`, `agent_message`, `exec_command_begin/end`, `patch_apply_begin/end`, `task_complete`, `turn_aborted`

**v2 (newer Codex versions):**
- `turn/started`, `turn/completed`, `thread/status/changed`
- `item/started`, `item/completed` for: `commandExecution`, `fileChange`, `agentMessage`

Both should be parsed and mapped to `StreamEvent` types.

### Session Interface

Matches the existing `AgentSession` interface:

```typescript
const session = await getProvider("codex").createSession({
  cwd: "/my/repo",
  config: { model: "gpt-5.3-codex", skipPermissions: true },
  onEvent: (event) => console.log(event),
});

const turn1 = await session.send("Create the API endpoint");
const turn2 = await session.send("Now add tests");
await session.close();
```

### Provider Changes

**`providers/codex/index.ts`:** Add `createSession` to the provider module export.

**`providers/codex/execute.ts`:** Optionally refactor single-turn `execute()` to use the JSON-RPC session internally (spawn → handshake → one turn → close). This would give single-turn execution the same tool approval capabilities. Alternatively, keep both paths: `exec --json` for simple fire-and-forget, `app-server` for sessions.

**Decision: Keep both paths.** `execute()` stays as `codex exec --json` for simplicity and backward compatibility. `createSession()` uses `codex app-server --listen stdio://` for full bidirectional support. Consumers choose which they need.

---

## M. Codex Token Usage from Session Logs

**Problem:** Codex execution frequently returns no token usage data through its primary protocol. Multica falls back to scanning Codex session log files on disk. Agex always returns `costUsd: null` for Codex.

### New File

**`src/providers/codex/usage-scanner.ts`**

```typescript
export interface CodexSessionUsage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  cacheCreationInputTokens: number;
}

/**
 * Scan Codex session log files for token usage.
 *
 * Codex writes JSONL session logs to:
 *   ~/.codex/sessions/YYYY/MM/DD/*.jsonl
 *   (or {CODEX_HOME}/sessions/YYYY/MM/DD/*.jsonl)
 *
 * Scans for "token_count" events written after `startedAfter` timestamp.
 * Returns aggregated usage, or null if no matching logs found.
 */
export async function scanCodexSessionUsage(options: {
  startedAfter: Date;
  codexHome?: string;      // defaults to ~/.codex
  threadId?: string;       // filter to specific thread if known
}): Promise<CodexSessionUsage | null>;
```

### Implementation

1. Resolve Codex home directory (env `CODEX_HOME` or `~/.codex`)
2. Calculate date-based path: `sessions/YYYY/MM/DD/`
3. List all `.jsonl` files in that directory
4. For each file, read line-by-line looking for `token_count` events
5. Filter to events with timestamps after `startedAfter`
6. If `threadId` provided, filter to matching thread
7. Aggregate `TotalTokenUsage` fields: `InputTokens`, `OutputTokens`, `CachedInputTokens`, `CacheReadInputTokens`
8. Return aggregated result or null

### Provider Changes

**`providers/codex/execute.ts`:**

After execution, if usage is empty/null in the parsed result:
```typescript
if (!usage) {
  usage = await scanCodexSessionUsage({
    startedAfter: new Date(startedAt),
    codexHome: env.CODEX_HOME,
    threadId: parsedResult.threadId,
  });
}
```

**`providers/codex/session.ts`:**

Same fallback after a turn completes with no usage in the JSON-RPC response.

### Export

Not exported publicly — this is internal to the Codex provider. The consumer sees usage in `ExecutionResult.usage` or `TurnResult.usage` like any other provider.

---

## N. Per-Model Usage Tracking

**Problem:** Usage is currently flat `{ inputTokens, outputTokens, cachedInputTokens }`. If an agent uses multiple models in a single run (Claude does this, and multi-model routing is becoming common), the flat structure loses granularity. Multica tracks usage keyed by model name.

### Type Changes

**`src/types.ts`** — New type:

```typescript
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
  cacheCreationInputTokens?: number;
}
```

**`src/types.ts`** — Update `ExecutionResult`:

```typescript
// Before
usage?: { inputTokens: number; outputTokens: number; cachedInputTokens?: number };

// After
usage?: Record<string, TokenUsage>;
```

The key is the model name (e.g., `"claude-opus-4-6"`, `"gpt-5.3-codex"`). For runs that only use one model, there's one key. For multi-model runs, each model gets its own entry.

**`src/types.ts`** — Update `TurnResult`:

```typescript
// Before
usage?: { inputTokens: number; outputTokens: number; cachedInputTokens?: number };

// After
usage?: Record<string, TokenUsage>;
```

### Helper

Add a convenience function for the common single-model case:

```typescript
/**
 * Get aggregate usage across all models. Convenience for when you don't
 * care about per-model breakdown.
 */
export function aggregateUsage(usage: Record<string, TokenUsage> | undefined): TokenUsage | null;
```

### Provider Changes

All providers update their result construction to return `Record<string, TokenUsage>` instead of the flat object. For providers that only report one model, the key is the model name from the session:

```typescript
// Before
usage: { inputTokens: 1000, outputTokens: 500 }

// After
usage: { "claude-opus-4-6": { inputTokens: 1000, outputTokens: 500 } }
```

Claude's parser already tracks model name from `system` init events — use it as the key. Codex gets model from `thread/start` response or config. Other providers use `config.model` or `ctx.model`.

### Export

Add to `src/index.ts`:
```typescript
export { aggregateUsage } from "./types.js";  // or utils
export type { TokenUsage } from "./types.js";
```

---

## O. Execution State Refinement

**Problem:** Execution state tracking is too coarse. `AgentSession.state` is `"idle" | "running" | "closed"` — but "running" could mean thinking, executing a tool, or waiting for approval. `ExecutionResult` uses scattered booleans (`timedOut`, `aborted`) plus `errorCode` strings to express what should be a single discriminant.

### Session State (live, during execution)

**`src/types.ts`** — Replace session state:

```typescript
// Before
readonly state: "idle" | "running" | "closed";

// After
readonly state: SessionState;

export type SessionState =
  | "idle"                  // session created, no turn in progress
  | "thinking"              // agent is generating/reasoning
  | "tool_executing"        // agent is running a tool
  | "waiting_for_approval"  // blocked on tool permission request
  | "waiting_for_input"     // blocked on user input (AskUserQuestion, elicitation)
  | "closed";               // session ended
```

State transitions are derived from stream events already being parsed:
- `thinking` event → state = `"thinking"`
- `tool_call` event → state = `"tool_executing"`
- `tool_result` event → state = `"thinking"` (agent processes result)
- Control request (permission) → state = `"waiting_for_approval"`
- AskUserQuestion / elicitation → state = `"waiting_for_input"`
- Turn completes → state = `"idle"`
- Session closes → state = `"closed"`

### Execution Outcome (final, single-turn and multi-turn)

**`src/types.ts`** — New type:

```typescript
export type ExecutionStatus =
  | "completed"    // success
  | "failed"       // agent or execution error
  | "aborted"      // cancelled via AbortSignal
  | "timeout"      // exceeded time limit
  | "blocked";     // agent reported a blocker it can't resolve
```

**`src/types.ts`** — Update `ExecutionResult`:

```typescript
// REMOVE these fields:
timedOut: boolean;
aborted: boolean;   // (from section E — don't add, use status instead)

// ADD this field:
status: ExecutionStatus;

// KEEP these fields (detail within status):
errorCode: string | null;
errorMessage: string | null;
```

Consumer code becomes:
```typescript
// Before
if (result.timedOut) { ... }
else if (result.aborted) { ... }
else if (result.errorCode) { ... }

// After
switch (result.status) {
  case "completed": ...
  case "failed": ...     // check errorCode/errorMessage for detail
  case "aborted": ...
  case "timeout": ...
  case "blocked": ...
}
```

**`src/types.ts`** — Update `TurnResult`:

```typescript
// REMOVE these fields:
isError: boolean;
stopReason: string | null;

// ADD this field:
status: "completed" | "failed" | "max_turns" | "max_budget" | "aborted";

// KEEP these fields:
errorCode: string | null;
errorMessage: string | null;
```

### Section E Revision (AbortSignal)

Since `ExecutionResult` now has `status: ExecutionStatus`, we do NOT add a separate `aborted: boolean` field. When the AbortSignal fires, the result is:

```typescript
{
  status: "aborted",
  errorCode: null,
  errorMessage: "Execution cancelled via AbortSignal",
}
```

The `signal?: AbortSignal` on `ExecutionContext` still applies — this just changes how the outcome is reported.

### Provider Changes

All providers update their result construction:

```typescript
// Map exit conditions to status
if (signal?.aborted) status = "aborted";
else if (proc.timedOut) status = "timeout";
else if (isAuthRequired(...)) { status = "failed"; errorCode = "auth_required"; }
else if (isMaxTurns(...)) { status = "failed"; errorCode = "max_turns"; }
else if (proc.exitCode === 0) status = "completed";
else status = "failed";
```

Session implementations update state tracking to use the new `SessionState` type, driven by the stream events they already parse.

### Export

Add to type exports in `src/index.ts`:
```typescript
export type { ExecutionStatus, SessionState, TokenUsage } from "./types.js";
```

---

## Implementation Order

Recommended sequence, grouped by dependency:

### Phase 1: Type Foundation (do first — everything else depends on these)

1. **O. Execution State Refinement** — `ExecutionStatus`, `SessionState`, replace scattered booleans
2. **N. Per-Model Usage Tracking** — `TokenUsage` type, `Record<string, TokenUsage>`, `aggregateUsage()`
3. **C. Billing Type Expansion** — Widen `billingType` union

> These are breaking type changes. Do them together in one pass to minimize churn across providers.

### Phase 2: Quick Wins (no cross-cutting dependencies)

4. **A. Instructions Resolution** — New utility + provider updates
5. **B. Runtime Home Env Var Lookup** — New utility, pure data

### Phase 3: Core Infrastructure

6. **D. Auth Detection + Bedrock** — New utility + Claude provider update (uses widened billingType from C)
7. **E. AbortSignal** — Process utility update + provider updates (uses `status: "aborted"` from O)
8. **F. Lifecycle Events** — Type changes + provider updates (depends on A for `"instructions"` step)

### Phase 4: Feature Additions

9. **G. Dynamic Model Discovery** — New cache utility + provider updates
10. **H. Quota Probing** — New types + Claude implementation
11. **I. Workspace Preparation** — New utility + type changes + optional provider integration

### Phase 5: Codex Parity

12. **L. Codex JSON-RPC 2.0 Session Mode** — New session.ts for Codex, JSON-RPC protocol
13. **M. Codex Token Usage from Session Logs** — Fallback usage scanner (uses TokenUsage from N)

### Phase 6: Polish

14. **J. Runtime Config Injection** — New utility + OpenCode refactor (depends on B)
15. **K. Tool Call Event Coverage** — Audit + provider parse updates (Codex benefits from L)

---

## Summary of New Files

| File | Purpose |
|------|---------|
| `src/utils/instructions.ts` | Read and resolve instructions files |
| `src/utils/runtime-homes.ts` | Env var and default path lookup per runtime |
| `src/utils/auth.ts` | Auth method detection + Bedrock model ID mapping |
| `src/utils/model-cache.ts` | Simple in-memory TTL cache for model lists |
| `src/utils/workspace.ts` | Git worktree creation, diff, and cleanup |
| `src/utils/runtime-config.ts` | Temporary config directory with overrides |
| `src/providers/codex/session.ts` | Codex JSON-RPC 2.0 session (bidirectional) |
| `src/providers/codex/usage-scanner.ts` | Scan Codex session logs for token usage |

## Summary of Type Changes

**`src/types.ts` modifications:**

| Interface | Change |
|-----------|--------|
| `ExecutionContext` | Add `signal?: AbortSignal`, `onLifecycle?: (event: LifecycleEvent) => void` |
| `ExecutionResult` | Replace `timedOut`/`aborted` with `status: ExecutionStatus`, add `workspace?: PreparedWorkspace`, change `usage` to `Record<string, TokenUsage>`, expand `billingType` to include `"metered_api"` |
| `SessionContext` | Add `onLifecycle?: (event: LifecycleEvent) => void` |
| `AgentSession` | Change `state` from `"idle" \| "running" \| "closed"` to `SessionState` (6 states) |
| `TurnResult` | Replace `isError`/`stopReason` with `status`, change `usage` to `Record<string, TokenUsage>` |
| `ProviderConfig` | Add `workspace?: { strategy: "worktree"; baseBranch?: string; branchName?: string }` |
| `ProviderModule` | Update `listModels` signature to accept `{ cacheTtlMs?: number }`, add `checkQuota?()` |
| `EnvironmentTestResult` | Add `version?: string` (CLI version detected during test) |
| `StreamEvent` (tool_call) | Add `callId: string` to correlate with `tool_result.toolCallId` |
| `SessionContext` | Add `signal?: AbortSignal` (same as ExecutionContext) |
| New: `ExecutionStatus` | `"completed" \| "failed" \| "aborted" \| "timeout" \| "blocked"` |
| New: `SessionState` | `"idle" \| "thinking" \| "tool_executing" \| "waiting_for_approval" \| "waiting_for_input" \| "closed"` |
| New: `TokenUsage` | `{ inputTokens, outputTokens, cachedInputTokens?, cacheCreationInputTokens? }` |
| New: `LifecycleEvent` | Discriminated union for execution phase tracking |
| New: `QuotaStatus` | Quota/rate limit status |
| New: `QuotaContext` | Context for quota checks |
| New: `ResolvedAuth` | Auth detection result (in `utils/auth.ts`) |

## Summary of New Exports from `src/index.ts`

**Functions:**
- `resolveInstructions`
- `getRuntimeHomeEnvVar`
- `getDefaultRuntimeHome`
- `detectAuth`
- `prepareWorkspace`
- `withTempConfig`
- `aggregateUsage`

**Types:**
- `ExecutionStatus`
- `SessionState`
- `TokenUsage`
- `LifecycleEvent`
- `QuotaStatus`
- `QuotaContext`
- `ResolvedAuth`
- `WorkspaceOptions`
- `PreparedWorkspace`
- `TempConfigResult`

---

## Decisions Log

Key design decisions made during planning:

1. **Model cache is a TTL number, not a boolean.** `cacheTtlMs: 0` means no cache (default). The caller decides the TTL. No forced caching policy.

2. **Home directory isolation is a lookup utility, not a managed system.** The library tells you which env var to set (`getRuntimeHomeEnvVar`). The app decides the directory structure and lifecycle. Most users only need `config.skillDirs` for skill injection without touching the home directory.

3. **Workspace preparation is both a standalone utility (Option B) and a convenience config option (Option A).** Option B (`prepareWorkspace()`) is the primitive — full lifecycle control. Option A (`config.workspace`) is sugar that calls Option B internally and attaches the workspace to the result.

4. **Instructions resolution is opt-in.** If `config.instructionsFile` is not set, nothing changes. The fix is making providers that currently ignore this field actually use it.

5. **AbortSignal uses the standard `AbortSignal` pattern** rather than a custom cancellation API. It's composable and already understood by the ecosystem.

6. **Auth detection includes Bedrock model ID transformation.** If Bedrock auth is detected, `resolveModelId()` on the result rewrites standard model names to Bedrock-qualified IDs. The caller doesn't need to think about Bedrock ID formats.

7. **Tool call event coverage is best-effort.** If a CLI tool doesn't expose tool call details in its output format, we don't fabricate events. We document the gap.

8. **This is a library of primitives, not an application.** We do NOT add: database-backed skill management, per-agent skill assignment, multi-tenant company scoping, or gateway protocols. Those are app-layer concerns for consumers to build on top of these primitives.

9. **Execution state uses discriminated status fields, not scattered booleans.** `ExecutionResult.status` replaces `timedOut` + `aborted` + implicit error checking. `TurnResult.status` replaces `isError` + `stopReason`. `AgentSession.state` expands from 3 states to 6 for granular observability.

10. **Usage is keyed by model name.** `Record<string, TokenUsage>` instead of flat object. Supports multi-model runs. `aggregateUsage()` convenience function for the common single-model case.

11. **Codex keeps both execution paths.** `execute()` stays as `codex exec --json` for simple fire-and-forget. `createSession()` uses `codex app-server --listen stdio://` for full bidirectional JSON-RPC 2.0. Consumers choose which they need.

12. **Codex token usage has a session log fallback.** When the primary protocol (JSONL or JSON-RPC) doesn't return usage, scan `~/.codex/sessions/YYYY/MM/DD/*.jsonl` for `token_count` events. Internal to the provider — consumers see usage in the standard result fields.
