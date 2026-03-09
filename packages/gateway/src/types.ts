import type { Server } from "node:http";
import type {
  AdapterConfig,
  AdapterModule,
  ExecutionResult,
  McpServerConfig,
  StreamEvent,
} from "@agentex/adapters";

// Re-export adapter types consumers need
export type { AdapterModule, AdapterConfig, ExecutionResult, StreamEvent, McpServerConfig };

// ---------------------------------------------------------------------------
// Gateway
// ---------------------------------------------------------------------------

export interface Gateway {
  start(): Promise<void>;
  stop(): Promise<void>;
  readonly config: GatewayConfig;
  readonly events: GatewayEventEmitter;
}

export interface CreateGatewayOptions {
  configPath?: string;
  config?: Partial<GatewayConfig>;
  channels?: ChannelPlugin[];
  stateDir?: string;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface GatewayConfig {
  gateway: {
    bind: "loopback" | "lan" | string;
    port: number;
    auth: AuthConfig;
  };
  agent: AgentConfig;
  sessions: SessionsConfig;
  queue: QueueConfig;
  channels: Record<string, Record<string, unknown>>;
  agents?: Record<string, AgentConfig>;
  routing?: RoutingConfig;
  hooks?: Record<string, HookConfig>;
  stateDir?: string;
}

export interface AuthConfig {
  mode: "token" | "password" | "none";
  token?: string;
}

export interface AgentConfig {
  adapter: string;
  cwd: string;
  model?: string;
  maxTurns?: number;
  timeoutSec?: number;
  skipPermissions?: boolean;
  instructionsFile?: string;
  skillDirs?: string[];
  mcpServers?: McpServerConfig[];
  systemPromptTemplate?: string;
}

export interface SessionsConfig {
  dmScope: "main" | "per-peer" | "per-channel-peer";
  resetOnIdle?: string;
  identityLinks?: Record<string, string[]>;
}

export interface QueueConfig {
  mode: "queue" | "collect" | "steer" | "interrupt";
  collectDebounceMs?: number;
  collectMaxMessages?: number;
  maxQueueDepth?: number;
}

export interface RoutingConfig {
  rules: RoutingRule[];
  default: string;
}

export interface RoutingRule {
  match: {
    channel?: string;
    target?: string;
    chatType?: "direct" | "group" | "channel" | "thread";
  };
  agent: string;
}

export interface HookConfig {
  command: string;
}

export interface ChannelAccessConfig {
  dm?: {
    policy: "pairing" | "allowlist" | "open" | "disabled";
    allowFrom?: string[];
  };
  groups?: {
    policy: "mention" | "allowlist" | "open" | "disabled";
    allowFrom?: string[];
    mentionPattern?: string;
  };
}

// ---------------------------------------------------------------------------
// Channels
// ---------------------------------------------------------------------------

export interface ChannelPlugin {
  id: string;
  label: string;
  capabilities: ChannelCapabilities;
  start(ctx: ChannelContext): Promise<void>;
  stop(): Promise<void>;
  status(): Promise<ChannelStatus>;
  send(msg: OutboundMessage): Promise<SendResult>;
  editMessage?(msg: OutboundMessage & { messageId: string }): Promise<SendResult>;
}

export interface ChannelContext {
  config: Record<string, unknown>;
  onMessage: (msg: InboundMessage) => void;
  log: Logger;
  httpServer: Server;
}

export interface ChannelCapabilities {
  chatTypes: Array<"direct" | "group" | "channel" | "thread">;
  streaming?: boolean;
  streamingThrottleMs?: number;
  threads?: boolean;
  reactions?: boolean;
  media?: boolean;
  maxMessageLength?: number;
}

export interface ChannelStatus {
  ok: boolean;
  error?: string;
  details?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

export interface InboundMessage {
  messageId: string;
  channel: string;
  accountId?: string;
  senderId: string;
  senderName?: string;
  chatType: "direct" | "group" | "channel" | "thread";
  target: string;
  threadId?: string;
  text: string;
  attachments?: Attachment[];
  timestamp: number;
  raw?: unknown;
}

export interface OutboundMessage {
  channel: string;
  accountId?: string;
  target: string;
  threadId?: string;
  text: string;
  attachments?: OutboundAttachment[];
}

export interface SendResult {
  ok: boolean;
  messageId?: string;
  error?: string;
}

export interface OutboundAttachment {
  type: "file" | "image";
  filename: string;
  source: string;
  mimeType?: string;
}

export interface Attachment {
  type: "file" | "image" | "audio" | "video";
  filename?: string;
  url: string;
  mimeType?: string;
  size?: number;
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

export interface SessionEntry {
  key: string;
  sessionParams: Record<string, unknown> | null;
  lastChannel: string;
  lastRoute: ReplyRoute;
  lastSenderId?: string;
  model?: string;
  lastActivityAt: number;
}

export interface ReplyRoute {
  channel: string;
  accountId?: string;
  target: string;
  threadId?: string;
}

export interface TranscriptEntry {
  role: "user" | "assistant" | "system";
  text: string;
  channel: string;
  senderId?: string;
  ts: number;
}

// ---------------------------------------------------------------------------
// Access Control
// ---------------------------------------------------------------------------

export interface AccessDecision {
  allowed: boolean;
  reason?: string;
  pendingPairing?: boolean;
}

export interface PairingRequest {
  id: string;
  channel: string;
  accountId?: string;
  senderId: string;
  senderName?: string;
  heldMessages: InboundMessage[];
  requestedAt: number;
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export interface GatewayEventPayload {
  type: string;
  seq: number;
  ts: number;
  sessionKey?: string;
  data: Record<string, unknown>;
}

export type GatewayEvent =
  | "message.inbound"
  | "message.outbound"
  | "agent.start"
  | "agent.event"
  | "agent.complete"
  | "session.created"
  | "session.reset"
  | "channel.status"
  | "pairing.requested"
  | "pairing.approved"
  | "pairing.denied";

export interface GatewayEventEmitter {
  on(type: string, handler: (payload: GatewayEventPayload) => void): void;
  off(type: string, handler: (payload: GatewayEventPayload) => void): void;
  emit(type: string, data: Record<string, unknown>, sessionKey?: string): void;
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

export interface DispatchOptions {
  msg: InboundMessage;
  session: SessionEntry;
  agentConfig: AgentConfig;
  adapter: AdapterModule;
  onStreamEvent: (event: StreamEvent) => void;
  onSystemEvent: (sessionId: string | null, model: string | null) => void;
  signal?: AbortSignal;
}

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------

export interface Logger {
  info(msg: string, ...args: unknown[]): void;
  warn(msg: string, ...args: unknown[]): void;
  error(msg: string, ...args: unknown[]): void;
  debug(msg: string, ...args: unknown[]): void;
}
