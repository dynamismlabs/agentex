import { describe, it, expect } from "vitest";
import * as path from "node:path";
import { executeCodexProvider } from "../../../src/providers/codex/execute.js";
import type { ExecutionContext, StreamEvent } from "../../../src/types.js";

const MOCK_CODEX = path.resolve(import.meta.dirname, "../../fixtures/mock-codex.sh");
const CWD = process.cwd();

function makeCtx(overrides: Partial<ExecutionContext> = {}): ExecutionContext {
  return {
    runId: "test-codex-run",
    prompt: "Hello codex test",
    cwd: CWD,
    ...overrides,
  };
}

describe("executeCodexProvider", () => {
  it("handles successful execution", async () => {
    const events: StreamEvent[] = [];
    const outputs: Array<{ stream: string; chunk: string }> = [];

    const result = await executeCodexProvider(makeCtx({
      config: { command: MOCK_CODEX },
      env: { MOCK_BEHAVIOR: "success" },
      onEvent: (event) => { events.push(event); },
      onOutput: (stream, chunk) => { outputs.push({ stream, chunk }); },
    }));

    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(result.sessionParams?.["sessionId"]).toBe("codex-thread-1");
    expect(result.summary).toContain("Codex done");
    expect(result.billingType).toBe("subscription");
    expect(events.length).toBeGreaterThan(0);
    expect(outputs.length).toBeGreaterThan(0);
  });

  it("detects API billing type when OPENAI_API_KEY set", async () => {
    const result = await executeCodexProvider(makeCtx({
      config: { command: MOCK_CODEX },
      env: { MOCK_BEHAVIOR: "success", OPENAI_API_KEY: "sk-test" },
    }));

    expect(result.billingType).toBe("api");
  });

  it("handles timeout", async () => {
    const result = await executeCodexProvider(makeCtx({
      config: { command: MOCK_CODEX, timeoutSec: 1, graceSec: 1 },
      env: { MOCK_BEHAVIOR: "timeout" },
    }));

    expect(result.timedOut).toBe(true);
    expect(result.errorCode).toBe("timeout");
  }, 10_000);

  it("handles auth required", async () => {
    const result = await executeCodexProvider(makeCtx({
      config: { command: MOCK_CODEX },
      env: { MOCK_BEHAVIOR: "auth_required" },
    }));

    expect(result.errorCode).toBe("auth_required");
  });

  it("handles generic error", async () => {
    const result = await executeCodexProvider(makeCtx({
      config: { command: MOCK_CODEX },
      env: { MOCK_BEHAVIOR: "error" },
    }));

    expect(result.exitCode).not.toBe(0);
  });

  it("handles binary not found", async () => {
    const result = await executeCodexProvider(makeCtx({
      config: { command: "/nonexistent/codex-binary" },
    }));

    expect(result.errorCode).toBe("binary_not_found");
  });
});
