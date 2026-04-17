import { describe, it, expect } from "vitest";
import * as path from "node:path";
import { executeClaudeProvider } from "../../../src/providers/claude/execute.js";
import type { ExecutionContext, StreamEvent } from "../../../src/types.js";

const MOCK_AGENT = path.resolve(import.meta.dirname, "../../fixtures/mock-claude.sh");
const CWD = process.cwd();

function makeCtx(overrides: Partial<ExecutionContext> = {}): ExecutionContext {
  return {
    runId: "test-run",
    prompt: "Hello test",
    cwd: CWD,
    ...overrides,
  };
}

describe("executeClaudeProvider", () => {
  it("handles successful execution", async () => {
    const events: StreamEvent[] = [];
    const outputs: Array<{ stream: string; chunk: string }> = [];

    const result = await executeClaudeProvider(makeCtx({
      config: { command: MOCK_AGENT },
      env: { MOCK_BEHAVIOR: "success", MOCK_FORMAT: "claude" },
      onEvent: (event) => { events.push(event); },
      onOutput: (stream, chunk) => { outputs.push({ stream, chunk }); },
    }));

    expect(result.exitCode).toBe(0);
    expect(result.status).toBe("completed");
    expect(result.sessionParams).toBeDefined();
    expect(result.sessionParams?.["sessionId"]).toBe("mock-session-1");
    expect(result.costUsd).toBe(0.0025);
    expect(result.model).toBe("claude-sonnet-4-20250514");
    expect(result.summary).toContain("Done");
    expect(result.errorCode).toBeNull();
    expect(result.billingType).toBe("subscription");
    expect(events.length).toBeGreaterThan(0);
    expect(outputs.length).toBeGreaterThan(0);
  });

  it("detects API billing type when ANTHROPIC_API_KEY set", async () => {
    const result = await executeClaudeProvider(makeCtx({
      config: { command: MOCK_AGENT },
      env: {
        MOCK_BEHAVIOR: "success",
        MOCK_FORMAT: "claude",
        ANTHROPIC_API_KEY: "sk-test-key",
      },
    }));

    expect(result.billingType).toBe("api");
  });

  it("handles max_turns error", async () => {
    const result = await executeClaudeProvider(makeCtx({
      config: { command: MOCK_AGENT },
      env: { MOCK_BEHAVIOR: "max_turns", MOCK_FORMAT: "claude" },
    }));

    expect(result.errorCode).toBe("max_turns");
  });

  it("handles timeout", async () => {
    const result = await executeClaudeProvider(makeCtx({
      config: { command: MOCK_AGENT, timeoutSec: 1, graceSec: 1 },
      env: { MOCK_BEHAVIOR: "timeout", MOCK_FORMAT: "claude" },
    }));

    expect(result.status).toBe("timeout");
    expect(result.errorCode).toBe("timeout");
  }, 10_000);

  it("handles auth required", async () => {
    const result = await executeClaudeProvider(makeCtx({
      config: { command: MOCK_AGENT },
      env: { MOCK_BEHAVIOR: "auth_required", MOCK_FORMAT: "claude" },
    }));

    expect(result.errorCode).toBe("auth_required");
  });

  it("handles generic error", async () => {
    const result = await executeClaudeProvider(makeCtx({
      config: { command: MOCK_AGENT },
      env: { MOCK_BEHAVIOR: "error", MOCK_FORMAT: "claude" },
    }));

    expect(result.exitCode).not.toBe(0);
    expect(result.errorMessage).toBeTruthy();
  });

  it("handles binary not found", async () => {
    const result = await executeClaudeProvider(makeCtx({
      config: { command: "/nonexistent/claude-binary" },
    }));

    expect(result.errorCode).toBe("binary_not_found");
  });
});
