/** Static declaration of what a provider supports. */
export interface ProviderCapabilities {
  sessions: boolean;
  modelDiscovery: boolean;
  quotaProbing: boolean;
  mcp: boolean;
  skills: boolean;
  instructions: boolean;
  workspace: boolean;
  /**
   * Read-only "plan" mode is honored by this provider. When `true`, the
   * provider runs the agent so it can read and reason but cannot mutate.
   *
   * Mechanism differs per provider:
   * - `claude`: `--permission-mode plan` — CLI-native plan UX. The agent
   *   emits its plan through the `ExitPlanMode` tool as a permission
   *   request; the host extracts it via `parseExitPlanMode(req)`.
   * - `codex`: `--sandbox read-only` plus an injected planning system
   *   preamble. Codex *does* have a native plan mode (one of three
   *   collaboration modes — Plan, Pair, Execute — activated by `/plan` or
   *   Shift+Tab in the TUI), but `codex exec` exposes no flag to start in
   *   that mode and the JSON-RPC `collaboration_mode` parameter is per
   *   message, not startup. So the plan ends up in `ExecutionResult.summary`
   *   instead of streaming through `item/plan/delta` events. No in-protocol
   *   approval gate; the consumer drives the next step.
   *
   * Providers with this set to `false` ignore `config.planMode` entirely.
   */
  planMode: boolean;
}

// Core provider interface — every provider must implement this
export interface ProviderModule {
  type: string;
  capabilities: ProviderCapabilities;
  execute(ctx: ExecutionContext): Promise<ExecutionResult>;
  createSession?(ctx: SessionContext): Promise<AgentSession>;
  /**
   * Single source of truth for "is this provider usable?" Returns binary
   * status, every supported auth path with present: boolean, and (when
   * available) rich identity info (email, org, subscription tier).
   *
   * Prefers the CLI's own status subcommand (e.g. `claude auth status --json`,
   * `codex login status`) for definitive truth, falling back to filesystem
   * heuristics if the binary is missing or too old.
   *
   * Results are cached for 60s per provider+env; pass `{ fresh: true }` to
   * bypass the cache.
   */
  resolveAuth(ctx?: AuthResolveContext): Promise<AuthReport>;
  sessionCodec?: SessionCodec;
  /** List available models. Pass cacheTtlMs to cache results (0 = no cache, default). */
  listModels?(options?: { cacheTtlMs?: number }): Promise<ProviderModel[]>;
  /** Check current quota/rate limit status. Not all providers support this. */
  checkQuota?(ctx: QuotaContext): Promise<QuotaStatus>;
}

// Execution input
export interface ExecutionContext {
  prompt: string;
  model?: string;
  runId?: string;
  cwd?: string;
  env?: Record<string, string>;
  sessionParams?: Record<string, unknown> | null;
  config?: ProviderConfig;
  onOutput?: (stream: "stdout" | "stderr", chunk: string) => void | Promise<void>;
  onEvent?: (event: StreamEvent) => void | Promise<void>;
  onStart?: (pid: number) => void;
  /** AbortSignal to cancel execution. When aborted, the process receives SIGTERM
   *  followed by SIGKILL after the grace period. */
  signal?: AbortSignal;
  /** Called at key execution lifecycle phases (preparing, spawning, running, etc.). */
  onLifecycle?: (event: LifecycleEvent) => void;
}

// Provider-specific configuration
export interface ProviderConfig {
  command?: string;
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
  /**
   * Provider-specific mode pass-through. Currently used by `cursor` for its
   * `--mode <mode>` flag. Don't use this for plan mode — set `planMode: true`
   * instead, which is the cross-provider abstraction.
   */
  mode?: string;
  /**
   * Run the agent in read-only "plan" mode: it can read, search, and reason,
   * but cannot edit files or run mutating commands. Honored by providers
   * with `capabilities.planMode === true` (claude, codex). Ignored by
   * providers that don't support it — check `provider.capabilities.planMode`
   * before relying on it.
   *
   * Mutually exclusive with `skipPermissions`. If both are set, `planMode`
   * wins (more conservative intent) and `skipPermissions` is ignored.
   *
   * To resume a planned session in normal (executing) mode, pass the
   * returned `sessionParams` on the next call with `planMode: false`.
   */
  planMode?: boolean;
  /** Run the agent in an isolated workspace. The library creates a worktree
   *  before execution and uses it as the working directory. */
  workspace?: {
    strategy: "worktree";
    baseBranch?: string;
    branchName?: string;
  };
}

// ---------------------------------------------------------------------------
// Quota probing
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Execution status & session state
// ---------------------------------------------------------------------------

/** Final outcome of a single-turn execution. */
export type ExecutionStatus =
  | "completed"    // success
  | "failed"       // agent or execution error
  | "aborted"      // cancelled via AbortSignal
  | "timeout"      // exceeded time limit
  | "blocked";     // agent reported a blocker it can't resolve

/** Live state of an interactive session. */
export type SessionState =
  | "idle"                  // session created, no turn in progress
  | "thinking"              // agent is generating/reasoning
  | "tool_executing"        // agent is running a tool
  | "waiting_for_approval"  // blocked on tool permission request
  | "waiting_for_input"     // blocked on user input (AskUserQuestion, elicitation)
  | "closed";               // session ended

// ---------------------------------------------------------------------------
// Token usage
// ---------------------------------------------------------------------------

/**
 * Token usage for a single model within a run.
 *
 * `cachedInputTokens` normalizes across providers:
 * - Claude: `cache_read_input_tokens`
 * - Codex: `cached_input_tokens`
 *
 * `cacheCreationInputTokens` is Claude-specific (`cache_creation_input_tokens`).
 */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
  cacheCreationInputTokens?: number;
}

/**
 * Per-model usage with optional cost + rate-limit-adjacent extras.
 * Claude populates most fields via its `modelUsage` result payload;
 * other providers populate only `TokenUsage` fields and leave the rest
 * undefined.
 */
export interface ModelUsage extends TokenUsage {
  costUsd?: number;
  webSearchRequests?: number;
  contextWindow?: number;
  maxOutputTokens?: number;
}

/**
 * Get aggregate usage across all models. Convenience for when you don't
 * care about per-model breakdown.
 */
export function aggregateUsage(usage: Record<string, TokenUsage> | undefined): TokenUsage | null {
  if (!usage) return null;
  const entries = Object.values(usage);
  if (entries.length === 0) return null;
  const result: TokenUsage = { inputTokens: 0, outputTokens: 0 };
  for (const u of entries) {
    result.inputTokens += u.inputTokens;
    result.outputTokens += u.outputTokens;
    if (u.cachedInputTokens != null) {
      result.cachedInputTokens = (result.cachedInputTokens ?? 0) + u.cachedInputTokens;
    }
    if (u.cacheCreationInputTokens != null) {
      result.cacheCreationInputTokens = (result.cacheCreationInputTokens ?? 0) + u.cacheCreationInputTokens;
    }
  }
  return result;
}

/**
 * Rate-limit signal reported by a provider (currently Claude's
 * `rate_limit_event`). Surfaced both as a StreamEvent and aggregated onto
 * `ExecutionResult.rateLimits` for consumers that want quota state.
 */
export interface RateLimitInfo {
  /** Provider-reported status, e.g. "allowed" | "rejected". */
  status: string;
  /** Kind of limit, e.g. Claude's "five_hour" / "weekly". */
  limitType: string | null;
  /** ISO timestamp when the limit window resets, when known. */
  resetAt: string | null;
  /** Provider-reported overage state (Claude: "allowed" / null). */
  overageStatus: string | null;
  /** Whether the current run is consuming from overage capacity. */
  isUsingOverage: boolean | null;
}

// Execution output
export interface ExecutionResult {
  runId: string;
  exitCode: number | null;
  signal: string | null;
  status: ExecutionStatus;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  errorMessage: string | null;
  errorCode: string | null;
  usage?: Record<string, ModelUsage>;
  costUsd: number | null;
  model: string | null;
  summary: string | null;
  sessionParams: Record<string, unknown> | null;
  sessionDisplayId: string | null;
  clearSession: boolean;
  billingType: "api" | "subscription" | "metered_api" | null;

  // ---- Provider-reported run metadata (populated when the provider reports it) ----
  /** Why the model stopped (e.g. "end_turn", "max_turns", "tool_use"). Claude only. */
  stopReason?: string | null;
  /** CLI's own terminal reason (Claude: "completed" | "error" | ...). Claude only. */
  terminalReason?: string | null;
  /** Total turns executed, when the provider reports it. Claude only. */
  numTurns?: number | null;
  /** Time spent in model API calls, separate from wall-clock `durationMs`. Claude only. */
  durationApiMs?: number | null;
  /** Claude's `permission_denials` array, verbatim. */
  permissionDenials?: unknown[];
  /** Every rate-limit signal observed during the run. Claude only. */
  rateLimits?: RateLimitInfo[];

  /**
   * True escape hatch. Holds the final provider-native event object
   * verbatim — Claude's `result` event, or Codex's `turn.completed` /
   * `turn.failed` / `error`. Use for anything we haven't normalized.
   */
  raw?: Record<string, unknown> | null;
  /** If the run used a workspace, this contains the workspace handle for diffing/cleanup */
  workspace?: import("./utils/workspace.js").PreparedWorkspace;
}

/**
 * Fields present on every `StreamEvent`. Populated per-provider:
 *
 * | Field             | Claude                            | Codex                          |
 * |-------------------|-----------------------------------|--------------------------------|
 * | sessionId         | `session_id`                      | `thread_id`                    |
 * | eventId           | top-level `uuid`                  | null (CLI doesn't emit)        |
 * | messageId         | `message.id` (`msg_*`)            | `item.id` — **turn-local**, resets per turn, not globally unique |
 * | parentToolCallId  | `parent_tool_use_id`              | null                           |
 * | providerType      | "claude"                          | "codex"                        |
 * | raw               | original event object verbatim    | original event object verbatim |
 *
 * Other providers (cursor, gemini, opencode, pi, openclaw) currently emit
 * stubs (null IDs, partial raw). Enriching them is tracked in
 * `internal-docs/stream-event-enrichment.md`.
 */
export interface BaseStreamEventFields {
  timestamp: string;
  /** Which provider emitted this event. */
  providerType: string;
  /** Stable session/thread ID across turns; null when not yet known. */
  sessionId: string | null;
  /**
   * Provider-native message ID.
   * - Claude: Anthropic API message ID like `msg_01...`.
   * - Codex: `item_N` where N resets per turn — NOT globally unique.
   *   Combine with (sessionId, turn index) if you need a stable key.
   */
  messageId: string | null;
  /**
   * Unique ID for this specific event line. Claude emits a top-level
   * `uuid` on every line; Codex doesn't, so this is null for Codex.
   */
  eventId: string | null;
  /**
   * Native turn identifier for providers that emit one. Turn-scoped
   * events (items, deltas, token usage, turn completion) share this value.
   *
   * - Codex v2 JSON-RPC app-server: native UUIDv7 from `params.turnId`
   *   (or `params.turn.id` on turn/started + turn/completed notifications).
   * - Codex legacy NDJSON (`codex exec --json`): null. Legacy emits bare
   *   `{"type":"turn.started"}` with no turn id.
   * - Claude: null. `messageId` (`msg_*`) is globally unique so turn
   *   scope isn't needed to disambiguate rows.
   *
   * For Codex v2, `(sessionId, turnId, messageId)` is a stable composite
   * key. For legacy Codex, `messageId` (`item_N`) is turn-local and will
   * collide across turns — scope by event insertion order instead.
   */
  turnId: string | null;
  /**
   * Lineage: the `toolCallId` of the ancestor Task tool_call that spawned
   * this sub-agent. Same ID namespace as `tool_call.toolCallId`. Null
   * when the event isn't inside a sub-agent. Claude only.
   */
  parentToolCallId: string | null;
  /** Original provider event object verbatim, for fields we don't normalize. */
  raw: Record<string, unknown>;
}

/**
 * Categorical reason for an `auth_required` event. Derived from the
 * provider's user-facing error text. Stable across providers — new
 * provider integrations should map their auth strings into this set
 * rather than introducing per-provider variants.
 *
 * Mappings for Claude (from https://code.claude.com/docs/en/errors):
 * - `expired` — `OAuth token has expired · Please run /login`
 * - `revoked` — `OAuth token revoked · Please run /login`
 * - `missing` — `Not logged in · Please run /login`
 * - `invalid` — `Invalid API key · Fix external API key`, `Failed to
 *   authenticate. API Error: 401 Invalid bearer token`, Bedrock 403
 *   "security token included in the request is invalid"
 * - `scope` — `OAuth token does not meet scope requirement: <scope>`
 * - `disabled_org` — `Your ANTHROPIC_API_KEY belongs to a disabled
 *   organization · ...`
 * - `routines_disabled` — `Routines are disabled by your organization's
 *   policy.`
 * - `unknown` — anything we couldn't classify (still emitted, but the
 *   consumer can't branch on a specific recovery path).
 */
export type AuthRequiredReason =
  | "expired"
  | "revoked"
  | "missing"
  | "invalid"
  | "scope"
  | "disabled_org"
  | "routines_disabled"
  | "unknown";

// Stream events — discriminated union
export type StreamEvent =
  | ({
      type: "system";
      subtype: string;
      model: string | null;
      cwd: string | null;
      tools: string[] | null;
      permissionMode: string | null;
    } & BaseStreamEventFields)
  | ({ type: "assistant"; text: string } & BaseStreamEventFields)
  | ({ type: "thinking"; text: string } & BaseStreamEventFields)
  | ({
      type: "tool_call";
      /** This tool invocation's own ID. Matched later by tool_result.toolCallId. */
      toolCallId: string | null;
      name: string;
      input: unknown;
    } & BaseStreamEventFields)
  | ({
      type: "tool_result";
      /** FK back to the tool_call.toolCallId this responds to. */
      toolCallId: string | null;
      content: string;
      isError: boolean;
      /** Exit code for command-execution tools (Codex); null otherwise. */
      exitCode: number | null;
    } & BaseStreamEventFields)
  | ({
      type: "rate_limit";
      status: string;
      limitType: string | null;
      resetAt: string | null;
      overageStatus: string | null;
      isUsingOverage: boolean | null;
    } & BaseStreamEventFields)
  /**
   * Emitted when the provider's API rejected the request because the user
   * is not authenticated. Distinct from `rate_limit` and from generic
   * `result.isError` outcomes. Consumers should surface a login button or
   * banner; the running session is unrecoverable until the user re-auths
   * and (typically) the session handle is recycled.
   *
   * Driven by structured wire fields (Claude: `api_error_status` 401/403 on
   * the `result` event and `error: "authentication_failed"` on the
   * synthetic-assistant message). Falls back to text-match against the
   * documented user-facing strings (see https://code.claude.com/docs/en/errors)
   * for cases where the CLI short-circuits before any HTTP round-trip
   * (`Not logged in · Please run /login`).
   */
  | ({
      type: "auth_required";
      /**
       * Upstream HTTP status that triggered this. 401 or 403 when the CLI
       * actually reached the API; null when the CLI short-circuited (e.g.
       * `Not logged in` before any network call) or when derived from a
       * text-only signal.
       */
      httpStatus: number | null;
      /** Categorical reason. Stable across providers. */
      reason: AuthRequiredReason;
      /** Provider-recommended recovery command, e.g. `claude auth login`. */
      loginCommand: string;
      /** Provider's human-readable message for display. Not for branching. */
      message: string | null;
    } & BaseStreamEventFields)
  /**
   * Permission mode change. Claude emits a top-level `permission-mode` event
   * when the agent transitions between modes (e.g., user accepts a plan and
   * the session leaves `plan` mode). The `system.init` event also reports
   * the initial `permissionMode`; this variant reports subsequent transitions.
   *
   * Claude's known values: `"default"`, `"plan"`, `"acceptEdits"`,
   * `"bypassPermissions"`. Kept as `string` for forward compat.
   */
  | ({
      type: "permission_mode";
      permissionMode: string;
    } & BaseStreamEventFields)
  | ({
      type: "result";
      text: string;
      costUsd: number | null;
      isError: boolean;
      stopReason: string | null;
      terminalReason: string | null;
      numTurns: number | null;
      durationMs: number | null;
    } & BaseStreamEventFields)
  /**
   * Emitted when the parser sees a wire event type it doesn't have a
   * first-class variant for. Gives consumers forward-compat access to
   * new provider events via `raw` without requiring a library update.
   * `subtype` carries the provider's outer `type` field value.
   *
   * Provider-native discriminators and payloads remain in `raw` — the
   * event shape is intentionally minimal here because we do not model
   * these events. Known locations:
   * - Claude: `raw.subtype` (inner discriminator, e.g. `away_summary`,
   *   `compact_boundary`, `turn_duration`), `raw.content` (payload text
   *   when present).
   * - Codex: `raw.method` (JSON-RPC method), or nested `raw.item.type`
   *   for `item/completed` events whose item type is unrecognized.
   * - Cursor / Gemini / OpenCode / Pi: `raw.type` mirrors `subtype`;
   *   payload fields vary per wire event.
   *
   * For Claude specifically, see `getClaudeUnknownDetails` in
   * `providers/claude/parse.ts` for an ergonomic accessor.
   */
  | ({
      type: "unknown";
      subtype: string;
    } & BaseStreamEventFields);

// Lifecycle events — execution phase tracking
export type LifecycleEvent =
  | { phase: "preparing"; step: "workspace" | "skills" | "auth" | "instructions" | "binary" }
  | { phase: "spawning" }
  | { phase: "running"; pid: number }
  | { phase: "waiting_for_input"; request: UserInputRequest }
  | { phase: "completed" }
  | { phase: "cancelled" }
  | { phase: "error"; message: string };

// Session persistence
export interface SessionCodec {
  deserialize(raw: unknown): Record<string, unknown> | null;
  serialize(params: Record<string, unknown> | null): Record<string, unknown> | null;
  getDisplayId?(params: Record<string, unknown> | null): string | null;
}

// ---------------------------------------------------------------------------
// Auth reporting
// ---------------------------------------------------------------------------

/** How a provider is authenticated. Determines billing behavior at runtime. */
export type AuthMethod = "api_key" | "bedrock" | "subscription";

/** Where an auth credential lives. */
export type AuthSource =
  /** Single environment variable, e.g. OPENAI_API_KEY. */
  | { kind: "env"; var: string }
  /** Multiple env vars that together form one credential, e.g. AWS creds. */
  | { kind: "env_combo"; vars: string[] }
  /** A file on disk, e.g. ~/.codex/auth.json. Path is already resolved. */
  | { kind: "file"; path: string }
  /** macOS keychain entry. */
  | { kind: "keychain"; service: string; account?: string }
  /** Determined by spawning a CLI status command. */
  | { kind: "cli"; command: string };

/**
 * One auth path this provider supports, with its current presence state.
 *
 * `present` is boolean: true if the credential is confirmed present,
 * false otherwise. Previously `"unknown"` was a third state for macOS
 * keychain; the CLI-status approach replaces it with definitive truth.
 */
export interface AuthOption {
  method: AuthMethod;
  source: AuthSource;
  present: boolean;
}

/** Binary status for a provider's CLI. */
export interface BinaryStatus {
  installed: boolean;
  /** Resolved absolute path to the binary, when installed. */
  resolvedPath?: string;
  /** Version string from `<cli> --version`, when we could parse one. */
  version?: string;
  /** Error message when installed=false (e.g. "command not found"). */
  error?: string;
}

/**
 * Rich identity info reported by the CLI's own auth-status command.
 * Only populated for providers that expose this (currently Claude;
 * Codex exposes a limited version).
 */
export interface AuthIdentity {
  /** Email address of the logged-in account, when known. */
  email?: string;
  /** Organization / team name, when known. */
  orgName?: string;
  /**
   * Subscription tier as reported by the CLI (e.g. "max", "pro", "team",
   * "enterprise"). Provider-specific free-form string.
   */
  subscriptionType?: string;
  /**
   * Active auth method as reported by the CLI (e.g. "claude.ai",
   * "chatgpt", "api_key", "bedrock"). Provider-specific free-form string.
   * Distinct from AuthMethod, which is the normalized billing-mode
   * category.
   */
  authMethod?: string;
}

/** Full auth report for a provider. */
export interface AuthReport {
  providerType: string;
  /** Whether the CLI binary is installed and what we know about it. */
  binary: BinaryStatus;
  /**
   * Every auth path this provider supports, with current presence state.
   * Empty when the binary is missing (there's nothing to report against).
   */
  options: AuthOption[];
  /** Rich identity info from the CLI's status output, when available. */
  identity?: AuthIdentity;
  /**
   * Where the presence data came from:
   * - "cli": parsed from a live `<cli> auth status` call (definitive)
   * - "filesystem": best-effort heuristic from env vars and files
   *   (used when the binary is missing or its status subcommand failed)
   */
  source: "cli" | "filesystem";
}

/** Optional context for auth resolution. */
export interface AuthResolveContext {
  /** Additional env vars layered on top of process.env. */
  env?: Record<string, string>;
  /** Override the CLI binary path (passed through to findBinary). */
  command?: string;
  /** Bypass the 60s result cache and refresh from source. */
  fresh?: boolean;
}

// Models
export interface ProviderModel {
  id: string;
  name: string;
  provider?: string;
}

// MCP server configuration
export interface McpServerConfig {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Multi-turn session types
// ---------------------------------------------------------------------------

/** Context for creating a persistent multi-turn session. */
export interface SessionContext {
  cwd?: string;
  env?: Record<string, string>;
  config?: ProviderConfig;
  /** Resume an existing session. If omitted, starts fresh. */
  sessionParams?: Record<string, unknown> | null;
  /** AbortSignal to cancel the session. When aborted, the session is closed
   *  and the underlying process is terminated. */
  signal?: AbortSignal;

  /** Called for every stream event across all turns. */
  onEvent?: (event: StreamEvent) => void | Promise<void>;
  /** Called for raw stdout/stderr output across all turns. */
  onOutput?: (stream: "stdout" | "stderr", chunk: string) => void | Promise<void>;
  /** Called at key execution lifecycle phases (preparing, spawning, running, etc.). */
  onLifecycle?: (event: LifecycleEvent) => void;

  /**
   * Called when the agent needs confirmation or user input before proceeding
   * with a tool call. This covers both regular tool permissions (e.g. Bash,
   * Write) and interactive tools like AskUserQuestion.
   *
   * Use `parseAskUserQuestion(req)` to detect structured question prompts
   * and return answers via `updatedInput`.
   *
   * Return `{ allow: true }` to proceed, `{ allow: false }` to deny.
   * If not provided, all tool calls are auto-allowed.
   */
  onUserInputRequest?: (req: UserInputRequest) => Promise<UserInputResponse>;

  /**
   * Called when an MCP server requests user input (form fields, multiple
   * choice, URL, etc.). Return `{ action: "accept", content: {...} }` to
   * provide the input, `{ action: "decline" }` to refuse, or
   * `{ action: "cancel" }` to abort the current turn.
   *
   * If not provided, all elicitations are declined.
   */
  onElicitation?: (req: ElicitationRequest) => Promise<ElicitationResponse>;

  /**
   * Called when the CLI needs the host to run a hook callback.
   * If not provided, hook callbacks return an empty result.
   */
  onHookCallback?: (req: HookCallbackRequest) => Promise<HookCallbackResponse>;
}

/** A persistent session handle for multi-turn conversations. */
export interface AgentSession {
  readonly sessionId: string | null;
  readonly state: SessionState;

  /** Send a user message and wait for the agent's turn to complete. */
  send(message: string): Promise<TurnResult>;

  /** Gracefully interrupt the current turn. */
  interrupt(): Promise<void>;

  /** Terminate the session and kill the underlying process. */
  close(): Promise<void>;
}

/** Result of a single turn within a session. */
export interface TurnResult {
  summary: string | null;
  usage?: Record<string, TokenUsage>;
  costUsd: number | null;
  status: "completed" | "failed" | "max_turns" | "max_budget" | "aborted";
  errorCode: string | null;
  errorMessage: string | null;
}

/**
 * Describes a tool the agent wants to use and needs confirmation or user
 * input before proceeding. This is the unified callback for both regular
 * tool permissions (Bash, Write, etc.) and interactive tools like
 * AskUserQuestion.
 *
 * For AskUserQuestion, use `parseAskUserQuestion(req)` to extract the
 * structured questions and return answers via `updatedInput`.
 */
export interface UserInputRequest {
  toolName: string;
  input: Record<string, unknown>;
  toolUseId: string;
  /** Human-readable title for the tool action. */
  title?: string;
  /** Display name of the tool. */
  displayName?: string;
  /** Why the agent decided to use this tool. */
  description?: string;
  /** ID of the sub-agent making the request, if any. */
  agentId?: string;
}

/** Host response to a tool request. */
export interface UserInputResponse {
  allow: boolean;
  message?: string;
  /** Optionally modify the tool's input before execution (e.g. answers for AskUserQuestion). */
  updatedInput?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Elicitation — server-initiated user input requests (forms, choices, URLs)
// ---------------------------------------------------------------------------

/**
 * Sent when a server (typically an MCP tool-server running inside the Claude
 * process) needs user input. The request can represent anything from a simple
 * yes/no confirmation to a rich multi-field form combining dropdowns,
 * checkboxes, text fields, and number inputs.
 *
 * The `requestedSchema` is a standard JSON Schema (type: "object") whose
 * `properties` define the form fields. Supported property types:
 *
 * | Schema pattern | Renders as |
 * |---|---|
 * | `{ "type": "string", "oneOf": [{ "const": "a", "title": "A" }, ...] }` | Single-select dropdown / radio |
 * | `{ "type": "string", "enum": ["x", "y"] }` | Single-select (legacy) |
 * | `{ "type": "array", "items": { "anyOf": [{ "const": "a" }, ...] } }` | Multi-select checkboxes |
 * | `{ "type": "string" }` | Freeform text input |
 * | `{ "type": "string", "format": "email" \| "uri" \| "date" }` | Validated text input |
 * | `{ "type": "integer", "minimum": 1, "maximum": 10 }` | Number input |
 * | `{ "type": "boolean" }` | Toggle / checkbox |
 *
 * A single form can mix all of these — e.g., a dropdown for language, checkboxes
 * for features, and a freeform "notes" field.
 *
 * **Example — multiple choice + freeform:**
 * ```json
 * { "type": "object", "properties": {
 *     "framework": { "type": "string", "oneOf": [
 *       { "const": "express", "title": "Express" },
 *       { "const": "fastify", "title": "Fastify" },
 *       { "const": "hono", "title": "Hono" }
 *     ]},
 *     "features": { "type": "array", "items": {
 *       "anyOf": [
 *         { "const": "auth", "title": "Authentication" },
 *         { "const": "db", "title": "Database" },
 *         { "const": "ws", "title": "WebSockets" }
 *       ]
 *     }},
 *     "notes": { "type": "string" }
 *   },
 *   "required": ["framework"]
 * }
 * ```
 */
export interface ElicitationRequest {
  /**
   * Name of the MCP server requesting input. Maps to the `mcp_server_name`
   * field in the Claude protocol. Display this so the user knows which
   * server is asking for input.
   */
  mcpServerName: string;
  /** Human-readable prompt describing what input is needed. */
  message: string;
  /** How to present the request: "form" for inline input, "url" to open a browser. */
  mode?: "form" | "url";
  /** URL to open when mode is "url". */
  url?: string;
  /** Unique ID for this elicitation, used for deduplication. */
  elicitationId?: string;
  /**
   * JSON Schema (type: "object") describing the expected input. Each property
   * in `properties` is a form field. See the type-level JSDoc for the full
   * list of supported property types and examples.
   */
  requestedSchema?: Record<string, unknown>;
}

/** Host response to an elicitation request. */
export interface ElicitationResponse {
  /** "accept" to provide content, "decline" to refuse, "cancel" to abort the turn. */
  action: "accept" | "decline" | "cancel";
  /** The user's input, matching the requestedSchema. Only required when action is "accept". */
  content?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Hook callbacks — CLI requesting the host to run a hook
// ---------------------------------------------------------------------------

/** Sent when the CLI needs the host to execute a hook callback. */
export interface HookCallbackRequest {
  callbackId: string;
  input: Record<string, unknown>;
  toolUseId?: string;
}

/** Host response to a hook callback. */
export interface HookCallbackResponse {
  result?: Record<string, unknown>;
}
