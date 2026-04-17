import { describe, it, expect } from "vitest";
import { executeProcessProvider } from "../../../src/providers/process/execute.js";
import type { ExecutionContext } from "../../../src/types.js";

const CWD = process.cwd();

function makeCtx(overrides: Partial<ExecutionContext> = {}): ExecutionContext {
  return {
    runId: "test-process-run",
    prompt: "hello",
    cwd: CWD,
    ...overrides,
  };
}

describe("executeProcessProvider", () => {
  it("executes echo and captures output", async () => {
    const result = await executeProcessProvider(makeCtx({
      config: { command: "echo", extraArgs: ["hello world"] },
    }));

    expect(result.exitCode).toBe(0);
    expect(result.summary).toBe("hello world");
    expect(result.sessionParams).toBeNull();
    expect(result.billingType).toBeNull();
  });

  it("captures non-zero exit code", async () => {
    const result = await executeProcessProvider(makeCtx({
      config: { command: "false" },
    }));

    expect(result.exitCode).not.toBe(0);
    expect(result.errorMessage).toBeTruthy();
  });

  it("handles timeout", async () => {
    const result = await executeProcessProvider(makeCtx({
      config: { command: "sleep", extraArgs: ["60"], timeoutSec: 1, graceSec: 1 },
    }));

    expect(result.status).toBe("timeout");
    expect(result.errorCode).toBe("timeout");
  }, 10_000);

  it("calls onOutput callback", async () => {
    const outputs: Array<{ stream: string; chunk: string }> = [];
    await executeProcessProvider(makeCtx({
      config: { command: "echo", extraArgs: ["callback test"] },
      onOutput: (stream, chunk) => { outputs.push({ stream, chunk }); },
    }));

    expect(outputs.length).toBeGreaterThan(0);
    expect(outputs.some((o) => o.chunk.includes("callback test"))).toBe(true);
  });

  it("returns binary_not_found when command missing", async () => {
    const result = await executeProcessProvider(makeCtx({
      config: { command: "/nonexistent/binary" },
    }));

    expect(result.errorCode).toBe("binary_not_found");
  });

  it("returns error when no command configured", async () => {
    const result = await executeProcessProvider(makeCtx({
      config: {},
    }));

    expect(result.errorCode).toBe("binary_not_found");
    expect(result.errorMessage).toContain("requires config.command");
  });

  it("sessionParams is always null", async () => {
    const result = await executeProcessProvider(makeCtx({
      config: { command: "echo", extraArgs: ["test"] },
      sessionParams: { sessionId: "should-be-ignored" },
    }));

    expect(result.sessionParams).toBeNull();
  });
});
