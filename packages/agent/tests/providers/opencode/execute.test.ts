import { describe, it, expect } from "vitest";
import * as path from "node:path";
import { executeOpenCodeProvider } from "../../../src/providers/opencode/execute.js";
import type { ExecutionContext, StreamEvent } from "../../../src/types.js";

const MOCK_OPENCODE = path.resolve(import.meta.dirname, "../../fixtures/mock-opencode.sh");
const CWD = process.cwd();

function makeCtx(overrides: Partial<ExecutionContext> = {}): ExecutionContext {
  return {
    runId: "test-opencode-run",
    prompt: "Hello opencode test",
    cwd: CWD,
    ...overrides,
  };
}

describe("executeOpenCodeProvider", () => {
  it("handles successful execution", async () => {
    const events: StreamEvent[] = [];
    const outputs: Array<{ stream: string; chunk: string }> = [];

    const result = await executeOpenCodeProvider(makeCtx({
      config: { command: MOCK_OPENCODE },
      env: { MOCK_BEHAVIOR: "success" },
      onEvent: (event) => { events.push(event); },
      onOutput: (stream, chunk) => { outputs.push({ stream, chunk }); },
    }));

    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(result.sessionParams).toBeDefined();
    expect(result.sessionParams?.["sessionId"]).toBe("mock-oc-sess-1");
    expect(result.summary).toContain("Processed");
    expect(result.errorCode).toBeNull();
    expect(result.billingType).toBe("api");
    expect(events.length).toBeGreaterThan(0);
    expect(outputs.length).toBeGreaterThan(0);
  });

  it("handles timeout", async () => {
    const result = await executeOpenCodeProvider(makeCtx({
      config: { command: MOCK_OPENCODE, timeoutSec: 1, graceSec: 1 },
      env: { MOCK_BEHAVIOR: "timeout" },
    }));

    expect(result.timedOut).toBe(true);
    expect(result.errorCode).toBe("timeout");
  }, 10_000);

  it("handles auth required", async () => {
    const result = await executeOpenCodeProvider(makeCtx({
      config: { command: MOCK_OPENCODE },
      env: { MOCK_BEHAVIOR: "auth_required" },
    }));

    expect(result.errorCode).toBe("auth_required");
  });

  it("handles generic error", async () => {
    const result = await executeOpenCodeProvider(makeCtx({
      config: { command: MOCK_OPENCODE },
      env: { MOCK_BEHAVIOR: "error" },
    }));

    expect(result.exitCode).not.toBe(0);
  });

  it("handles binary not found", async () => {
    const result = await executeOpenCodeProvider(makeCtx({
      config: { command: "/nonexistent/opencode-binary" },
    }));

    expect(result.errorCode).toBe("binary_not_found");
  });
});
