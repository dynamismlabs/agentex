import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { executeCodexProvider } from "../../../src/providers/codex/execute.js";
import type { ExecutionContext, StreamEvent } from "../../../src/types.js";

const MOCK_CODEX = path.resolve(import.meta.dirname, "../../fixtures/mock-codex.sh");
const CWD = process.cwd();

// Isolate tests from the developer's real ~/.codex/auth.json so the Codex
// billing-prediction logic (which prefers subscription when auth.json exists)
// doesn't flip based on local state.
let tmpCodexHome: string;
const originalCodexHome = process.env.CODEX_HOME;

beforeEach(async () => {
  tmpCodexHome = await fs.mkdtemp(path.join(os.tmpdir(), "codex-test-"));
  process.env.CODEX_HOME = tmpCodexHome;
});

afterEach(async () => {
  if (originalCodexHome !== undefined) process.env.CODEX_HOME = originalCodexHome;
  else delete process.env.CODEX_HOME;
  await fs.rm(tmpCodexHome, { recursive: true, force: true });
});

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
    expect(result.status).toBe("completed");
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

    expect(result.status).toBe("timeout");
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

  it("passes --sandbox read-only when config.planMode is true", async () => {
    const dumpFile = path.join(os.tmpdir(), `codex-args-${Date.now()}-${Math.random()}.txt`);
    try {
      await executeCodexProvider(makeCtx({
        config: { command: MOCK_CODEX, planMode: true },
        env: { MOCK_BEHAVIOR: "success", MOCK_DUMP_ARGS_TO: dumpFile },
      }));
      const content = await fs.readFile(dumpFile, "utf-8");
      const args = content.split("\n").filter((l) => l.length > 0);
      const idx = args.indexOf("--sandbox");
      expect(idx).toBeGreaterThanOrEqual(0);
      expect(args[idx + 1]).toBe("read-only");
      expect(args).not.toContain("--dangerously-bypass-approvals-and-sandbox");
    } finally {
      await fs.rm(dumpFile, { force: true });
    }
  });

  it("planMode wins over skipPermissions when both are set", async () => {
    const dumpFile = path.join(os.tmpdir(), `codex-args-${Date.now()}-${Math.random()}.txt`);
    try {
      await executeCodexProvider(makeCtx({
        config: { command: MOCK_CODEX, planMode: true, skipPermissions: true },
        env: { MOCK_BEHAVIOR: "success", MOCK_DUMP_ARGS_TO: dumpFile },
      }));
      const content = await fs.readFile(dumpFile, "utf-8");
      const args = content.split("\n").filter((l) => l.length > 0);
      expect(args).toContain("--sandbox");
      expect(args).not.toContain("--dangerously-bypass-approvals-and-sandbox");
    } finally {
      await fs.rm(dumpFile, { force: true });
    }
  });

  it("does not pass --sandbox when planMode is unset", async () => {
    const dumpFile = path.join(os.tmpdir(), `codex-args-${Date.now()}-${Math.random()}.txt`);
    try {
      await executeCodexProvider(makeCtx({
        config: { command: MOCK_CODEX },
        env: { MOCK_BEHAVIOR: "success", MOCK_DUMP_ARGS_TO: dumpFile },
      }));
      const content = await fs.readFile(dumpFile, "utf-8");
      const args = content.split("\n").filter((l) => l.length > 0);
      expect(args).not.toContain("--sandbox");
    } finally {
      await fs.rm(dumpFile, { force: true });
    }
  });

  it("prepends the plan-mode preamble to the prompt when planMode is true", async () => {
    const dumpFile = path.join(os.tmpdir(), `codex-stdin-${Date.now()}-${Math.random()}.txt`);
    try {
      await executeCodexProvider(makeCtx({
        prompt: "Refactor login.ts",
        config: { command: MOCK_CODEX, planMode: true },
        env: { MOCK_BEHAVIOR: "success", MOCK_DUMP_STDIN_TO: dumpFile },
      }));
      const stdin = await fs.readFile(dumpFile, "utf-8");
      expect(stdin).toContain("Plan Mode");
      expect(stdin).toContain("read-only plan mode");
      expect(stdin).toContain("Refactor login.ts");
      // The user's prompt should still come last so it isn't masked by the preamble.
      expect(stdin.lastIndexOf("Refactor login.ts")).toBeGreaterThan(
        stdin.indexOf("Plan Mode"),
      );
    } finally {
      await fs.rm(dumpFile, { force: true });
    }
  });

  it("does not include the plan-mode preamble when planMode is unset", async () => {
    const dumpFile = path.join(os.tmpdir(), `codex-stdin-${Date.now()}-${Math.random()}.txt`);
    try {
      await executeCodexProvider(makeCtx({
        prompt: "Refactor login.ts",
        config: { command: MOCK_CODEX },
        env: { MOCK_BEHAVIOR: "success", MOCK_DUMP_STDIN_TO: dumpFile },
      }));
      const stdin = await fs.readFile(dumpFile, "utf-8");
      expect(stdin).not.toContain("Plan Mode");
    } finally {
      await fs.rm(dumpFile, { force: true });
    }
  });
});
