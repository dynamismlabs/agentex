import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { executeAntigravityProvider } from "../../../src/providers/antigravity/execute.js";
import type { ExecutionContext, StreamEvent } from "../../../src/types.js";

const MOCK_AGY = path.resolve(import.meta.dirname, "../../fixtures/mock-agy.sh");

const tempDirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "agentex-agy-exec-"));
  tempDirs.push(dir);
  return dir;
}

afterAll(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function readJsonLines<T>(file: string): Promise<T[]> {
  return (await readFile(file, "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as T);
}

async function run(overrides: Partial<ExecutionContext> & { env?: Record<string, string> } = {}) {
  const cwd = overrides.cwd ?? await tempDir();
  const events: StreamEvent[] = [];
  const result = await executeAntigravityProvider({
    prompt: "hello",
    cwd,
    ...overrides,
    config: { command: MOCK_AGY, ...overrides.config },
    onEvent: (event) => { events.push(event); },
  });
  return { result, events, cwd };
}

describe("executeAntigravityProvider", () => {
  it("runs one turn over stdin and reports the conversation for resume", async () => {
    const dir = await tempDir();
    const argsFile = path.join(dir, "args.jsonl");
    const stdinFile = path.join(dir, "stdin.jsonl");
    const { result, events, cwd } = await run({
      cwd: dir,
      env: { MOCK_DUMP_ARGS_TO: argsFile, MOCK_DUMP_STDIN_TO: stdinFile },
    });

    expect(result.status).toBe("completed");
    expect(result.exitCode).toBe(0);
    expect(result.errorCode).toBeNull();
    expect(result.summary).toBe("echo: hello");
    expect(result.sessionDisplayId).toMatch(/^mock-conv-\d+$/);
    expect(result.sessionParams).toEqual({ sessionId: result.sessionDisplayId, cwd });
    expect(result.clearSession).toBe(false);
    expect(result.numTurns).toBe(1);
    expect(result.usage).toEqual({ default: { inputTokens: 100, outputTokens: 10, cachedInputTokens: 0 } });
    expect(result.billingType).toBe("subscription");
    expect(result.raw).toMatchObject({ event: "result" });

    // The prompt went over stdin as one NDJSON user message, never argv.
    const [args] = await readJsonLines<string[]>(argsFile);
    expect(args).toEqual(["--input-format", "stream-json", "--output-format", "stream-json"]);
    expect(await readJsonLines(stdinFile)).toEqual([{ event: "user", message: { content: "hello" } }]);

    expect(events.map((e) => e.type)).toEqual(["system", "assistant", "unknown", "result"]);
    expect(events.every((e) => e.providerType === "antigravity")).toBe(true);
  });

  it("passes model, effort, mode, permissions, sandbox, and extra args", async () => {
    const dir = await tempDir();
    const argsFile = path.join(dir, "args.jsonl");
    const { result } = await run({
      cwd: dir,
      model: "gemini-3.1-pro-high",
      env: { MOCK_DUMP_ARGS_TO: argsFile },
      config: {
        effort: "high",
        modeId: "accept-edits",
        skipPermissions: true,
        sandbox: true,
        extraArgs: ["--agent", "reviewer"],
      },
    });
    const [args] = await readJsonLines<string[]>(argsFile);
    expect(args).toEqual([
      "--input-format", "stream-json", "--output-format", "stream-json",
      "--model", "gemini-3.1-pro-high",
      "--effort", "high",
      "--mode", "accept-edits",
      "--dangerously-skip-permissions",
      "--sandbox",
      "--agent", "reviewer",
    ]);
    expect(result.model).toBe("gemini-3.1-pro-high");
    expect(result.usage).toHaveProperty("gemini-3.1-pro-high");
  });

  it("plan mode wins over skipPermissions and the default mode adds no flag", async () => {
    const dir = await tempDir();
    const argsFile = path.join(dir, "args.jsonl");
    await run({ cwd: dir, env: { MOCK_DUMP_ARGS_TO: argsFile }, config: { planMode: true, skipPermissions: true } });
    await run({ cwd: dir, env: { MOCK_DUMP_ARGS_TO: argsFile }, config: { modeId: "default" } });
    const [plan, plain] = await readJsonLines<string[]>(argsFile);
    expect(plan).toEqual(expect.arrayContaining(["--mode", "plan"]));
    expect(plan).not.toContain("--dangerously-skip-permissions");
    expect(plain).not.toContain("--mode");
  });

  it("resumes a conversation saved in the same directory", async () => {
    const dir = await tempDir();
    const argsFile = path.join(dir, "args.jsonl");
    const { result } = await run({
      cwd: dir,
      env: { MOCK_DUMP_ARGS_TO: argsFile },
      sessionParams: { sessionId: "conv-123", cwd: dir },
    });
    const [args] = await readJsonLines<string[]>(argsFile);
    expect(args).toEqual(expect.arrayContaining(["--conversation", "conv-123"]));
    expect(result.sessionDisplayId).toBe("conv-123");
    expect(result.clearSession).toBe(false);
  });

  it("starts fresh instead of resuming a conversation from another directory", async () => {
    const dir = await tempDir();
    const argsFile = path.join(dir, "args.jsonl");
    await run({
      cwd: dir,
      env: { MOCK_DUMP_ARGS_TO: argsFile },
      sessionParams: { sessionId: "conv-123", cwd: "/some/other/project" },
    });
    const [args] = await readJsonLines<string[]>(argsFile);
    expect(args).not.toContain("--conversation");
  });

  it("flags clearSession when agy could not find the conversation and started a new one", async () => {
    const dir = await tempDir();
    const { result } = await run({ cwd: dir, sessionParams: { sessionId: "missing", cwd: dir } });
    expect(result.status).toBe("completed");
    expect(result.sessionDisplayId).not.toBe("missing");
    expect(result.clearSession).toBe(true);
  });

  it("sends the instructions file with every run, like a per-process system prompt", async () => {
    const dir = await tempDir();
    const instructionsFile = path.join(dir, "brief.md");
    await writeFile(instructionsFile, "Always answer in haiku.");
    const fresh = await run({ cwd: dir, config: { instructionsFile } });
    expect(fresh.result.summary).toBe("echo: Always answer in haiku.\n\nhello");
    const resumed = await run({ cwd: dir, config: { instructionsFile }, sessionParams: { sessionId: "conv-9", cwd: dir } });
    expect(resumed.result.summary).toBe("echo: Always answer in haiku.\n\nhello");
  });

  it("keeps the instructions when the saved conversation no longer exists", async () => {
    const dir = await tempDir();
    const instructionsFile = path.join(dir, "brief.md");
    await writeFile(instructionsFile, "Always answer in haiku.");
    const { result } = await run({ cwd: dir, config: { instructionsFile }, sessionParams: { sessionId: "missing", cwd: dir } });
    expect(result.clearSession).toBe(true);
    expect(result.summary).toBe("echo: Always answer in haiku.\n\nhello");
  });

  it("maps tool steps to correlated tool_call / tool_result events", async () => {
    const { events } = await run({ env: { MOCK_AGY_BEHAVIOR: "tool" } });
    const tools = events.filter((e) => e.type === "tool_call" || e.type === "tool_result");
    expect(tools.map((e) => e.type)).toEqual(["tool_call", "tool_result", "tool_call", "tool_result"]);
    expect(tools[0]).toMatchObject({ name: "run_command", input: { CommandLine: "echo hi" } });
    expect(tools[1]).toMatchObject({ toolName: "run_command", content: "hi\r\n", isError: false, toolCallId: tools[0]!.type === "tool_call" ? tools[0]!.toolCallId : null });
    expect(tools[3]).toMatchObject({ toolName: "view_file", isError: true, content: "no such file" });
  });

  it("reports an AGY_ERROR rate limit as a failed run", async () => {
    const { result } = await run({ env: { MOCK_AGY_BEHAVIOR: "error" } });
    expect(result.status).toBe("failed");
    expect(result.errorCode).toBe("rate_limited");
    expect(result.errorMessage).toBe("Quota exceeded for model");
  });

  it("reports a run that ended waiting on input as blocked", async () => {
    const { result } = await run({ env: { MOCK_AGY_BEHAVIOR: "waiting" } });
    expect(result.status).toBe("blocked");
    expect(result.errorCode).toBe("waiting_for_input");
  });

  it("surfaces soft-denied tools as permissionDenials", async () => {
    const { result } = await run({ env: { MOCK_AGY_BEHAVIOR: "denied" } });
    expect(result.status).toBe("completed");
    expect(result.permissionDenials).toEqual([{ tool: "run_command", target: "rm -rf /tmp/x" }]);
  });

  it("fails fast with auth_required instead of waiting out agy's sign-in prompt", async () => {
    const started = Date.now();
    const { result, events } = await run({ env: { MOCK_AGY_BEHAVIOR: "auth" } });
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(result.status).toBe("failed");
    expect(result.errorCode).toBe("auth_required");
    expect(result.errorMessage).toMatch(/Run `agy`/);
    const auth = events.find((e) => e.type === "auth_required");
    expect(auth).toMatchObject({ type: "auth_required", reason: "missing", loginCommand: "agy" });
  });

  it("reports a crash without a result as a failed run with the stderr reason", async () => {
    const { result } = await run({ env: { MOCK_AGY_BEHAVIOR: "crash" } });
    expect(result.status).toBe("failed");
    expect(result.errorCode).toBe("agent_error");
    expect(result.exitCode).toBe(2);
    expect(result.errorMessage).toBe("panic: mock crash");
  });

  it("interrupts a run that exceeds its timeout and never leaves the process behind", async () => {
    const dir = await tempDir();
    const pidFile = path.join(dir, "pid");
    const started = Date.now();
    const { result } = await run({
      cwd: dir,
      env: { MOCK_AGY_BEHAVIOR: "slow", MOCK_AGY_DELAY_MS: "30000", MOCK_PID_FILE: pidFile },
      config: { timeoutSec: 1 },
    });
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(result.status).toBe("timeout");
    expect(result.errorCode).toBe("timeout");
    const pid = Number(await readFile(pidFile, "utf8"));
    expect(() => process.kill(pid, 0)).toThrow();
  });

  it("reports a timeout that fires after the answer while agy finishes background work", async () => {
    const dir = await tempDir();
    const pidFile = path.join(dir, "pid");
    const started = Date.now();
    const { result } = await run({
      cwd: dir,
      env: { MOCK_AGY_LINGER_MS: "30000", MOCK_PID_FILE: pidFile },
      config: { timeoutSec: 1 },
    });
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(result).toMatchObject({ status: "timeout", errorCode: "timeout", summary: "echo: hello" });
    expect(result.usage).toBeDefined();
    const pid = Number(await readFile(pidFile, "utf8"));
    expect(() => process.kill(pid, 0)).toThrow();
  });

  it("aborts on the caller's signal", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 300);
    const { result } = await run({ env: { MOCK_AGY_BEHAVIOR: "slow", MOCK_AGY_DELAY_MS: "30000" }, signal: controller.signal });
    expect(result.status).toBe("aborted");
  });

  it("reports a missing binary without spawning", async () => {
    const { result } = await run({ config: { command: "/nonexistent/agy" } });
    expect(result.status).toBe("failed");
    expect(result.errorCode).toBe("binary_not_found");
  });

  it("streams assistant deltas when partial messages are requested", async () => {
    const { events } = await run({ config: { includePartialMessages: true } });
    const deltas = events.filter((e) => e.type === "assistant_delta").map((e) => e.type === "assistant_delta" && e.text);
    expect(deltas.join("")).toBe("echo: hello\n");
  });

  it("emits lifecycle phases and the child pid", async () => {
    const phases: string[] = [];
    let pid: number | null = null;
    const cwd = await tempDir();
    await executeAntigravityProvider({
      prompt: "hi",
      cwd,
      config: { command: MOCK_AGY },
      onLifecycle: (event) => phases.push(event.phase),
      onStart: (p) => { pid = p; },
    });
    expect(phases).toEqual(expect.arrayContaining(["preparing", "spawning", "running", "completed"]));
    expect(pid).toBeGreaterThan(0);
  });
});
