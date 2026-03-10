import { z } from "zod";
import type { GatewayConfig } from "../types.js";

// ---------------------------------------------------------------------------
// Leaf schemas
// ---------------------------------------------------------------------------

const authConfigSchema = z.object({
  mode: z.enum(["token", "password", "none"]).default("token"),
  token: z.string().optional(),
});

const mcpServerConfigSchema = z.object({
  name: z.string(),
  command: z.string(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string()).optional(),
});

const agentConfigSchema = z.object({
  provider: z.string(),
  cwd: z.string(),
  model: z.string().optional(),
  maxTurns: z.number().int().positive().optional(),
  timeoutSec: z.number().positive().optional(),
  skipPermissions: z.boolean().optional(),
  instructionsFile: z.string().optional(),
  skillDirs: z.array(z.string()).optional(),
  mcpServers: z.array(mcpServerConfigSchema).optional(),
  systemPromptTemplate: z.string().optional(),
});

const sessionsConfigSchema = z.object({
  dmScope: z.enum(["main", "per-peer", "per-channel-peer"]).default("main"),
  resetOnIdle: z.string().optional(),
  identityLinks: z.record(z.array(z.string())).optional(),
});

const queueConfigSchema = z.object({
  mode: z.enum(["queue", "collect", "steer", "interrupt"]).default("queue"),
  collectDebounceMs: z.number().int().nonnegative().optional(),
  collectMaxMessages: z.number().int().positive().optional(),
  maxQueueDepth: z.number().int().positive().default(10),
});

const routingRuleSchema = z.object({
  match: z.object({
    channel: z.string().optional(),
    target: z.string().optional(),
    chatType: z.enum(["direct", "group", "channel", "thread"]).optional(),
  }),
  agent: z.string(),
});

const routingConfigSchema = z.object({
  rules: z.array(routingRuleSchema),
  default: z.string(),
});

const hookConfigSchema = z.object({
  command: z.string(),
});

// ---------------------------------------------------------------------------
// Top-level gateway config schema
// ---------------------------------------------------------------------------

export const gatewayConfigSchema = z.object({
  gateway: z
    .object({
      bind: z.string().default("loopback"),
      port: z.number().int().positive().default(18789),
      auth: authConfigSchema.default({}),
    })
    .default({}),

  agent: agentConfigSchema,

  sessions: sessionsConfigSchema.default({}),

  queue: queueConfigSchema.default({}),

  channels: z.record(z.record(z.unknown())).default({}),

  agents: z.record(agentConfigSchema).optional(),

  routing: routingConfigSchema.optional(),

  hooks: z.record(hookConfigSchema).optional(),

  stateDir: z.string().optional(),
});

// ---------------------------------------------------------------------------
// Validation helper
// ---------------------------------------------------------------------------

/**
 * Validate a raw (unknown) value against the gateway config schema.
 * Returns a fully-typed {@link GatewayConfig} with defaults applied.
 * Throws a `ZodError` if validation fails.
 */
export function validateConfig(raw: unknown): GatewayConfig {
  return gatewayConfigSchema.parse(raw) as GatewayConfig;
}
