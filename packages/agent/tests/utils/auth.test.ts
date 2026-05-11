import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import {
  detectAuth,
  resolveAuthForProvider,
  clearAuthCache,
  hasApiKey,
  hasBedrock,
  hasSubscription,
  isLoggedIn,
  loginCommandFor,
} from "../../src/utils/auth.js";
import type { ProviderModule } from "../../src/types.js";

// ---------------------------------------------------------------------------
// detectAuth (legacy env-only billing classifier)
// ---------------------------------------------------------------------------

describe("detectAuth", () => {
  describe("claude provider", () => {
    it("returns api_key auth when ANTHROPIC_API_KEY is set", () => {
      const result = detectAuth("claude", { ANTHROPIC_API_KEY: "sk-ant-123" });
      expect(result.method).toBe("api_key");
      expect(result.billingType).toBe("api");
    });

    it("returns bedrock auth when ANTHROPIC_BEDROCK_BASE_URL is set", () => {
      const result = detectAuth("claude", {
        ANTHROPIC_BEDROCK_BASE_URL: "https://bedrock.us-east-1.amazonaws.com",
      });
      expect(result.method).toBe("bedrock");
      expect(result.billingType).toBe("metered_api");
      expect(result.resolveModelId).toBeTypeOf("function");
    });

    it("returns bedrock auth when AWS_ACCESS_KEY_ID and AWS_REGION are set", () => {
      const result = detectAuth("claude", {
        AWS_ACCESS_KEY_ID: "AKIAEXAMPLE",
        AWS_REGION: "us-west-2",
      });
      expect(result.method).toBe("bedrock");
      expect(result.region).toBe("us-west-2");
    });

    it("bedrock takes priority over api_key", () => {
      const result = detectAuth("claude", {
        ANTHROPIC_BEDROCK_BASE_URL: "https://bedrock.example.com",
        ANTHROPIC_API_KEY: "sk-ant-123",
      });
      expect(result.method).toBe("bedrock");
    });

    it("returns subscription fallback when no keys are set", () => {
      const result = detectAuth("claude", {});
      expect(result.method).toBe("subscription");
    });

    it("ignores empty-string API key", () => {
      const result = detectAuth("claude", { ANTHROPIC_API_KEY: "   " });
      expect(result.method).toBe("subscription");
    });
  });

  describe("codex provider", () => {
    it("returns api_key auth when OPENAI_API_KEY is set", () => {
      const result = detectAuth("codex", { OPENAI_API_KEY: "sk-openai-123" });
      expect(result.method).toBe("api_key");
    });

    it("returns subscription fallback when no keys are set", () => {
      const result = detectAuth("codex", {});
      expect(result.method).toBe("subscription");
    });
  });

  describe("gemini provider", () => {
    it("returns api_key auth when GEMINI_API_KEY is set", () => {
      const result = detectAuth("gemini", { GEMINI_API_KEY: "gem-123" });
      expect(result.method).toBe("api_key");
    });

    it("returns api_key auth when GOOGLE_API_KEY is set", () => {
      const result = detectAuth("gemini", { GOOGLE_API_KEY: "goog-123" });
      expect(result.method).toBe("api_key");
    });

    it("returns subscription fallback when no keys are set", () => {
      const result = detectAuth("gemini", {});
      expect(result.method).toBe("subscription");
    });
  });

  describe("unknown provider", () => {
    it("returns subscription fallback for unrecognized provider", () => {
      const result = detectAuth("unknown-provider", {});
      expect(result.method).toBe("subscription");
    });
  });
});

// ---------------------------------------------------------------------------
// resolveAuthForProvider — structured report including binary + auth paths
// ---------------------------------------------------------------------------

describe("resolveAuthForProvider", () => {
  let tmpHome: string;
  const originalEnv = { ...process.env };

  beforeEach(async () => {
    clearAuthCache();
    tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "agentex-auth-test-"));
    // Point each provider's home override at a clean empty dir so filesystem
    // fallback checks start from a known state.
    process.env.CODEX_HOME = path.join(tmpHome, "codex");
    process.env.CLAUDE_CONFIG_DIR = path.join(tmpHome, "claude");
    process.env.GEMINI_CONFIG_DIR = path.join(tmpHome, "gemini");
    delete process.env.OPENAI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.GEMINI_API_KEY;
    delete process.env.GOOGLE_API_KEY;
    delete process.env.ANTHROPIC_BEDROCK_BASE_URL;
    delete process.env.AWS_ACCESS_KEY_ID;
    delete process.env.AWS_SECRET_ACCESS_KEY;
    delete process.env.AWS_REGION;
    delete process.env.CURSOR_API_KEY;
  });

  afterEach(async () => {
    clearAuthCache();
    await fs.rm(tmpHome, { recursive: true, force: true });
    process.env = { ...originalEnv };
  });

  describe("shape", () => {
    it("returns AuthReport with binary + options + source for every provider", async () => {
      for (const p of ["codex", "claude", "gemini", "cursor", "opencode", "pi"]) {
        const report = await resolveAuthForProvider(p, { fresh: true });
        expect(report.providerType).toBe(p);
        expect(report.binary).toBeDefined();
        expect(typeof report.binary.installed).toBe("boolean");
        expect(Array.isArray(report.options)).toBe(true);
        expect(report.source).toMatch(/^(cli|filesystem)$/);
      }
    });

    it("unknown provider returns empty report", async () => {
      const report = await resolveAuthForProvider("nope", { fresh: true });
      expect(report.binary.installed).toBe(false);
      expect(report.options).toEqual([]);
    });
  });

  describe("codex", () => {
    it("reports api_key absent when OPENAI_API_KEY is unset", async () => {
      const report = await resolveAuthForProvider("codex", { fresh: true });
      const apiKey = report.options.find((o) => o.method === "api_key")!;
      expect(apiKey.present).toBe(false);
      expect(apiKey.source).toEqual({ kind: "env", var: "OPENAI_API_KEY" });
    });

    it("detects api_key presence from caller env", async () => {
      const report = await resolveAuthForProvider("codex", {
        env: { OPENAI_API_KEY: "sk-test" },
        fresh: true,
      });
      const apiKey = report.options.find((o) => o.method === "api_key")!;
      expect(apiKey.present).toBe(true);
    });

    it("falls back to filesystem when binary is missing", async () => {
      // Force binary-missing by pointing command at a nonexistent path. This
      // triggers the filesystem fallback path regardless of the local codex
      // install state.
      const report = await resolveAuthForProvider("codex", {
        command: "/definitely/does/not/exist/codex",
        fresh: true,
      });
      expect(report.binary.installed).toBe(false);
      expect(report.source).toBe("filesystem");
      const sub = report.options.find((o) => o.method === "subscription")!;
      expect(sub.present).toBe(false);
    });

    it("detects subscription via filesystem fallback when auth.json exists", async () => {
      const codexHome = process.env.CODEX_HOME!;
      await fs.mkdir(codexHome, { recursive: true });
      await fs.writeFile(path.join(codexHome, "auth.json"), "{}");
      const report = await resolveAuthForProvider("codex", {
        command: "/definitely/does/not/exist/codex",
        fresh: true,
      });
      const sub = report.options.find((o) => o.method === "subscription")!;
      expect(sub.present).toBe(true);
    });
  });

  describe("claude", () => {
    it("reports bedrock present when AWS creds + region are set", async () => {
      const report = await resolveAuthForProvider("claude", {
        env: { AWS_ACCESS_KEY_ID: "AKIA", AWS_REGION: "us-west-2" },
        fresh: true,
      });
      const bedrock = report.options.find((o) => o.method === "bedrock")!;
      expect(bedrock.present).toBe(true);
    });

    it("reports bedrock present when ANTHROPIC_BEDROCK_BASE_URL is set", async () => {
      const report = await resolveAuthForProvider("claude", {
        env: { ANTHROPIC_BEDROCK_BASE_URL: "https://bedrock.example.com" },
        fresh: true,
      });
      const bedrock = report.options.find((o) => o.method === "bedrock")!;
      expect(bedrock.present).toBe(true);
    });

    it("detects api_key presence independent of bedrock", async () => {
      const report = await resolveAuthForProvider("claude", {
        env: { ANTHROPIC_API_KEY: "sk-ant" },
        fresh: true,
      });
      const apiKey = report.options.find((o) => o.method === "api_key")!;
      expect(apiKey.present).toBe(true);
    });

    it("always includes api_key, bedrock, subscription options", async () => {
      const report = await resolveAuthForProvider("claude", { fresh: true });
      expect(report.options.map((o) => o.method).sort()).toEqual([
        "api_key",
        "bedrock",
        "subscription",
      ]);
    });
  });

  describe("gemini", () => {
    it("reports both GEMINI_API_KEY and GOOGLE_API_KEY as separate options", async () => {
      const report = await resolveAuthForProvider("gemini", { fresh: true });
      const apiKeys = report.options.filter((o) => o.method === "api_key");
      expect(apiKeys).toHaveLength(2);
      expect(apiKeys.map((k) => (k.source.kind === "env" ? k.source.var : ""))).toEqual([
        "GEMINI_API_KEY",
        "GOOGLE_API_KEY",
      ]);
    });

    it("detects subscription when oauth_creds.json exists", async () => {
      const geminiHome = process.env.GEMINI_CONFIG_DIR!;
      await fs.mkdir(geminiHome, { recursive: true });
      await fs.writeFile(path.join(geminiHome, "oauth_creds.json"), "{}");
      const report = await resolveAuthForProvider("gemini", { fresh: true });
      const sub = report.options.find((o) => o.method === "subscription")!;
      expect(sub.present).toBe(true);
    });
  });

  describe("caching", () => {
    it("caches results by default", async () => {
      const report1 = await resolveAuthForProvider("cursor");
      const report2 = await resolveAuthForProvider("cursor");
      // Same object reference indicates cache hit.
      expect(report2).toBe(report1);
    });

    it("bypasses cache when fresh: true", async () => {
      const report1 = await resolveAuthForProvider("cursor");
      const report2 = await resolveAuthForProvider("cursor", { fresh: true });
      expect(report2).not.toBe(report1);
    });

    it("clearAuthCache forces a fresh resolve", async () => {
      const report1 = await resolveAuthForProvider("cursor");
      clearAuthCache();
      const report2 = await resolveAuthForProvider("cursor");
      expect(report2).not.toBe(report1);
    });
  });
});

// ---------------------------------------------------------------------------
// Sugar helpers — method-specific presence checks
// ---------------------------------------------------------------------------

function fakeProvider(
  options: { method: "api_key" | "bedrock" | "subscription"; present: boolean }[],
): ProviderModule {
  return {
    type: "fake",
    capabilities: {
      sessions: false,
      modelDiscovery: false,
      quotaProbing: false,
      mcp: false,
      skills: false,
      instructions: false,
      workspace: false,
    },
    execute: vi.fn() as unknown as ProviderModule["execute"],
    resolveAuth: async () => ({
      providerType: "fake",
      binary: { installed: true },
      options: options.map((o) => ({
        method: o.method,
        source: { kind: "env", var: "X" },
        present: o.present,
      })),
      source: "filesystem",
    }),
  };
}

describe("sugar helpers", () => {
  it("hasSubscription returns true only when subscription is confirmed present", async () => {
    expect(await hasSubscription(fakeProvider([{ method: "subscription", present: true }]))).toBe(true);
    expect(await hasSubscription(fakeProvider([{ method: "subscription", present: false }]))).toBe(false);
  });

  it("hasApiKey returns true only when api_key is confirmed present", async () => {
    expect(await hasApiKey(fakeProvider([{ method: "api_key", present: true }]))).toBe(true);
    expect(await hasApiKey(fakeProvider([{ method: "api_key", present: false }]))).toBe(false);
    // Subscription-present does NOT satisfy hasApiKey.
    expect(await hasApiKey(fakeProvider([{ method: "subscription", present: true }]))).toBe(false);
  });

  it("hasBedrock returns true only when bedrock is confirmed present", async () => {
    expect(await hasBedrock(fakeProvider([{ method: "bedrock", present: true }]))).toBe(true);
    expect(await hasBedrock(fakeProvider([{ method: "bedrock", present: false }]))).toBe(false);
  });
});

describe("loginCommandFor", () => {
  it.each([
    ["claude", "claude auth login"],
    ["codex", "codex login"],
    ["gemini", "gemini"],
    ["cursor", "cursor-agent login"],
    ["opencode", "opencode auth login"],
  ])("returns %s → %s", (providerType, expected) => {
    expect(loginCommandFor(providerType)).toBe(expected);
  });

  it("falls back to '<providerType> login' for unknown providers", () => {
    expect(loginCommandFor("future-provider")).toBe("future-provider login");
  });
});

describe("isLoggedIn", () => {
  it("returns true when any auth option is present", async () => {
    // Set ANTHROPIC_API_KEY in the caller env so resolveClaudeAuth flags
    // api_key as present without any filesystem touches.
    clearAuthCache();
    const result = await isLoggedIn("claude", {
      env: { ANTHROPIC_API_KEY: "sk-test-fake-not-real" },
      fresh: true,
    });
    expect(result).toBe(true);
  });

  it("returns false for unknown provider with no auth resolver", async () => {
    clearAuthCache();
    expect(await isLoggedIn("nonexistent-provider", { fresh: true })).toBe(false);
  });
});
