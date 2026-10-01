import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createAntigravitySession } from "../../../src/providers/antigravity/session.js";
import type { AgentSession, SessionContext, StreamEvent } from "../../../src/types.js";

const MOCK_AGY = path.resolve(import.meta.dirname, "../../fixtures/mock-agy.sh");

async function tempDir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "agentex-agy-session-"));
}

async function readJsonLines<T>(file: string): Promise<T[]> {
  return (await readFile(file, "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as T);
}

async function open(env: Record<string, string> = {}, overrides: Partial<SessionContext> = {}) {
  const cwd = overrides.cwd ?? await tempDir();
  const events: StreamEvent[] = [];
  const session = await createAntigravitySession({
    cwd,
    env,
    ...overrides,
    config: { command: MOCK_AGY, ...overrides.config },
    onEvent: (event) => { events.push(event); },
  });
  return { session, events, cwd };
}

async function sendAndWait(session: AgentSession, message: string) {
  return (await session.send(message)).result;
}

describe("Antigravity session", () => {
  it("keeps one agy process across turns and reports per-turn usage", async () => {
    const dir = await tempDir();
    const argsFile = path.join(dir, "args.jsonl");
    const stdinFile = path.join(dir, "stdin.jsonl");
    const { session } = await open({ MOCK_DUMP_ARGS_TO: argsFile, MOCK_DUMP_STDIN_TO: stdinFile }, { cwd: dir });

    expect(session.sessionId).toBeNull();
    const first = await sendAndWait(session, "one");
    const second = await sendAndWait(session, "two");

    expect(first).toMatchObject({ status: "completed", summary: "echo: one", errorCode: null });
    expect(second).toMatchObject({ status: "completed", summary: "echo: two" });
    expect(first.usage).toEqual({ default: { inputTokens: 100, outputTokens: 10, cachedInputTokens: 0 } });
    // The CLI reports cumulative usage; the session reports each turn's share.
    expect(second.usage).toEqual({ default: { inputTokens: 100, outputTokens: 10, cachedInputTokens: 80 } });

    expect(await readJsonLines(argsFile)).toHaveLength(1);
    expect(await readJsonLines(stdinFile)).toEqual([
      { event: "user", message: { content: "one" } },
      { event: "user", message: { content: "two" } },
    ]);
    expect(session.sessionId).toMatch(/^mock-conv-\d+$/);
    expect(session.state).toBe("idle");
    await session.close();
    expect(session.state).toBe("closed");
  });

  it("brackets every turn with turn_start and turn_end", async () => {
    const { session, events } = await open();
    await sendAndWait(session, "one");
    await session.close();
    const types = events.map((e) => e.type);
    expect(types[0]).toBe("turn_start");
    expect(types.at(-1)).toBe("turn_end");
    expect(types.indexOf("result")).toBe(types.length - 2);
    const start = events[0] as Extract<StreamEvent, { type: "turn_start" }>;
    const end = events.at(-1) as Extract<StreamEvent, { type: "turn_end" }>;
    expect(start.trigger).toBe("send");
    expect(end).toMatchObject({ turnId: start.turnId, reason: "result" });
  });

  it("rejects a send while a turn is running", async () => {
    const { session } = await open({ MOCK_AGY_BEHAVIOR: "slow", MOCK_AGY_DELAY_MS: "500" });
    const handle = await session.send("one");
    await expect(session.send("two")).rejects.toThrow(/busy/);
    await handle.result;
    await session.close();
  });

  it("interrupts with SIGINT and keeps a process that survives it", async () => {
    const dir = await tempDir();
    const argsFile = path.join(dir, "args.jsonl");
    const { session, events } = await open({ MOCK_AGY_BEHAVIOR: "slow", MOCK_AGY_DELAY_MS: "30000", MOCK_DUMP_ARGS_TO: argsFile }, { cwd: dir });
    const handle = await session.send("one");
    setTimeout(() => void session.interrupt(), 200);
    const result = await handle.result;
    expect(result.status).toBe("aborted");
    const end = events.filter((e) => e.type === "turn_end").at(-1);
    expect(end).toMatchObject({ reason: "cancelled" });
    // The mock reports INTERRUPTED and keeps running, so no respawn.
    expect(await readJsonLines(argsFile)).toHaveLength(1);
    await session.close();
  });

  it("resumes the conversation in a new process after an interrupt ends the old one", async () => {
    const dir = await tempDir();
    const argsFile = path.join(dir, "args.jsonl");
    const { session } = await open({ MOCK_AGY_BEHAVIOR: "interrupt-exit", MOCK_AGY_DELAY_MS: "30000", MOCK_DUMP_ARGS_TO: argsFile }, { cwd: dir });
    const handle = await session.send("one");
    setTimeout(() => void session.interrupt(), 200);
    expect((await handle.result).status).toBe("aborted");
    const conversation = session.sessionId;
    expect(conversation).toMatch(/^mock-conv-\d+$/);

    const next = await session.send("two", { timeoutSec: 1 });
    expect((await next.result).status).toBe("timeout");
    const spawns = await readJsonLines<string[]>(argsFile);
    expect(spawns).toHaveLength(2);
    expect(spawns[1]).toEqual(expect.arrayContaining(["--conversation", conversation!]));
    await session.close();
  });

  it("re-runs a message once on a fresh process when agy exited without acknowledging it", async () => {
    const dir = await tempDir();
    const argsFile = path.join(dir, "args.jsonl");
    const { session } = await open(
      { MOCK_AGY_BEHAVIOR: "silent-exit-once", MOCK_AGY_STATE: path.join(dir, "state"), MOCK_DUMP_ARGS_TO: argsFile },
      { cwd: dir },
    );
    expect(await sendAndWait(session, "one")).toMatchObject({ status: "completed", summary: "echo: one" });
    expect(await readJsonLines(argsFile)).toHaveLength(2);
    await session.close();
  });

  it("does not retry more than once", async () => {
    const dir = await tempDir();
    const argsFile = path.join(dir, "args.jsonl");
    const { session } = await open({ MOCK_AGY_BEHAVIOR: "silent-exit", MOCK_DUMP_ARGS_TO: argsFile }, { cwd: dir });
    expect(await sendAndWait(session, "one")).toMatchObject({ status: "failed", errorCode: "process_exited" });
    expect(await readJsonLines(argsFile)).toHaveLength(2);
    await session.close();
  });

  it("times out a turn using the session default", async () => {
    const { session } = await open({ MOCK_AGY_BEHAVIOR: "slow", MOCK_AGY_DELAY_MS: "30000" }, { config: { timeoutSec: 1 } });
    const started = Date.now();
    const result = await sendAndWait(session, "one");
    expect(result).toMatchObject({ status: "timeout", errorCode: "timeout" });
    expect(Date.now() - started).toBeLessThan(10_000);
    await session.close();
  });

  it("aborts a turn on its send signal", async () => {
    const { session } = await open({ MOCK_AGY_BEHAVIOR: "slow", MOCK_AGY_DELAY_MS: "30000" });
    const controller = new AbortController();
    const handle = await session.send("one", { signal: controller.signal });
    setTimeout(() => controller.abort(), 200);
    expect((await handle.result).status).toBe("aborted");
    await session.close();
  });

  it("reports a crash and resumes the conversation on the next send", async () => {
    const dir = await tempDir();
    const argsFile = path.join(dir, "args.jsonl");
    const { session, events } = await open(
      { MOCK_AGY_BEHAVIOR: "crash", MOCK_DUMP_ARGS_TO: argsFile },
      { cwd: dir, sessionParams: { sessionId: "conv-7", cwd: dir } },
    );
    const result = await sendAndWait(session, "one");
    expect(result).toMatchObject({ status: "failed", errorCode: "process_exited", errorMessage: "panic: mock crash" });
    expect(events.filter((e) => e.type === "turn_end").at(-1)).toMatchObject({ reason: "session_closed" });
    await sendAndWait(session, "two");
    const spawns = await readJsonLines<string[]>(argsFile);
    expect(spawns).toHaveLength(2);
    expect(spawns.every((args) => args.includes("--conversation") && args.includes("conv-7"))).toBe(true);
    await session.close();
  });

  it("fails a turn fast with auth_required when agy is not signed in", async () => {
    const { session, events } = await open({ MOCK_AGY_BEHAVIOR: "auth" });
    const started = Date.now();
    const result = await sendAndWait(session, "one");
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(result).toMatchObject({ status: "failed", errorCode: "auth_required", errorMessage: expect.stringMatching(/Run `agy`/) });
    expect(events.some((e) => e.type === "auth_required" && e.loginCommand === "agy")).toBe(true);
    await session.close();
  });

  it("maps a failed turn to its error code and keeps the session usable", async () => {
    const { session } = await open({ MOCK_AGY_BEHAVIOR: "error" });
    const first = await sendAndWait(session, "one");
    expect(first).toMatchObject({ status: "failed", errorCode: "rate_limited", errorMessage: "Quota exceeded for model" });
    expect(session.state).toBe("idle");
    await session.close();
  });

  it("sends the instructions file with the first message of a new conversation only", async () => {
    const dir = await tempDir();
    const instructionsFile = path.join(dir, "brief.md");
    await writeFile(instructionsFile, "Be terse.");
    const { session } = await open({}, { cwd: dir, config: { instructionsFile } });
    expect((await sendAndWait(session, "one")).summary).toBe("echo: Be terse.\n\none");
    expect((await sendAndWait(session, "two")).summary).toBe("echo: two");
    await session.close();

    const resumed = await open({}, { cwd: dir, config: { instructionsFile }, sessionParams: { sessionId: "conv-1", cwd: dir } });
    expect((await sendAndWait(resumed.session, "three")).summary).toBe("echo: three");
    await resumed.session.close();
  });

  it("tracks tool execution state from stream events", async () => {
    const states: string[] = [];
    let session: AgentSession | null = null;
    const cwd = await tempDir();
    session = await createAntigravitySession({
      cwd,
      env: { MOCK_AGY_BEHAVIOR: "tool" },
      config: { command: MOCK_AGY },
      onEvent: () => { states.push(session!.state); },
    });
    await sendAndWait(session, "one");
    expect(states).toContain("tool_executing");
    expect(session.state).toBe("idle");
    await session.close();
  });

  it("refuses sends after close and after drain", async () => {
    const a = await open();
    await a.session.close();
    await expect(a.session.send("x")).rejects.toThrow(/closed/);

    const b = await open({ MOCK_AGY_BEHAVIOR: "slow", MOCK_AGY_DELAY_MS: "300" });
    const handle = await b.session.send("one");
    const drained = b.session.drain();
    await expect(b.session.send("two")).rejects.toThrow(/draining/);
    expect((await handle.result).status).toBe("completed");
    await drained;
    expect(b.session.state).toBe("closed");
  });

  it("close stops the agy process", async () => {
    const dir = await tempDir();
    const pidFile = path.join(dir, "pid");
    const { session } = await open({ MOCK_PID_FILE: pidFile }, { cwd: dir });
    await sendAndWait(session, "one");
    const pid = Number(await readFile(pidFile, "utf8"));
    expect(() => process.kill(pid, 0)).not.toThrow();
    await session.close();
    expect(() => process.kill(pid, 0)).toThrow();
  });

  it("closes when the session signal aborts", async () => {
    const controller = new AbortController();
    const { session } = await open({}, { signal: controller.signal });
    controller.abort();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(session.state).toBe("closed");
  });

  it("throws on create when agy is not installed", async () => {
    await expect(createAntigravitySession({ config: { command: "/nonexistent/agy" } })).rejects.toThrow(/does not exist/);
  });

  it("runs an emulated goal loop", async () => {
    const { session, events } = await open();
    await session.setGoal("say hi", { sentinel: () => true });
    for (let i = 0; i < 50 && session.getGoal()?.status !== "met"; i++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(session.getGoal()).toMatchObject({ status: "met", enforced: true });
    expect(events.some((e) => e.type === "goal_status")).toBe(true);
    await session.close();
  });
});
