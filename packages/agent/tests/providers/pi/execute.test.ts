import { describe, it, expect } from "vitest";
import * as path from "node:path";
import { executePiProvider } from "../../../src/providers/pi/execute.js";
import type { ExecutionContext, StreamEvent } from "../../../src/types.js";

const MOCK_PI = path.resolve(import.meta.dirname, "../../fixtures/mock-pi.sh");
const CWD = process.cwd();

function makeCtx(overrides: Partial<ExecutionContext> = {}): ExecutionContext {
  return {
    runId: "test-pi-run",
    prompt: "Hello pi test",
    cwd: CWD,
    ...overrides,
  };
}

describe("executePiProvider", () => {
  it("handles successful execution", async () => {
    const events: StreamEvent[] = [];
    const outputs: Array<{ stream: string; chunk: string }> = [];

    const result = await executePiProvider(makeCtx({
      config: { command: MOCK_PI },
      env: { MOCK_BEHAVIOR: "success" },
      onEvent: (event) => { events.push(event); },
      onOutput: (stream, chunk) => { outputs.push({ stream, chunk }); },
    }));

    expect(result.exitCode).toBe(0);
    expect(result.status).toBe("completed");
    expect(result.sessionParams).toBeDefined();
    expect(result.summary).toContain("Done");
    expect(result.errorCode).toBeNull();
    expect(result.billingType).toBe("api");
    expect(events.length).toBeGreaterThan(0);
    expect(outputs.length).toBeGreaterThan(0);
  });

  it("handles timeout", async () => {
    const result = await executePiProvider(makeCtx({
      config: { command: MOCK_PI, timeoutSec: 1, graceSec: 1 },
      env: { MOCK_BEHAVIOR: "timeout" },
    }));

    expect(result.status).toBe("timeout");
    expect(result.errorCode).toBe("timeout");
  }, 10_000);

  it("handles generic error", async () => {
    const result = await executePiProvider(makeCtx({
      config: { command: MOCK_PI },
      env: { MOCK_BEHAVIOR: "error" },
    }));

    expect(result.exitCode).not.toBe(0);
  });

  it("handles binary not found", async () => {
    const result = await executePiProvider(makeCtx({
      config: { command: "/nonexistent/pi-binary" },
    }));

    expect(result.errorCode).toBe("binary_not_found");
  });
});
