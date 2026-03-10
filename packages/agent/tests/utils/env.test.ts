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

  it("only includes allow-listed vars from process.env", () => {
    const env = buildEnv();
    expect(env["PATH"]).toBe("/usr/bin");
    expect(env["HOME"]).toBe("/home/test");
    expect(env["RANDOM_VAR"]).toBeUndefined();
    expect(env["ANTHROPIC_API_KEY"]).toBeUndefined();
  });

  it("includes caller-provided vars", () => {
    const env = buildEnv({ FOO: "bar" });
    expect(env["FOO"]).toBe("bar");
  });

  it("caller env overrides allow-listed vars", () => {
    const env = buildEnv({ PATH: "/custom/path" });
    expect(env["PATH"]).toBe("/custom/path");
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
