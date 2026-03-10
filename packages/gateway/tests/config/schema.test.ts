import { describe, it, expect } from "vitest";
import { ZodError } from "zod";
import { validateConfig, gatewayConfigSchema } from "../../src/config/schema.js";

/** Minimal valid raw config (only the required fields). */
function minimalRaw() {
  return {
    agent: { provider: "claude", cwd: "/tmp/project" },
  };
}

describe("gatewayConfigSchema", () => {
  // -----------------------------------------------------------------------
  // Defaults
  // -----------------------------------------------------------------------

  describe("defaults", () => {
    it("applies gateway.bind default to 'loopback'", () => {
      const cfg = validateConfig(minimalRaw());
      expect(cfg.gateway.bind).toBe("loopback");
    });

    it("applies gateway.port default to 18789", () => {
      const cfg = validateConfig(minimalRaw());
      expect(cfg.gateway.port).toBe(18789);
    });

    it("applies gateway.auth.mode default to 'token'", () => {
      const cfg = validateConfig(minimalRaw());
      expect(cfg.gateway.auth.mode).toBe("token");
    });

    it("applies sessions.dmScope default to 'main'", () => {
      const cfg = validateConfig(minimalRaw());
      expect(cfg.sessions.dmScope).toBe("main");
    });

    it("applies queue.mode default to 'queue'", () => {
      const cfg = validateConfig(minimalRaw());
      expect(cfg.queue.mode).toBe("queue");
    });

    it("applies queue.maxQueueDepth default to 10", () => {
      const cfg = validateConfig(minimalRaw());
      expect(cfg.queue.maxQueueDepth).toBe(10);
    });

    it("applies channels default to empty object", () => {
      const cfg = validateConfig(minimalRaw());
      expect(cfg.channels).toEqual({});
    });
  });

  // -----------------------------------------------------------------------
  // Valid configurations
  // -----------------------------------------------------------------------

  describe("valid configurations", () => {
    it("accepts a minimal config with only agent", () => {
      const cfg = validateConfig(minimalRaw());
      expect(cfg.agent.provider).toBe("claude");
      expect(cfg.agent.cwd).toBe("/tmp/project");
    });

    it("accepts a full config with all fields", () => {
      const raw = {
        gateway: {
          bind: "lan",
          port: 9999,
          auth: { mode: "none" as const },
        },
        agent: {
          provider: "codex",
          cwd: "/home/user/project",
          model: "gpt-4",
          maxTurns: 5,
          timeoutSec: 120,
          skipPermissions: true,
          instructionsFile: "INSTRUCTIONS.md",
          skillDirs: ["/skills"],
          mcpServers: [{ name: "fs", command: "mcp-fs", args: ["--root", "/tmp"] }],
          systemPromptTemplate: "You are a helpful assistant.",
        },
        sessions: {
          dmScope: "per-peer" as const,
          resetOnIdle: "24h",
          identityLinks: { alice: ["slack:U123", "discord:456"] },
        },
        queue: {
          mode: "collect" as const,
          collectDebounceMs: 500,
          collectMaxMessages: 5,
          maxQueueDepth: 20,
        },
        channels: {
          telegram: { token: "abc", chatId: 123 },
        },
        agents: {
          coder: { provider: "claude", cwd: "/code" },
        },
        routing: {
          rules: [
            { match: { channel: "slack", chatType: "direct" as const }, agent: "coder" },
          ],
          default: "coder",
        },
        hooks: {
          onComplete: { command: "notify.sh" },
        },
        stateDir: "/var/agentex",
      };

      const cfg = validateConfig(raw);
      expect(cfg.gateway.bind).toBe("lan");
      expect(cfg.gateway.port).toBe(9999);
      expect(cfg.gateway.auth.mode).toBe("none");
      expect(cfg.agent.model).toBe("gpt-4");
      expect(cfg.sessions.dmScope).toBe("per-peer");
      expect(cfg.queue.mode).toBe("collect");
      expect(cfg.queue.collectDebounceMs).toBe(500);
      expect(cfg.routing?.rules).toHaveLength(1);
      expect(cfg.routing?.default).toBe("coder");
      expect(cfg.hooks?.onComplete?.command).toBe("notify.sh");
      expect(cfg.stateDir).toBe("/var/agentex");
    });

    it("accepts auth mode 'password'", () => {
      const raw = {
        ...minimalRaw(),
        gateway: { auth: { mode: "password" } },
      };
      const cfg = validateConfig(raw);
      expect(cfg.gateway.auth.mode).toBe("password");
    });

    it("accepts auth mode 'token' with a token value", () => {
      const raw = {
        ...minimalRaw(),
        gateway: { auth: { mode: "token", token: "my-secret" } },
      };
      const cfg = validateConfig(raw);
      expect(cfg.gateway.auth.token).toBe("my-secret");
    });

    it("accepts custom bind string", () => {
      const raw = {
        ...minimalRaw(),
        gateway: { bind: "0.0.0.0" },
      };
      const cfg = validateConfig(raw);
      expect(cfg.gateway.bind).toBe("0.0.0.0");
    });

    it("accepts mcpServers with env vars", () => {
      const raw = {
        ...minimalRaw(),
        agent: {
          ...minimalRaw().agent,
          mcpServers: [
            { name: "db", command: "mcp-db", env: { DB_URL: "postgres://localhost" } },
          ],
        },
      };
      const cfg = validateConfig(raw);
      expect(cfg.agent.mcpServers).toHaveLength(1);
      expect(cfg.agent.mcpServers![0]!.env).toEqual({ DB_URL: "postgres://localhost" });
    });
  });

  // -----------------------------------------------------------------------
  // Invalid configurations
  // -----------------------------------------------------------------------

  describe("invalid configurations", () => {
    it("rejects missing agent", () => {
      expect(() => validateConfig({})).toThrow(ZodError);
    });

    it("rejects missing agent.provider", () => {
      expect(() => validateConfig({ agent: { cwd: "/tmp" } })).toThrow(ZodError);
    });

    it("rejects missing agent.cwd", () => {
      expect(() => validateConfig({ agent: { provider: "claude" } })).toThrow(ZodError);
    });

    it("rejects invalid auth mode", () => {
      const raw = {
        ...minimalRaw(),
        gateway: { auth: { mode: "oauth" } },
      };
      expect(() => validateConfig(raw)).toThrow(ZodError);
    });

    it("rejects invalid sessions.dmScope", () => {
      const raw = {
        ...minimalRaw(),
        sessions: { dmScope: "invalid" },
      };
      expect(() => validateConfig(raw)).toThrow(ZodError);
    });

    it("rejects invalid queue.mode", () => {
      const raw = {
        ...minimalRaw(),
        queue: { mode: "unknown" },
      };
      expect(() => validateConfig(raw)).toThrow(ZodError);
    });

    it("rejects negative maxQueueDepth", () => {
      const raw = {
        ...minimalRaw(),
        queue: { maxQueueDepth: -1 },
      };
      expect(() => validateConfig(raw)).toThrow(ZodError);
    });

    it("rejects non-integer port", () => {
      const raw = {
        ...minimalRaw(),
        gateway: { port: 3.14 },
      };
      expect(() => validateConfig(raw)).toThrow(ZodError);
    });

    it("rejects routing without rules", () => {
      const raw = {
        ...minimalRaw(),
        routing: { default: "main" },
      };
      expect(() => validateConfig(raw)).toThrow(ZodError);
    });

    it("rejects routing without default", () => {
      const raw = {
        ...minimalRaw(),
        routing: { rules: [] },
      };
      expect(() => validateConfig(raw)).toThrow(ZodError);
    });

    it("rejects invalid chatType in routing rule", () => {
      const raw = {
        ...minimalRaw(),
        routing: {
          rules: [{ match: { chatType: "whisper" }, agent: "main" }],
          default: "main",
        },
      };
      expect(() => validateConfig(raw)).toThrow(ZodError);
    });

    it("rejects non-integer maxTurns", () => {
      const raw = {
        agent: { provider: "claude", cwd: "/tmp", maxTurns: 2.5 },
      };
      expect(() => validateConfig(raw)).toThrow(ZodError);
    });

    it("rejects mcpServer missing name", () => {
      const raw = {
        agent: {
          provider: "claude",
          cwd: "/tmp",
          mcpServers: [{ command: "mcp-fs" }],
        },
      };
      expect(() => validateConfig(raw)).toThrow(ZodError);
    });

    it("rejects mcpServer missing command", () => {
      const raw = {
        agent: {
          provider: "claude",
          cwd: "/tmp",
          mcpServers: [{ name: "fs" }],
        },
      };
      expect(() => validateConfig(raw)).toThrow(ZodError);
    });
  });

  // -----------------------------------------------------------------------
  // Overrides are preserved
  // -----------------------------------------------------------------------

  describe("explicit values override defaults", () => {
    it("preserves user-supplied port", () => {
      const raw = {
        ...minimalRaw(),
        gateway: { port: 3000 },
      };
      const cfg = validateConfig(raw);
      expect(cfg.gateway.port).toBe(3000);
    });

    it("preserves user-supplied maxQueueDepth", () => {
      const raw = {
        ...minimalRaw(),
        queue: { maxQueueDepth: 50 },
      };
      const cfg = validateConfig(raw);
      expect(cfg.queue.maxQueueDepth).toBe(50);
    });
  });
});
