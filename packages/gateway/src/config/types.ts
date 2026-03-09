/**
 * Config types — re-exported from the canonical type definitions.
 */
export type {
  GatewayConfig,
  AuthConfig,
  AgentConfig,
  SessionsConfig,
  QueueConfig,
  RoutingConfig,
  RoutingRule,
  HookConfig,
} from "../types.js";

/** Options accepted by {@link loadConfig}. */
export interface LoadConfigOptions {
  /** Path to YAML config file. */
  configPath?: string;
  /** Programmatic overrides merged after YAML + env substitution. */
  overrides?: Record<string, unknown>;
}
