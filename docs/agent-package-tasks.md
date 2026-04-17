# @agentex/agent Enhancement Tasks

Task list derived from [agent-package-enhancements.md](./agent-package-enhancements.md). Execute in order — phases are dependency-ordered.

---

## Phase 1: Type Foundation

> Breaking type changes. Do together to minimize churn across providers.

### O. Execution State Refinement

- [x] Add `ExecutionStatus` type to `src/types.ts`: `"completed" | "failed" | "aborted" | "timeout" | "blocked"`
- [x] Add `SessionState` type to `src/types.ts`: `"idle" | "thinking" | "tool_executing" | "waiting_for_approval" | "waiting_for_input" | "closed"`
- [x] Update `ExecutionResult`: remove `timedOut`, add `status: ExecutionStatus`
- [x] Update `AgentSession.state` from `"idle" | "running" | "closed"` to `SessionState`
- [x] Update `TurnResult`: remove `isError` and `stopReason`, add `status: "completed" | "failed" | "max_turns" | "max_budget" | "aborted"`, keep `errorCode`/`errorMessage`
- [x] Update all provider `execute.ts` result construction to set `status` instead of `timedOut`
- [x] Update Claude `session.ts` to track `SessionState` transitions from stream events
- [x] Export `ExecutionStatus` and `SessionState` from `src/index.ts`

### N. Per-Model Usage Tracking

- [x] Add `TokenUsage` interface to `src/types.ts`: `{ inputTokens, outputTokens, cachedInputTokens?, cacheCreationInputTokens? }`
- [x] Update `ExecutionResult.usage` from flat object to `Record<string, TokenUsage>`
- [x] Update `TurnResult.usage` from flat object to `Record<string, TokenUsage>`
- [x] Create `aggregateUsage()` helper function (in `src/utils/usage.ts` or inline in types)
- [x] Update all provider `execute.ts` to return `Record<string, TokenUsage>` (key = model name)
- [x] Update Claude `session.ts` to key usage by model name in `handleResult()`
- [x] Export `TokenUsage` and `aggregateUsage` from `src/index.ts`

### C. Billing Type Expansion

- [x] Update `ExecutionResult.billingType` type from `"api" | "subscription" | null` to `"api" | "subscription" | "metered_api" | null`

---

## Phase 2: Quick Wins

> No cross-cutting dependencies.

### A. Instructions Resolution

- [x] Create `src/utils/instructions.ts` with `resolveInstructions(filePath?: string): Promise<string | null>`
- [x] Update `providers/codex/execute.ts` — prepend resolved instructions to stdin prompt
- [x] Update `providers/gemini/execute.ts` — prepend to positional arg prompt
- [x] Update `providers/cursor/execute.ts` — prepend to stdin prompt
- [x] Update `providers/opencode/execute.ts` — prepend to stdin prompt
- [x] Update `providers/pi/execute.ts` — use native `--append-system-prompt` flag (like Claude)
- [x] Update `providers/process/execute.ts` — prepend to stdin if applicable
- [x] Export `resolveInstructions` from `src/index.ts`

### B. Runtime Home Env Var Lookup

- [x] Create `src/utils/runtime-homes.ts` with `getRuntimeHomeEnvVar(runtime)` and `getDefaultRuntimeHome(runtime)`
- [x] Implement mapping: claude→`CLAUDE_CONFIG_DIR`, codex→`CODEX_HOME`, gemini→`GEMINI_CONFIG_DIR`, cursor→`CURSOR_CONFIG_DIR`, opencode→`XDG_CONFIG_HOME`, pi→`PI_HOME`
- [x] Verify env var names against each CLI tool's actual documentation
- [x] Export `getRuntimeHomeEnvVar` and `getDefaultRuntimeHome` from `src/index.ts`

---

## Phase 3: Core Infrastructure

### D. Auth Detection + Bedrock Support

- [x] Create `src/utils/auth.ts` with `ResolvedAuth` interface and `detectAuth(providerType, env)` function
- [x] Implement Claude auth detection: `ANTHROPIC_API_KEY` → api, `ANTHROPIC_BEDROCK_BASE_URL`/`AWS_ACCESS_KEY_ID` → bedrock, fallback → subscription
- [x] Implement Bedrock model ID mapping: `bedrockModelId()` helper (e.g. `claude-sonnet-4-6` → `us.anthropic.claude-sonnet-4-6-v1`)
- [x] Implement Codex auth detection: `OPENAI_API_KEY` → api, fallback → subscription
- [x] Implement Gemini auth detection: `GEMINI_API_KEY`/`GOOGLE_API_KEY` → api, fallback → subscription
- [x] Implement other provider auth detection (cursor, opencode, pi)
- [x] Update `providers/claude/execute.ts` to use `detectAuth()` + `resolveModelId()` instead of inline check
- [x] Update other provider `execute.ts` files to use `detectAuth()` for billing type
- [x] Export `detectAuth` and `ResolvedAuth` from `src/index.ts`

### E. AbortSignal on Execute

- [x] Add `signal?: AbortSignal` to `ExecutionContext` in `src/types.ts`
- [x] Add `signal?: AbortSignal` to `SessionContext` in `src/types.ts`
- [x] Update `src/utils/process.ts` `runChildProcess()` to accept and handle `signal`
  - [x] Skip spawn if already aborted
  - [x] Add abort listener → `killProcessTree(pid, "SIGTERM")` then SIGKILL after `graceSec`
  - [x] Clean up listener on process exit
- [x] Update all provider `execute.ts` to pass `ctx.signal` through to `runChildProcess()`
- [x] Update all provider `execute.ts` result: set `status: "aborted"` when signal triggered
- [x] Update Claude `session.ts` to handle `signal` on SessionContext (call `close()` on abort)

### F. Lifecycle Events

- [x] Add `LifecycleEvent` type to `src/types.ts` (discriminated union: preparing, spawning, running, waiting_for_input, completed, cancelled, error)
- [x] Add `onLifecycle?: (event: LifecycleEvent) => void` to `ExecutionContext`
- [x] Add `onLifecycle?: (event: LifecycleEvent) => void` to `SessionContext`
- [x] Add `ctx.onLifecycle?.()` calls in `providers/claude/execute.ts` at key points
- [x] Add `ctx.onLifecycle?.()` calls in `providers/codex/execute.ts`
- [x] Add `ctx.onLifecycle?.()` calls in `providers/gemini/execute.ts`
- [x] Add `ctx.onLifecycle?.()` calls in `providers/cursor/execute.ts`
- [x] Add `ctx.onLifecycle?.()` calls in `providers/opencode/execute.ts`
- [x] Add `ctx.onLifecycle?.()` calls in `providers/pi/execute.ts`
- [x] Add `ctx.onLifecycle?.()` calls in `providers/process/execute.ts`
- [x] Export `LifecycleEvent` from `src/index.ts`

---

## Phase 4: Feature Additions

### G. Dynamic Model Discovery

- [x] Create `src/utils/model-cache.ts` with `ModelCache` class (in-memory TTL cache)
- [x] Update `ProviderModule.listModels` signature: `listModels?(options?: { cacheTtlMs?: number }): Promise<ProviderModel[]>`
- [x] Update `providers/codex/index.ts` — implement dynamic model discovery via CLI, with fallback to static list
- [x] Update `providers/gemini/index.ts` — implement dynamic model discovery via CLI, with fallback
- [x] Update `providers/opencode/index.ts` — implement `opencode models` parsing, with fallback
- [x] Update `providers/pi/index.ts` — implement `pi --list-models` parsing, with fallback
- [x] Update `providers/claude/index.ts` — refactored with ModelCache + CLI discovery + fallback
- [x] Update `providers/cursor/index.ts` — keep static list

### H. Quota Probing

- [x] Add `QuotaStatus` and `QuotaContext` interfaces to `src/types.ts`
- [x] Add `checkQuota?(ctx: QuotaContext): Promise<QuotaStatus>` to `ProviderModule`
- [x] Implement `checkQuota` for Claude provider in `providers/claude/index.ts`
- [x] Export `QuotaStatus` and `QuotaContext` from `src/index.ts`

### I. Workspace Preparation (Git Worktrees)

- [x] Create `src/utils/workspace.ts` with `WorkspaceOptions`, `PreparedWorkspace`, and `prepareWorkspace()`
- [x] Implement `prepareWorkspace()`: validate git repo, generate branch name, `git worktree add`
- [x] Implement `PreparedWorkspace.diff(base?)`: `git diff base...branch`
- [x] Implement `PreparedWorkspace.cleanup({ deleteBranch? })`: `git worktree remove` + optional `git branch -D`
- [x] Add `workspace?: { strategy: "worktree"; baseBranch?; branchName? }` to `ProviderConfig`
- [x] Add `workspace?: PreparedWorkspace` to `ExecutionResult`
- [x] Wire up `config.workspace` in provider execute paths (create worktree before execution, attach to result)
- [x] Export `prepareWorkspace`, `WorkspaceOptions`, `PreparedWorkspace` from `src/index.ts`

---

## Phase 5: Codex Parity

### L. Codex JSON-RPC 2.0 Session Mode

- [x] Create `src/providers/codex/session.ts`
- [x] Implement JSON-RPC 2.0 message layer (request/response/notification types, id sequencing)
- [x] Implement `initialize` handshake: clientInfo, capabilities
- [x] Implement `thread/start`: model, cwd, sandbox, developerInstructions
- [x] Implement `turn/start` (called on each `session.send()`): threadId, input
- [x] Implement tool approval protocol: `item/commandExecution/requestApproval`, `item/fileChange/requestApproval` → delegate to `onUserInputRequest` or auto-approve
- [x] Implement notification handling — legacy (`codex/event` with msg field) and v2 (`item/started`, `item/completed`, `turn/completed`)
- [x] Map Codex notifications to `StreamEvent` types
- [x] Implement `AgentSession` interface: `send()`, `interrupt()`, `close()`, `state` tracking
- [x] Add `createSession` to `providers/codex/index.ts` provider module export

### M. Codex Token Usage from Session Logs

- [x] Create `src/providers/codex/usage-scanner.ts` with `scanCodexSessionUsage()`
- [x] Implement log path resolution: `CODEX_HOME` or `~/.codex` → `sessions/YYYY/MM/DD/*.jsonl`
- [x] Implement JSONL scanning for `token_count` events after `startedAfter` timestamp
- [x] Implement optional `threadId` filtering
- [x] Aggregate `InputTokens`, `OutputTokens`, `CachedInputTokens`, `CacheReadInputTokens`
- [x] Add fallback in `providers/codex/execute.ts`: if usage is null, call `scanCodexSessionUsage()`
- [x] Add fallback in `providers/codex/session.ts`: scan after turn completes with no usage

---

## Phase 6: Polish

### J. Runtime Config Injection

- [x] Create `src/utils/runtime-config.ts` with `TempConfigResult` interface and `withTempConfig()` function
- [x] Implement: read runtime home env var, create temp dir, seed from default home, apply overrides, return env + cleanup
- [x] Refactor `providers/opencode/execute.ts` to use `withTempConfig()` instead of inline temp config logic
- [x] Export `withTempConfig` and `TempConfigResult` from `src/index.ts`

### K. Tool Call Event Coverage

- [x] Add `callId: string` to `StreamEvent` `tool_call` variant in `src/types.ts`
- [x] Audit `providers/codex/parse.ts` — emit `tool_call`/`tool_result` events from `item.completed` function call details
- [x] Audit `providers/gemini/parse.ts` — emit tool events if JSONL contains tool use info
- [x] Audit `providers/pi/parse.ts` — map existing `tool_call_start`/`tool_call_end`/`tool_call_error` to `StreamEvent` tool types
- [x] Audit `providers/cursor/parse.ts` — check stream-json for tool use details, emit if present
- [x] Audit `providers/opencode/parse.ts` — check JSONL format for tool call info, emit if present
- [x] Document gaps for providers whose CLI doesn't expose tool call details

---

## Final Verification

- [x] All new types exported from `src/index.ts`
- [x] All new functions exported from `src/index.ts`
- [x] `tsc --noEmit` passes with no errors
- [x] Existing tests still pass (update test mocks for changed types)
- [x] Write tests for new utilities: `resolveInstructions`, `detectAuth`, `prepareWorkspace`, `withTempConfig`, `aggregateUsage`, `scanCodexSessionUsage`
