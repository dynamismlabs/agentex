import { describe, it, expect } from "vitest";
import * as path from "node:path";
import { executeCursorProvider } from "../../../src/providers/cursor/execute.js";
import type { ExecutionContext, StreamEvent } from "../../../src/types.js";

const MOCK_CURSOR = path.resolve(import.meta.dirname, "../../fixtures/mock-cursor.sh");
const CWD = process.cwd();

function makeCtx(overrides: Partial<ExecutionContext> = {}): ExecutionContext {
  return {
    runId: "test-cursor-run",
    prompt: "Hello cursor test",
    cwd: CWD,
    ...overrides,
  };
}

describe("executeCursorProvider", () => {
  it("handles successful execution", async () => {
    const events: StreamEvent[] = [];
    const outputs: Array<{ stream: string; chunk: string }> = [];

    const result = await executeCursorProvider(makeCtx({
      config: { command: MOCK_CURSOR },
      env: { MOCK_BEHAVIOR: "success" },
      onEvent: (event) => { events.push(event); },
      onOutput: (stream, chunk) => { outputs.push({ stream, chunk }); },
    }));

    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(result.sessionParams).toBeDefined();
    expect(result.sessionParams?.["sessionId"]).toBe("mock-cursor-sess-1");
    expect(result.summary).toContain("Processed");
    expect(result.errorCode).toBeNull();
    expect(events.length).toBeGreaterThan(0);
    expect(outputs.length).toBeGreaterThan(0);
  });

  it("detects API billing type when CURSOR_API_KEY set", async () => {
    const result = await executeCursorProvider(makeCtx({
      config: { command: MOCK_CURSOR },
      env: {
        MOCK_BEHAVIOR: "success",
        CURSOR_API_KEY: "test-key",
      },
    }));

    expect(result.billingType).toBe("api");
  });

  it("defaults to subscription billing", async () => {
    const result = await executeCursorProvider(makeCtx({
      config: { command: MOCK_CURSOR },
      env: { MOCK_BEHAVIOR: "success" },
    }));

    expect(result.billingType).toBe("subscription");
  });

  it("handles timeout", async () => {
    const result = await executeCursorProvider(makeCtx({
      config: { command: MOCK_CURSOR, timeoutSec: 1, graceSec: 1 },
      env: { MOCK_BEHAVIOR: "timeout" },
    }));

    expect(result.timedOut).toBe(true);
    expect(result.errorCode).toBe("timeout");
  }, 10_000);

  it("handles auth required", async () => {
    const result = await executeCursorProvider(makeCtx({
      config: { command: MOCK_CURSOR },
      env: { MOCK_BEHAVIOR: "auth_required" },
    }));

    expect(result.errorCode).toBe("auth_required");
  });

  it("handles generic error", async () => {
    const result = await executeCursorProvider(makeCtx({
      config: { command: MOCK_CURSOR },
      env: { MOCK_BEHAVIOR: "error" },
    }));

    expect(result.exitCode).not.toBe(0);
  });

  it("handles binary not found", async () => {
    const result = await executeCursorProvider(makeCtx({
      config: { command: "/nonexistent/agent-binary" },
    }));

    expect(result.errorCode).toBe("binary_not_found");
  });
});
