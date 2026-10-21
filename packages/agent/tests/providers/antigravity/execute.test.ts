import { access, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
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

describe("executeAntigravityProvider skills", () => {
  const originalHome = process.env.HOME;
  let home: string;

  beforeEach(async () => {
    // The legacy-link cleanup reads the home folder; keep it off the real one.
    home = await tempDir();
    process.env.HOME = home;
  });

  afterEach(() => {
    process.env.HOME = originalHome;
  });

  async function skill(parent: string, name: string): Promise<string> {
    const dir = path.join(parent, name);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${name} skill\n---\n`);
    return dir;
  }

  const exists = (p: string) => access(p).then(() => true, () => false);

  interface AddedFolder { dir: string; skills: Array<{ name: string; link: string | null; skill: string | null }> | null }

  it("adds the skills to the workspace in a temporary folder, removed after the run", async () => {
    const cwd = await tempDir();
    const outside = await skill(await tempDir(), "alpha");
    const inside = await skill(path.join(cwd, "skills"), "beta");
    const argsFile = path.join(cwd, "args.jsonl");
    const skillsFile = path.join(cwd, "skills.jsonl");
    const { result } = await run({
      cwd,
      env: { MOCK_DUMP_ARGS_TO: argsFile, MOCK_DUMP_SKILLS_TO: skillsFile },
      config: { skillDirs: [outside, inside], extraArgs: ["--host-flag"] },
    });
    expect(result.status).toBe("completed");

    const [args] = await readJsonLines<string[]>(argsFile);
    const skillsDir = args![args!.indexOf("--add-dir") + 1]!;
    expect(path.basename(skillsDir)).toMatch(/^agentex-skills-/);
    // agy reads a linked skill only when its real folder is in the workspace;
    // one already under cwd is, so only the outside one is added.
    expect(args).toEqual([
      "--input-format", "stream-json", "--output-format", "stream-json",
      "--add-dir", skillsDir,
      "--add-dir", await realpath(outside),
      "--host-flag",
    ]);

    const [folders] = await readJsonLines<AddedFolder[]>(skillsFile);
    expect(folders![0]).toEqual({
      dir: skillsDir,
      skills: [
        { name: "alpha", link: outside, skill: expect.stringContaining("name: alpha") },
        { name: "beta", link: inside, skill: expect.stringContaining("name: beta") },
      ],
    });

    expect(await exists(skillsDir)).toBe(false);
    // Nothing global: not agy's skill folders, not the legacy one.
    expect(await exists(path.join(home, ".gemini"))).toBe(false);
  });

  it("removes the skills folder when the run fails", async () => {
    const cwd = await tempDir();
    const argsFile = path.join(cwd, "args.jsonl");
    const { result } = await run({
      cwd,
      env: { MOCK_AGY_BEHAVIOR: "crash", MOCK_DUMP_ARGS_TO: argsFile },
      config: { skillDirs: [await skill(await tempDir(), "alpha")] },
    });
    expect(result.status).toBe("failed");
    const [args] = await readJsonLines<string[]>(argsFile);
    expect(await exists(args![args!.indexOf("--add-dir") + 1]!)).toBe(false);
  });

  it("adds a skill folder shared by two skill names once, and none for a missing skill", async () => {
    const cwd = await tempDir();
    const real = await skill(await tempDir(), "alpha");
    const alias = path.join(await tempDir(), "alias");
    await symlink(real, alias, "dir");
    const argsFile = path.join(cwd, "args.jsonl");
    await run({
      cwd,
      env: { MOCK_DUMP_ARGS_TO: argsFile },
      config: { skillDirs: [real, alias, path.join(cwd, "missing")] },
    });
    const [args] = await readJsonLines<string[]>(argsFile);
    const added = args!.filter((_, index) => args![index - 1] === "--add-dir");
    expect(added.slice(1)).toEqual([await realpath(real)]);
  });

  it("removes the links older versions left in agy's legacy folder, and nothing live there", async () => {
    const alpha = await skill(await tempDir(), "alpha");
    const other = await skill(await tempDir(), "other");
    const legacy = path.join(home, ".gemini", "antigravity-cli", "skills");
    await mkdir(legacy, { recursive: true });
    await symlink(alpha, path.join(legacy, "alpha"), "dir");
    await symlink(other, path.join(legacy, "other"), "dir");
    // Left for a skill since renamed or deleted: no one can read it.
    await symlink(path.join(home, "renamed-away"), path.join(legacy, "renamed"), "dir");
    await skill(legacy, "mine");

    await run({ config: { skillDirs: [alpha] } });

    expect((await readdir(legacy)).sort()).toEqual(["mine", "other"]);
    expect((await lstat(path.join(legacy, "other"))).isSymbolicLink()).toBe(true);
  });

  it("adds only the skills folder when agy skips permissions, since nothing is denied", async () => {
    const cwd = await tempDir();
    const argsFile = path.join(cwd, "args.jsonl");
    await run({
      cwd,
      env: { MOCK_DUMP_ARGS_TO: argsFile },
      config: { skillDirs: [await skill(await tempDir(), "alpha")], skipPermissions: true },
    });
    const [args] = await readJsonLines<string[]>(argsFile);
    expect(args).toContain("--dangerously-skip-permissions");
    expect(args!.filter((arg) => arg === "--add-dir")).toHaveLength(1);
  });

  it("still adds each skill's folder in plan mode, which keeps permissions", async () => {
    const cwd = await tempDir();
    const alpha = await skill(await tempDir(), "alpha");
    const argsFile = path.join(cwd, "args.jsonl");
    await run({
      cwd,
      env: { MOCK_DUMP_ARGS_TO: argsFile },
      config: { skillDirs: [alpha], skipPermissions: true, planMode: true },
    });
    const [args] = await readJsonLines<string[]>(argsFile);
    expect(args).not.toContain("--dangerously-skip-permissions");
    expect(args!.slice(-2)).toEqual(["--add-dir", await realpath(alpha)]);
  });

  it("adds no folder without skills", async () => {
    const cwd = await tempDir();
    const argsFile = path.join(cwd, "args.jsonl");
    await run({ cwd, env: { MOCK_DUMP_ARGS_TO: argsFile }, config: { skillDirs: [] } });
    const [args] = await readJsonLines<string[]>(argsFile);
    expect(args).not.toContain("--add-dir");
  });
});
