import { describe, it, expect } from "vitest";
import * as path from "node:path";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
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
    expect(result.status).toBe("completed");
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

    expect(result.status).toBe("timeout");
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

  it("uses current flags and child cwd without undocumented workspace flags", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "agentex-cursor-args-"));
    const argsFile = path.join(dir, "args.jsonl");
    await executeCursorProvider(makeCtx({
      cwd: dir,
      model: "grok-4.5",
      config: { command: MOCK_CURSOR, skipPermissions: true, modeId: "plan" },
      env: { MOCK_BEHAVIOR: "success", MOCK_DUMP_ARGS_TO: argsFile },
    }));
    const args = JSON.parse((await readFile(argsFile, "utf8")).trim()) as string[];
    expect(args).toEqual(expect.arrayContaining(["--force", "--mode", "plan", "--model", "grok-4.5"]));
    expect(args).not.toContain("--workspace");
    expect(args).not.toContain("--yolo");
  });

  it("quarantines a failed resume and emits only the accepted rollover", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "agentex-cursor-rollover-"));
    const events: StreamEvent[] = [];
    const output: string[] = [];
    const result = await executeCursorProvider(makeCtx({
      cwd: dir,
      sessionParams: { sessionId: "mock-old", cwd: dir },
      config: { command: MOCK_CURSOR },
      env: { MOCK_BEHAVIOR: "unknown_then_success", MOCK_ATTEMPT_FILE: path.join(dir, "attempt") },
      onEvent: (event) => events.push(event),
      onOutput: (_stream, chunk) => output.push(chunk),
    }));
    expect(result.status).toBe("completed");
    expect(result.sessionParams?.["sessionId"]).toBe("mock-cursor-new");
    expect(events.some((event) => JSON.stringify(event.raw).includes("mock-old"))).toBe(false);
    expect(output.join("")).not.toContain("unknown session");
  });

  it("never rolls over after the acceptance marker", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "agentex-cursor-accepted-"));
    const argsFile = path.join(dir, "args.jsonl");
    const events: StreamEvent[] = [];
    const result = await executeCursorProvider(makeCtx({
      cwd: dir,
      sessionParams: { sessionId: "mock-old", cwd: dir },
      config: { command: MOCK_CURSOR },
      env: { MOCK_BEHAVIOR: "unknown_after_init", MOCK_DUMP_ARGS_TO: argsFile },
      onEvent: (event) => events.push(event),
    }));
    expect(result.status).toBe("failed");
    expect(events.some((event) => event.type === "system")).toBe(true);
    expect((await readFile(argsFile, "utf8")).trim().split("\n")).toHaveLength(1);
  });

  it("degrades a profile whose acceptance marker arrives after visible events", async () => {
    const events: StreamEvent[] = [];
    const result = await executeCursorProvider(makeCtx({
      config: { command: MOCK_CURSOR },
      env: { MOCK_BEHAVIOR: "bad_marker_order" },
      onEvent: (event) => events.push(event),
    }));
    expect(result.status).toBe("failed");
    expect(result.errorCode).toBe("protocol_degraded");
    expect(events).toEqual([]);
  });
});
