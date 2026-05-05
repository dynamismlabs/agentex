import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig } from "../../src/config/loader.js";

describe("loadConfig", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "agentex-config-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeYaml(filename: string, content: string): string {
    const filePath = join(tmpDir, filename);
    writeFileSync(filePath, content, "utf-8");
    return filePath;
  }

  // -----------------------------------------------------------------------
  // Basic loading
  // -----------------------------------------------------------------------

  describe("basic YAML loading", () => {
    it("loads a minimal YAML config", () => {
      const configPath = writeYaml(
        "config.yaml",
        `
agent:
  provider: claude
  cwd: /tmp/project
`,
      );

      const cfg = loadConfig({ configPath });
      expect(cfg.agent.provider).toBe("claude");
      expect(cfg.agent.cwd).toBe("/tmp/project");
    });

    it("applies schema defaults for omitted sections", () => {
      const configPath = writeYaml(
        "config.yaml",
        `
agent:
  provider: claude
  cwd: /tmp/project
`,
      );

      const cfg = loadConfig({ configPath });
      expect(cfg.gateway.bind).toBe("loopback");
      expect(cfg.gateway.port).toBe(18789);
      expect(cfg.gateway.auth.mode).toBe("token");
      expect(cfg.sessions.dmScope).toBe("main");
      expect(cfg.queue.mode).toBe("queue");
      expect(cfg.queue.maxQueueDepth).toBe(10);
      expect(cfg.channels).toEqual({});
    });

    it("loads a full YAML config", () => {
      const configPath = writeYaml(
        "config.yaml",
        `
gateway:
  bind: lan
  port: 9999
  auth:
    mode: none
agent:
  provider: codex
  cwd: /home/user/project
  model: gpt-4
  maxTurns: 5
  timeoutSec: 120
  skipPermissions: true
sessions:
  dmScope: per-peer
  resetOnIdle: "24h"
queue:
  mode: collect
  collectDebounceMs: 500
  maxQueueDepth: 20
channels:
  telegram:
    token: abc123
routing:
  rules:
    - match:
        channel: telegram
      agent: coder
  default: coder
hooks:
  onComplete:
    command: notify.sh
stateDir: /var/agentex
`,
      );

      const cfg = loadConfig({ configPath });
      expect(cfg.gateway.bind).toBe("lan");
      expect(cfg.gateway.port).toBe(9999);
      expect(cfg.gateway.auth.mode).toBe("none");
      expect(cfg.agent.provider).toBe("codex");
      expect(cfg.agent.model).toBe("gpt-4");
      expect(cfg.sessions.dmScope).toBe("per-peer");
      expect(cfg.sessions.resetOnIdle).toBe("24h");
      expect(cfg.queue.mode).toBe("collect");
      expect(cfg.queue.maxQueueDepth).toBe(20);
      expect(cfg.routing?.rules).toHaveLength(1);
      expect(cfg.hooks?.onComplete?.command).toBe("notify.sh");
      expect(cfg.stateDir).toBe("/var/agentex");
    });
  });

  // -----------------------------------------------------------------------
  // Environment variable substitution
  // -----------------------------------------------------------------------

  describe("environment variable substitution", () => {
    let savedEnv: Record<string, string | undefined>;

    beforeEach(() => {
      savedEnv = { ...process.env };
      process.env["AGENTEX_GATEWAY_TOKEN"] = "test-token-123";
      process.env["AGENTEX_PROVIDER"] = "claude";
      process.env["AGENTEX_CWD"] = "/env/project";
    });

    afterEach(() => {
      // Restore original env
      for (const key of ["AGENTEX_GATEWAY_TOKEN", "AGENTEX_PROVIDER", "AGENTEX_CWD"]) {
        if (savedEnv[key] === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = savedEnv[key];
        }
      }
    });

    it("substitutes $VAR in string values", () => {
      const configPath = writeYaml(
        "config.yaml",
        `
gateway:
  auth:
    token: $AGENTEX_GATEWAY_TOKEN
agent:
  provider: $AGENTEX_PROVIDER
  cwd: $AGENTEX_CWD
`,
      );

      const cfg = loadConfig({ configPath });
      expect(cfg.gateway.auth.token).toBe("test-token-123");
      expect(cfg.agent.provider).toBe("claude");
      expect(cfg.agent.cwd).toBe("/env/project");
    });

    it("substitutes \${VAR} in string values", () => {
      const configPath = writeYaml(
        "config.yaml",
        `
gateway:
  auth:
    token: "\${AGENTEX_GATEWAY_TOKEN}"
agent:
  provider: claude
  cwd: /tmp
`,
      );

      const cfg = loadConfig({ configPath });
      expect(cfg.gateway.auth.token).toBe("test-token-123");
    });

    it("throws on missing env var", () => {
      const configPath = writeYaml(
        "config.yaml",
        `
agent:
  provider: claude
  cwd: /tmp
gateway:
  auth:
    token: $NONEXISTENT_VAR
`,
      );

      expect(() => loadConfig({ configPath })).toThrow(/NONEXISTENT_VAR/);
    });
  });

  // -----------------------------------------------------------------------
  // Programmatic overrides
  // -----------------------------------------------------------------------

  describe("overrides", () => {
    it("merges overrides on top of YAML config", () => {
      const configPath = writeYaml(
        "config.yaml",
        `
agent:
  provider: claude
  cwd: /tmp/project
gateway:
  port: 18789
`,
      );

      const cfg = loadConfig({
        configPath,
        overrides: {
          gateway: { port: 3000 },
        },
      });
      expect(cfg.gateway.port).toBe(3000);
      // Other gateway fields should be preserved
      expect(cfg.gateway.bind).toBe("loopback");
    });

    it("deep-merges nested override objects", () => {
      const configPath = writeYaml(
        "config.yaml",
        `
agent:
  provider: claude
  cwd: /tmp/project
gateway:
  auth:
    mode: token
    token: original
`,
      );

      const cfg = loadConfig({
        configPath,
        overrides: {
          gateway: { auth: { token: "overridden" } },
        },
      });
      expect(cfg.gateway.auth.token).toBe("overridden");
      expect(cfg.gateway.auth.mode).toBe("token");
    });

    it("override replaces arrays entirely", () => {
      const configPath = writeYaml(
        "config.yaml",
        `
agent:
  provider: claude
  cwd: /tmp/project
  skillDirs:
    - /skills/a
    - /skills/b
`,
      );

      const cfg = loadConfig({
        configPath,
        overrides: {
          agent: { skillDirs: ["/skills/c"] },
        },
      });
      expect(cfg.agent.skillDirs).toEqual(["/skills/c"]);
    });

    it("works without a config file (overrides only)", () => {
      const cfg = loadConfig({
        overrides: {
          agent: { provider: "claude", cwd: "/tmp" },
        },
      });
      expect(cfg.agent.provider).toBe("claude");
      expect(cfg.gateway.bind).toBe("loopback");
    });
  });

  // -----------------------------------------------------------------------
  // Edge cases
  // -----------------------------------------------------------------------

  describe("edge cases", () => {
    it("handles an empty YAML file", () => {
      const configPath = writeYaml("config.yaml", "");

      // Empty file still needs agent (which is required), so expect error
      expect(() => loadConfig({ configPath })).toThrow();
    });

    it("handles empty YAML file with overrides providing required fields", () => {
      const configPath = writeYaml("config.yaml", "");

      const cfg = loadConfig({
        configPath,
        overrides: {
          agent: { provider: "claude", cwd: "/tmp" },
        },
      });
      expect(cfg.agent.provider).toBe("claude");
    });

    it("throws on non-mapping YAML", () => {
      const configPath = writeYaml("config.yaml", "- item1\n- item2\n");

      expect(() => loadConfig({ configPath })).toThrow(
        /Config file must be a YAML mapping/,
      );
    });

    it("throws on missing config file", () => {
      expect(() =>
        loadConfig({ configPath: join(tmpDir, "nonexistent.yaml") }),
      ).toThrow();
    });

    it("no-ops with empty overrides", () => {
      const configPath = writeYaml(
        "config.yaml",
        `
agent:
  provider: claude
  cwd: /tmp/project
`,
      );

      const cfg = loadConfig({ configPath, overrides: {} });
      expect(cfg.agent.provider).toBe("claude");
    });

    it("loads with no arguments and overrides providing required fields", () => {
      // loadConfig with just overrides, no configPath
      const cfg = loadConfig({
        overrides: {
          agent: { provider: "codex", cwd: "/home" },
          gateway: { port: 5555 },
        },
      });
      expect(cfg.agent.provider).toBe("codex");
      expect(cfg.gateway.port).toBe(5555);
    });
  });

  // -----------------------------------------------------------------------
  // Validation errors
  // -----------------------------------------------------------------------

  describe("validation errors", () => {
    it("throws on invalid YAML structure (missing required agent)", () => {
      const configPath = writeYaml(
        "config.yaml",
        `
gateway:
  port: 18789
`,
      );

      expect(() => loadConfig({ configPath })).toThrow();
    });

    it("throws on invalid enum value", () => {
      const configPath = writeYaml(
        "config.yaml",
        `
agent:
  provider: claude
  cwd: /tmp
gateway:
  auth:
    mode: oauth
`,
      );

      expect(() => loadConfig({ configPath })).toThrow();
    });
  });
});
