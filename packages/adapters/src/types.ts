// Core adapter interface — every adapter must implement this
export interface AdapterModule {
  type: string;
  execute(ctx: ExecutionContext): Promise<ExecutionResult>;
  testEnvironment(ctx: EnvironmentTestContext): Promise<EnvironmentTestResult>;
  sessionCodec?: SessionCodec;
  listModels?(): Promise<AdapterModel[]>;
}

// Execution input
export interface ExecutionContext {
  runId: string;
  prompt: string;
  cwd: string;
  env?: Record<string, string>;
  sessionParams?: Record<string, unknown> | null;
  config?: AdapterConfig;
  onOutput?: (stream: "stdout" | "stderr", chunk: string) => void | Promise<void>;
  onEvent?: (event: StreamEvent) => void | Promise<void>;
}

// Adapter-specific configuration
export interface AdapterConfig {
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
}

// Execution output
export interface ExecutionResult {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
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
  adapterType: string;
  config?: Record<string, unknown>;
}

export interface EnvironmentTestResult {
  adapterType: string;
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
export interface AdapterModel {
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
