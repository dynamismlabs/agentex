import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import {
  detectAuth,
  resolveAuthForProvider,
  hasApiKey,
  hasBedrock,
  hasSubscription,
} from "../../src/utils/auth.js";
import type { ProviderModule } from "../../src/types.js";

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
      expect(result.billingType).toBe("metered_api");
      expect(result.region).toBe("us-west-2");
      expect(result.resolveModelId).toBeTypeOf("function");
    });

    it("resolveModelId maps known models to bedrock IDs", () => {
      const result = detectAuth("claude", {
        ANTHROPIC_BEDROCK_BASE_URL: "https://bedrock.us-east-1.amazonaws.com",
        AWS_REGION: "us",
      });
      const mapped = result.resolveModelId!("claude-sonnet-4-6");
      expect(mapped).toBe("us.anthropic.claude-sonnet-4-6-v1");
    });

    it("resolveModelId passes through unknown models", () => {
      const result = detectAuth("claude", {
        ANTHROPIC_BEDROCK_BASE_URL: "https://bedrock.us-east-1.amazonaws.com",
      });
      const mapped = result.resolveModelId!("custom-model");
      expect(mapped).toBe("custom-model");
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
      expect(result.billingType).toBe("subscription");
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
      expect(result.billingType).toBe("api");
    });

    it("returns subscription fallback when no keys are set", () => {
      const result = detectAuth("codex", {});
      expect(result.method).toBe("subscription");
      expect(result.billingType).toBe("subscription");
    });
  });

  describe("gemini provider", () => {
    it("returns api_key auth when GEMINI_API_KEY is set", () => {
      const result = detectAuth("gemini", { GEMINI_API_KEY: "gem-123" });
      expect(result.method).toBe("api_key");
      expect(result.billingType).toBe("api");
    });

    it("returns api_key auth when GOOGLE_API_KEY is set", () => {
      const result = detectAuth("gemini", { GOOGLE_API_KEY: "goog-123" });
      expect(result.method).toBe("api_key");
      expect(result.billingType).toBe("api");
    });

    it("returns subscription fallback when no keys are set", () => {
      const result = detectAuth("gemini", {});
      expect(result.method).toBe("subscription");
      expect(result.billingType).toBe("subscription");
    });
  });

  describe("unknown provider", () => {
    it("returns subscription fallback for unrecognized provider", () => {
      const result = detectAuth("unknown-provider", {});
      expect(result.method).toBe("subscription");
      expect(result.billingType).toBe("subscription");
    });
  });
});

// ---------------------------------------------------------------------------
// resolveAuthForProvider — structured report of every auth path
// ---------------------------------------------------------------------------

describe("resolveAuthForProvider", () => {
  let tmpHome: string;
  const originalEnv = { ...process.env };

  beforeEach(async () => {
    tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "agex-auth-test-"));
    // Point each provider's home env override at a clean empty dir.
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
    await fs.rm(tmpHome, { recursive: true, force: true });
    process.env = { ...originalEnv };
  });

  describe("codex", () => {
    it("reports api_key absent and subscription absent when nothing is set", async () => {
      const report = await resolveAuthForProvider("codex");
      expect(report.providerType).toBe("codex");
      const apiKey = report.options.find((o) => o.method === "api_key")!;
      const sub = report.options.find((o) => o.method === "subscription")!;
      expect(apiKey.present).toBe(false);
      expect(sub.present).toBe(false);
      expect(apiKey.source).toEqual({ kind: "env", var: "OPENAI_API_KEY" });
      expect(sub.source.kind).toBe("file");
    });

    it("detects api_key presence from caller env", async () => {
      const report = await resolveAuthForProvider("codex", {
        env: { OPENAI_API_KEY: "sk-test" },
      });
      const apiKey = report.options.find((o) => o.method === "api_key")!;
      expect(apiKey.present).toBe(true);
    });

    it("detects subscription when auth.json exists in CODEX_HOME", async () => {
      const codexHome = process.env.CODEX_HOME!;
      await fs.mkdir(codexHome, { recursive: true });
      await fs.writeFile(path.join(codexHome, "auth.json"), "{}");
      const report = await resolveAuthForProvider("codex");
      const sub = report.options.find((o) => o.method === "subscription")!;
      expect(sub.present).toBe(true);
    });
  });

  describe("claude", () => {
    it("reports bedrock present when AWS creds + region are set", async () => {
      const report = await resolveAuthForProvider("claude", {
        env: { AWS_ACCESS_KEY_ID: "AKIA", AWS_REGION: "us-west-2" },
      });
      const bedrock = report.options.find((o) => o.method === "bedrock")!;
      expect(bedrock.present).toBe(true);
    });

    it("reports bedrock present when ANTHROPIC_BEDROCK_BASE_URL is set", async () => {
      const report = await resolveAuthForProvider("claude", {
        env: { ANTHROPIC_BEDROCK_BASE_URL: "https://bedrock.example.com" },
      });
      const bedrock = report.options.find((o) => o.method === "bedrock")!;
      expect(bedrock.present).toBe(true);
    });

    it("subscription option uses keychain on darwin and file elsewhere", async () => {
      const report = await resolveAuthForProvider("claude");
      const sub = report.options.find((o) => o.method === "subscription")!;
      if (process.platform === "darwin") {
        expect(sub.source.kind).toBe("keychain");
        expect(sub.present).toBe("unknown");
      } else {
        expect(sub.source.kind).toBe("file");
        expect(sub.present).toBe(false);
      }
    });

    it("detects api key presence independent of bedrock", async () => {
      const report = await resolveAuthForProvider("claude", {
        env: { ANTHROPIC_API_KEY: "sk-ant" },
      });
      const apiKey = report.options.find((o) => o.method === "api_key")!;
      expect(apiKey.present).toBe(true);
    });
  });

  describe("gemini", () => {
    it("reports both GEMINI_API_KEY and GOOGLE_API_KEY as separate options", async () => {
      const report = await resolveAuthForProvider("gemini");
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
      const report = await resolveAuthForProvider("gemini");
      const sub = report.options.find((o) => o.method === "subscription")!;
      expect(sub.present).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// Sugar helpers — method-specific presence checks
// ---------------------------------------------------------------------------

function fakeProvider(options: { method: "api_key" | "bedrock" | "subscription"; present: boolean | "unknown" }[]): ProviderModule {
  return {
    type: "fake",
    capabilities: { sessions: false, modelDiscovery: false, quotaProbing: false, mcp: false, skills: false, instructions: false, workspace: false },
    execute: vi.fn() as unknown as ProviderModule["execute"],
    testEnvironment: vi.fn() as unknown as ProviderModule["testEnvironment"],
    resolveAuth: async () => ({
      providerType: "fake",
      options: options.map((o) => ({
        method: o.method,
        source: { kind: "env", var: "X" },
        present: o.present,
      })),
    }),
  };
}

describe("sugar helpers", () => {
  it("hasSubscription returns true only when subscription is confirmed present", async () => {
    expect(await hasSubscription(fakeProvider([{ method: "subscription", present: true }]))).toBe(true);
    expect(await hasSubscription(fakeProvider([{ method: "subscription", present: false }]))).toBe(false);
    // "unknown" (e.g. macOS keychain) is NOT treated as present.
    expect(await hasSubscription(fakeProvider([{ method: "subscription", present: "unknown" }]))).toBe(false);
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
