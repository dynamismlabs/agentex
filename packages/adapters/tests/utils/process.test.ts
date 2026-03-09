import { describe, it, expect } from "vitest";
import { runChildProcess, deriveErrorCode, type RunProcessResult } from "../../src/utils/process.js";

describe("runChildProcess", () => {
  const baseCwd = process.cwd();
  const baseEnv = { PATH: process.env["PATH"] ?? "/usr/bin" };

  it("captures stdout from echo", async () => {
    const result = await runChildProcess({
      runId: "test-echo",
      command: "echo",
      args: ["hello"],
      cwd: baseCwd,
      env: baseEnv,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("hello");
    expect(result.timedOut).toBe(false);
    expect(result.signal).toBeNull();
  });

  it("pipes stdin to cat", async () => {
    const result = await runChildProcess({
      runId: "test-cat",
      command: "cat",
      args: [],
      cwd: baseCwd,
      env: baseEnv,
      stdin: "hello from stdin",
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("hello from stdin");
  });

  it("captures non-zero exit code", async () => {
    const result = await runChildProcess({
      runId: "test-false",
      command: "false",
      args: [],
      cwd: baseCwd,
      env: baseEnv,
    });
    expect(result.exitCode).not.toBe(0);
  });

  it("times out a hanging process", async () => {
    const result = await runChildProcess({
      runId: "test-timeout",
      command: "sleep",
      args: ["60"],
      cwd: baseCwd,
      env: baseEnv,
      timeoutSec: 1,
      graceSec: 1,
    });
    expect(result.timedOut).toBe(true);
  }, 10_000);

  it("calls onOutput callback", async () => {
    const chunks: Array<{ stream: string; chunk: string }> = [];
    await runChildProcess({
      runId: "test-callback",
      command: "echo",
      args: ["callback-test"],
      cwd: baseCwd,
      env: baseEnv,
      onOutput: (stream, chunk) => {
        chunks.push({ stream, chunk });
      },
    });
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.some((c) => c.chunk.includes("callback-test"))).toBe(true);
  });

  it("catches onOutput callback errors without crashing", async () => {
    const result = await runChildProcess({
      runId: "test-error-cb",
      command: "echo",
      args: ["safe"],
      cwd: baseCwd,
      env: baseEnv,
      onOutput: () => {
        throw new Error("callback error");
      },
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("safe");
  });

  it("captures stderr", async () => {
    const result = await runChildProcess({
      runId: "test-stderr",
      command: "bash",
      args: ["-c", "echo error-msg >&2"],
      cwd: baseCwd,
      env: baseEnv,
    });
    expect(result.stderr.trim()).toBe("error-msg");
  });
});

describe("deriveErrorCode", () => {
  it('returns "timeout" when timedOut is true', () => {
    const result: RunProcessResult = {
      exitCode: null,
      signal: "SIGTERM",
      timedOut: true,
      stdout: "",
      stderr: "",
    };
    expect(deriveErrorCode(result)).toBe("timeout");
  });

  it('returns "killed" when signal present and not timedOut', () => {
    const result: RunProcessResult = {
      exitCode: null,
      signal: "SIGKILL",
      timedOut: false,
      stdout: "",
      stderr: "",
    };
    expect(deriveErrorCode(result)).toBe("killed");
  });

  it("returns null for normal exit", () => {
    const result: RunProcessResult = {
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: "",
      stderr: "",
    };
    expect(deriveErrorCode(result)).toBeNull();
  });

  it("returns null for non-zero exit without signal", () => {
    const result: RunProcessResult = {
      exitCode: 1,
      signal: null,
      timedOut: false,
      stdout: "",
      stderr: "",
    };
    expect(deriveErrorCode(result)).toBeNull();
  });
});
