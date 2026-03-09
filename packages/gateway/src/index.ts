// Functions
export { createGateway } from "./gateway.js";
export { defineChannel } from "./channels/define.js";

// Re-export adapter types consumers need
export type { AdapterModule, AdapterConfig, ExecutionResult, StreamEvent } from "./types.js";

// Gateway types
export type {
  Gateway,
  CreateGatewayOptions,
  GatewayConfig,
  ChannelPlugin,
  ChannelContext,
  ChannelCapabilities,
  ChannelStatus,
  InboundMessage,
  OutboundMessage,
  SendResult,
  OutboundAttachment,
  Attachment,
  SessionEntry,
  ReplyRoute,
  GatewayEventEmitter,
  GatewayEventPayload,
  GatewayEvent,
  AccessDecision,
  PairingRequest,
  RoutingRule,
  TranscriptEntry,
  HookConfig,
  AuthConfig,
  AgentConfig,
  QueueConfig,
  SessionsConfig,
  RoutingConfig,
  ChannelAccessConfig,
  DispatchOptions,
  Logger,
} from "./types.js";
