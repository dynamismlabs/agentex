import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { buildEnv, redactEnvForLogs, ensurePathInEnv } from "../../src/utils/env.js";

describe("buildEnv", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = {
      PATH: "/usr/bin",
      HOME: "/home/test",
      ANTHROPIC_API_KEY: "sk-secret",
      RANDOM_VAR: "should-not-appear",
    };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("includes base and auth allow-listed vars from process.env", () => {
    const env = buildEnv();
    expect(env["PATH"]).toBe("/usr/bin");
    expect(env["HOME"]).toBe("/home/test");
    expect(env["ANTHROPIC_API_KEY"]).toBe("sk-secret");
    expect(env["RANDOM_VAR"]).toBeUndefined();
  });

  it("includes caller-provided vars", () => {
    const env = buildEnv({ FOO: "bar" });
    expect(env["FOO"]).toBe("bar");
  });

  it("caller env overrides allow-listed vars", () => {
    const env = buildEnv({ PATH: "/custom/path" });
    expect(env["PATH"]).toBe("/custom/path");
  });

  it("passes through all provider auth env vars", () => {
    process.env = {
      ANTHROPIC_API_KEY: "sk-ant",
      ANTHROPIC_BEDROCK_BASE_URL: "https://bedrock.example.com",
      AWS_ACCESS_KEY_ID: "AKIA",
      AWS_SECRET_ACCESS_KEY: "secret",
      AWS_SESSION_TOKEN: "token",
      AWS_REGION: "us-east-1",
      AWS_PROFILE: "prod",
      OPENAI_API_KEY: "sk-openai",
      GEMINI_API_KEY: "gem",
      GOOGLE_API_KEY: "goog",
      CURSOR_API_KEY: "cur",
      RANDOM_VAR: "nope",
    };
    const env = buildEnv();
    expect(env["ANTHROPIC_API_KEY"]).toBe("sk-ant");
    expect(env["ANTHROPIC_BEDROCK_BASE_URL"]).toBe("https://bedrock.example.com");
    expect(env["AWS_ACCESS_KEY_ID"]).toBe("AKIA");
    expect(env["AWS_SECRET_ACCESS_KEY"]).toBe("secret");
    expect(env["AWS_SESSION_TOKEN"]).toBe("token");
    expect(env["AWS_REGION"]).toBe("us-east-1");
    expect(env["AWS_PROFILE"]).toBe("prod");
    expect(env["OPENAI_API_KEY"]).toBe("sk-openai");
    expect(env["GEMINI_API_KEY"]).toBe("gem");
    expect(env["GOOGLE_API_KEY"]).toBe("goog");
    expect(env["CURSOR_API_KEY"]).toBe("cur");
    expect(env["RANDOM_VAR"]).toBeUndefined();
  });

  it("caller env overrides auth vars from process.env", () => {
    process.env = { ANTHROPIC_API_KEY: "from-shell" };
    const env = buildEnv({ ANTHROPIC_API_KEY: "from-caller" });
    expect(env["ANTHROPIC_API_KEY"]).toBe("from-caller");
  });

  it("returns empty for missing allow-listed vars", () => {
    process.env = {};
    const env = buildEnv();
    expect(env["PATH"]).toBeUndefined();
  });
});

describe("redactEnvForLogs", () => {
  it("redacts keys containing KEY", () => {
    const result = redactEnvForLogs({ ANTHROPIC_API_KEY: "sk-xxx" });
    expect(result["ANTHROPIC_API_KEY"]).toBe("[REDACTED]");
  });

  it("redacts keys containing SECRET", () => {
    const result = redactEnvForLogs({ MY_SECRET: "hidden" });
    expect(result["MY_SECRET"]).toBe("[REDACTED]");
  });

  it("redacts keys containing TOKEN", () => {
    const result = redactEnvForLogs({ ACCESS_TOKEN: "abc" });
    expect(result["ACCESS_TOKEN"]).toBe("[REDACTED]");
  });

  it("redacts keys containing PASSWORD", () => {
    const result = redactEnvForLogs({ DB_PASSWORD: "pass123" });
    expect(result["DB_PASSWORD"]).toBe("[REDACTED]");
  });

  it("redacts keys containing CREDENTIAL", () => {
    const result = redactEnvForLogs({ GCP_CREDENTIAL: "cred" });
    expect(result["GCP_CREDENTIAL"]).toBe("[REDACTED]");
  });

  it("redacts keys containing AUTH", () => {
    const result = redactEnvForLogs({ GITHUB_AUTH: "ghp_xxx" });
    expect(result["GITHUB_AUTH"]).toBe("[REDACTED]");
  });

  it("redacts custom-endpoint header carriers (values can hold secret headers)", () => {
    const result = redactEnvForLogs({
      ANTHROPIC_CUSTOM_HEADERS: "Authorization: Bearer secret",
      CODEX_CUSTOM_HEADER_0: "Bearer secret",
    });
    expect(result["ANTHROPIC_CUSTOM_HEADERS"]).toBe("[REDACTED]");
    expect(result["CODEX_CUSTOM_HEADER_0"]).toBe("[REDACTED]");
  });

  it("does not redact non-sensitive keys", () => {
    const result = redactEnvForLogs({ PATH: "/usr/bin", HOME: "/home/test" });
    expect(result["PATH"]).toBe("/usr/bin");
    expect(result["HOME"]).toBe("/home/test");
  });

  it("returns a copy, not the original", () => {
    const original = { PATH: "/usr/bin" };
    const result = redactEnvForLogs(original);
    expect(result).not.toBe(original);
  });
});

describe("ensurePathInEnv", () => {
  it("adds missing essential paths on Unix", () => {
    const env: Record<string, string> = { PATH: "/home/test/bin" };
    ensurePathInEnv(env);
    expect(env["PATH"]).toContain("/usr/local/bin");
    expect(env["PATH"]).toContain("/usr/bin");
    expect(env["PATH"]).toContain("/bin");
  });

  it("does not duplicate existing paths", () => {
    const env: Record<string, string> = { PATH: "/usr/local/bin:/usr/bin:/bin" };
    ensurePathInEnv(env);
    const parts = env["PATH"]!.split(":");
    const localBinCount = parts.filter((p) => p === "/usr/local/bin").length;
    expect(localBinCount).toBe(1);
  });

  it("handles empty PATH", () => {
    const env: Record<string, string> = {};
    ensurePathInEnv(env);
    expect(env["PATH"]).toContain("/usr/local/bin");
  });
});
