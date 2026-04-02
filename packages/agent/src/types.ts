// Core provider interface — every provider must implement this
export interface ProviderModule {
  type: string;
  execute(ctx: ExecutionContext): Promise<ExecutionResult>;
  createSession?(ctx: SessionContext): Promise<AgentSession>;
  testEnvironment(ctx: EnvironmentTestContext): Promise<EnvironmentTestResult>;
  sessionCodec?: SessionCodec;
  listModels?(): Promise<ProviderModel[]>;
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
  mode?: string;
}

// Execution output
export interface ExecutionResult {
  runId: string;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  startedAt: string;
  completedAt: string;
  durationMs: number;
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
  raw?: Record<string, unknown> | null;
}

// Stream events — discriminated union
export type StreamEvent =
  | { type: "system"; subtype: string; sessionId: string | null; model: string | null; timestamp: string }
  | { type: "assistant"; text: string; timestamp: string }
  | { type: "thinking"; text: string; timestamp: string }
  | { type: "tool_call"; name: string; input: unknown; timestamp: string }
  | { type: "tool_result"; toolCallId: string; content: string; isError: boolean; timestamp: string }
  | { type: "result"; text: string; cost: number | null; isError: boolean; timestamp: string };

// Session persistence
export interface SessionCodec {
  deserialize(raw: unknown): Record<string, unknown> | null;
  serialize(params: Record<string, unknown> | null): Record<string, unknown> | null;
  getDisplayId?(params: Record<string, unknown> | null): string | null;
}

// Environment testing
export interface EnvironmentTestContext {
  providerType: string;
  config?: Record<string, unknown>;
}

export interface EnvironmentTestResult {
  providerType: string;
  status: "pass" | "warn" | "fail";
  checks: EnvironmentCheck[];
  testedAt: string;
}

export interface EnvironmentCheck {
  code: string;
  level: "info" | "warn" | "error";
  message: string;
  detail?: string;
  hint?: string;
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

  /** Called for every stream event across all turns. */
  onEvent?: (event: StreamEvent) => void | Promise<void>;
  /** Called for raw stdout/stderr output across all turns. */
  onOutput?: (stream: "stdout" | "stderr", chunk: string) => void | Promise<void>;

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
  readonly state: "idle" | "running" | "closed";

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
  usage?: { inputTokens: number; outputTokens: number; cachedInputTokens?: number };
  costUsd: number | null;
  isError: boolean;
  errorCode: string | null;
  errorMessage: string | null;
  /** Why the turn ended: "end_turn", "max_turns", "interrupt", etc. */
  stopReason: string | null;
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
