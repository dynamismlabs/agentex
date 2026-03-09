import type { GatewayConfig } from "../../src/types.js";

/**
 * Minimal valid config for tests that need a gateway but not real channels.
 */
export function minimalConfig(overrides?: Partial<GatewayConfig>): GatewayConfig {
  return {
    gateway: {
      bind: "loopback",
      port: 0, // let OS pick a free port
      auth: { mode: "none" },
    },
    agent: {
      adapter: "mock",
      cwd: "/tmp",
    },
    sessions: {
      dmScope: "per-peer",
    },
    queue: {
      mode: "queue",
      maxQueueDepth: 10,
    },
    channels: {},
    ...overrides,
  };
}

/**
 * Config with DM allowlist access control on a "test" channel.
 */
export function allowlistConfig(allowedSenders: string[]): GatewayConfig {
  return minimalConfig({
    channels: {
      test: {
        dm: {
          policy: "allowlist",
          allowFrom: allowedSenders,
        },
      },
    },
  });
}

/**
 * Config with multi-agent routing rules.
 */
export function multiAgentConfig(): GatewayConfig {
  return minimalConfig({
    agents: {
      coder: {
        adapter: "mock-coder",
        cwd: "/tmp/coder",
      },
      reviewer: {
        adapter: "mock-reviewer",
        cwd: "/tmp/reviewer",
      },
    },
    routing: {
      rules: [
        {
          match: { channel: "test", chatType: "thread" },
          agent: "reviewer",
        },
      ],
      default: "coder",
    },
  });
}

/**
 * Config with open DM policy (no access control).
 */
export function openConfig(): GatewayConfig {
  return minimalConfig({
    channels: {
      test: {
        dm: { policy: "open" },
        groups: { policy: "open" },
      },
    },
  });
}
