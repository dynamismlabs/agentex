import { execFileSync } from "node:child_process";
import { access, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { translateCodexExecArgs } from "../../../src/providers/codex/app-server-execute.js";
import { executeCodexProvider } from "../../../src/providers/codex/execute.js";
import { createCodexSession } from "../../../src/providers/codex/session.js";

const MOCK_APP_SERVER = path.resolve(import.meta.dirname, "../../fixtures/mock-codex-app-server.sh");
const MOCK_EXEC = path.resolve(import.meta.dirname, "../../fixtures/mock-codex.sh");

const tempDirs: string[] = [];
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "agentex-codex-skills-"));
  tempDirs.push(dir);
  return dir;
}
afterAll(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function skill(parent: string, name: string): Promise<string> {
  const dir = path.join(parent, name);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${name} skill\n---\n`);
  return dir;
}

const exists = (p: string) => access(p).then(() => true, () => false);
const jsonLines = async <T,>(file: string): Promise<T[]> =>
  (await readFile(file, "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as T);
const argLines = async (file: string): Promise<string[]> => (await readFile(file, "utf8")).split("\n").filter(Boolean);

interface Request { method: string; params?: Record<string, unknown> }
interface Root { root: string; skills: Array<{ name: string; link: string | null; skill: string | null }> | null }

describe("Codex session skills", () => {
  it("hands the skills to app-server before the thread starts, writes nothing to the folder, and removes them on close", async () => {
    const cwd = await tempDir();
    const sources = await tempDir();
    const real = await skill(sources, "alpha");
    const linked = path.join(await tempDir(), "beta");
    await symlink(await skill(sources, "beta-source"), linked, "dir");
    const requestsFile = path.join(sources, "requests.jsonl");
    const rootsFile = path.join(sources, "roots.jsonl");

    const session = await createCodexSession({
      cwd,
      env: { MOCK_DUMP_REQUESTS_TO: requestsFile, MOCK_DUMP_SKILL_ROOTS_TO: rootsFile },
      config: { command: MOCK_APP_SERVER, skillDirs: [real, linked] },
    });

    const requests = await jsonLines<Request>(requestsFile);
    expect(requests.map((r) => r.method)).toEqual(["initialize", "skills/extraRoots/set", "thread/start"]);
    const [[root]] = await jsonLines<Root[]>(rootsFile);
    expect(requests[1]!.params).toEqual({ extraRoots: [root!.root] });
    expect(root!.skills).toEqual([
      { name: "alpha", link: real, skill: expect.stringContaining("name: alpha") },
      { name: "beta", link: linked, skill: expect.stringContaining("name: beta-source") },
    ]);
    expect(await readdir(cwd)).toEqual([]);

    expect(await exists(root!.root)).toBe(true);
    await session.close();
    expect(await exists(root!.root)).toBe(false);
    expect(await exists(path.dirname(root!.root))).toBe(false);
  });

  it("starts without the skills, and says so, on a codex-cli without skills/extraRoots/set", async () => {
    const cwd = await tempDir();
    const requestsFile = path.join(cwd, "..", `${path.basename(cwd)}-requests.jsonl`);
    tempDirs.push(requestsFile);
    const stderr: string[] = [];
    const session = await createCodexSession({
      cwd,
      env: { MOCK_DUMP_REQUESTS_TO: requestsFile, MOCK_CODEX_NO_EXTRA_ROOTS: "1" },
      config: { command: MOCK_APP_SERVER, skillDirs: [await skill(await tempDir(), "alpha")] },
      onOutput: (stream, chunk) => { if (stream === "stderr") stderr.push(chunk); },
    });
    expect((await jsonLines<Request>(requestsFile)).map((r) => r.method)).toContain("thread/start");
    expect(stderr.join("")).toMatch(/skills\/extraRoots\/set failed, so this chat has no skillDirs/);
    expect(await readdir(cwd)).toEqual([]);
    await session.close();
  });

  it("removes the skills folder when the session fails to start", async () => {
    const cwd = await tempDir();
    const requestsFile = path.join(await tempDir(), "requests.jsonl");
    await expect(createCodexSession({
      cwd,
      env: { MOCK_DUMP_REQUESTS_TO: requestsFile, MOCK_CODEX_FAIL_METHOD: "thread/start" },
      config: { command: MOCK_APP_SERVER, skillDirs: [await skill(await tempDir(), "alpha")] },
    })).rejects.toThrow(/mock failure: thread\/start/);
    const set = (await jsonLines<Request>(requestsFile)).find((r) => r.method === "skills/extraRoots/set")!;
    const [root] = set.params!["extraRoots"] as string[];
    expect(await exists(path.dirname(root!))).toBe(false);
  });

  it("gives concurrent sessions in one folder their own skills, and leaves the folder alone", async () => {
    const cwd = await tempDir();
    const scratch = await tempDir();
    const open = async (name: string) => {
      const rootsFile = path.join(scratch, `${name}.jsonl`);
      const session = await createCodexSession({
        cwd,
        env: { MOCK_DUMP_SKILL_ROOTS_TO: rootsFile },
        config: { command: MOCK_APP_SERVER, skillDirs: [await skill(scratch, name)] },
      });
      const [[root]] = await jsonLines<Root[]>(rootsFile);
      return { session, root: root! };
    };
    const [a, b] = await Promise.all([open("alpha"), open("beta")]);
    expect(a.root.root).not.toBe(b.root.root);
    expect(a.root.skills!.map((s) => s.name)).toEqual(["alpha"]);
    expect(b.root.skills!.map((s) => s.name)).toEqual(["beta"]);
    expect(await readdir(cwd)).toEqual([]);
    await a.session.close();
    // One closing never takes the other's skills.
    expect(await exists(b.root.root)).toBe(true);
    await b.session.close();
    expect(await exists(b.root.root)).toBe(false);
  });

  it("removes the links older versions left in the project, except ones git tracks", async () => {
    const cwd = await tempDir();
    const sources = path.join(await tempDir(), "skills");
    const alpha = await skill(sources, "alpha");
    const beta = await skill(sources, "beta");
    const theirs = await skill(await tempDir(), "theirs");
    const folder = path.join(cwd, ".agents", "skills");
    await mkdir(folder, { recursive: true });
    const git = (...args: string[]) => execFileSync("git", args, { cwd, stdio: "pipe" });
    git("init", "-q");
    git("config", "user.email", "test@example.com");
    git("config", "user.name", "test");
    await symlink(alpha, path.join(folder, "alpha"), "dir");
    git("add", ".agents/skills/alpha");
    git("commit", "-q", "-m", "committed by an older agentex");
    await symlink(beta, path.join(folder, "beta"), "dir");
    await symlink(path.join(sources, "renamed-away"), path.join(folder, "renamed"), "dir");
    await symlink(theirs, path.join(folder, "theirs"), "dir");
    await symlink(path.join(cwd, "..", "unmounted", "other"), path.join(folder, "other"), "dir");

    const session = await createCodexSession({ cwd, config: { command: MOCK_APP_SERVER, skillDirs: [alpha, beta] } });
    await session.close();

    // Tracked: removing it would change the working tree. The rest are another
    // tool's or the user's: a live link elsewhere, and a dead one elsewhere.
    expect((await readdir(folder)).sort()).toEqual(["alpha", "other", "theirs"]);
    expect(execFileSync("git", ["status", "--porcelain", "--", ".agents"], { cwd, encoding: "utf8" })).not.toMatch(/^ D/m);
  });

  it("finds the repo through a cwd that links into one of its subfolders", async () => {
    // repo/sub/.agents/skills/alpha is tracked; the session runs in outside/link -> repo/sub.
    const repo = await tempDir();
    const sub = path.join(repo, "sub");
    const alpha = await skill(await tempDir(), "alpha");
    const beta = await skill(await tempDir(), "beta");
    const folder = path.join(sub, ".agents", "skills");
    await mkdir(folder, { recursive: true });
    const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "pipe" });
    git("init", "-q");
    git("config", "user.email", "test@example.com");
    git("config", "user.name", "test");
    await symlink(alpha, path.join(folder, "alpha"), "dir");
    git("add", "sub/.agents/skills/alpha");
    git("commit", "-q", "-m", "committed by an older agentex");
    await symlink(beta, path.join(folder, "beta"), "dir");
    const link = path.join(await tempDir(), "link");
    await symlink(sub, link, "dir");

    const session = await createCodexSession({ cwd: link, config: { command: MOCK_APP_SERVER, skillDirs: [alpha, beta] } });
    await session.close();

    // The tracked link stays; the untracked one, reached through the link, goes.
    expect(await readdir(folder)).toEqual(["alpha"]);
    expect(execFileSync("git", ["status", "--porcelain"], { cwd: repo, encoding: "utf8" })).toBe("");
  });

  it("removes the project folders it emptied of old links", async () => {
    const cwd = await tempDir();
    const alpha = await skill(await tempDir(), "alpha");
    await mkdir(path.join(cwd, ".agents", "skills"), { recursive: true });
    await symlink(alpha, path.join(cwd, ".agents", "skills", "alpha"), "dir");
    const session = await createCodexSession({ cwd, config: { command: MOCK_APP_SERVER, skillDirs: [alpha] } });
    await session.close();
    expect(await readdir(cwd)).toEqual([]);
  });
});

describe("Codex one-shot runs with skills", () => {
  it("go through app-server with exec's approval policy, and return the turn", async () => {
    const cwd = await tempDir();
    const scratch = await tempDir();
    const argsFile = path.join(scratch, "args.txt");
    const requestsFile = path.join(scratch, "requests.jsonl");
    const rootsFile = path.join(scratch, "roots.jsonl");
    const pids: number[] = [];

    const result = await executeCodexProvider({
      prompt: "hello",
      cwd,
      env: { MOCK_DUMP_ARGS_TO: argsFile, MOCK_DUMP_REQUESTS_TO: requestsFile, MOCK_DUMP_SKILL_ROOTS_TO: rootsFile },
      config: { command: MOCK_APP_SERVER, skillDirs: [await skill(scratch, "alpha")] },
      onStart: (pid) => { pids.push(pid); },
    });

    expect(result).toMatchObject({
      status: "completed",
      exitCode: 0,
      errorCode: null,
      summary: "echo: hello",
      sessionParams: { sessionId: "mock-thread", cwd },
      sessionDisplayId: "mock-thread",
      clearSession: false,
    });
    expect(pids).toHaveLength(1);
    const args = await argLines(argsFile);
    expect(args).toContain("app-server");
    expect(args).toEqual(expect.arrayContaining(["-c", 'approval_policy="never"']));
    const requests = await jsonLines<Request>(requestsFile);
    expect(requests.map((r) => r.method)).toEqual(["initialize", "skills/extraRoots/set", "thread/start", "turn/start"]);
    expect(requests[2]!.params).toMatchObject({ approvalPolicy: "never" });
    const [[root]] = await jsonLines<Root[]>(rootsFile);
    expect(root!.skills!.map((s) => s.name)).toEqual(["alpha"]);
    expect(await exists(path.dirname(root!.root))).toBe(false);
    expect(await readdir(cwd)).toEqual([]);
  });

  it("keep web search and plan mode, and resume a thread from the same folder", async () => {
    const cwd = await tempDir();
    const scratch = await tempDir();
    const argsFile = path.join(scratch, "args.txt");
    const requestsFile = path.join(scratch, "requests.jsonl");

    const result = await executeCodexProvider({
      prompt: "plan it",
      cwd,
      sessionParams: { sessionId: "thread-7", cwd },
      env: { MOCK_DUMP_ARGS_TO: argsFile, MOCK_DUMP_REQUESTS_TO: requestsFile },
      config: { command: MOCK_APP_SERVER, skillDirs: [await skill(scratch, "alpha")], search: true, planMode: true },
    });

    expect(result).toMatchObject({ status: "completed", sessionDisplayId: "thread-7", clearSession: false });
    expect(await argLines(argsFile)).toEqual(expect.arrayContaining(["-c", 'web_search="live"']));
    const resume = (await jsonLines<Request>(requestsFile)).find((r) => r.method === "thread/resume")!;
    expect(resume.params).toMatchObject({ threadId: "thread-7", approvalPolicy: "never", sandbox: "read-only" });
  });

  it("start fresh instead of resuming a thread from another folder", async () => {
    const cwd = await tempDir();
    const scratch = await tempDir();
    const requestsFile = path.join(scratch, "requests.jsonl");
    await executeCodexProvider({
      prompt: "hi",
      cwd,
      sessionParams: { sessionId: "thread-7", cwd: scratch },
      env: { MOCK_DUMP_REQUESTS_TO: requestsFile },
      config: { command: MOCK_APP_SERVER, skillDirs: [await skill(scratch, "alpha")] },
    });
    expect((await jsonLines<Request>(requestsFile)).map((r) => r.method)).toContain("thread/start");
  });

  it("reject a startup failure after removing the skills", async () => {
    const cwd = await tempDir();
    const scratch = await tempDir();
    const requestsFile = path.join(scratch, "requests.jsonl");
    await expect(executeCodexProvider({
      prompt: "hi",
      cwd,
      env: { MOCK_DUMP_REQUESTS_TO: requestsFile, MOCK_CODEX_FAIL_METHOD: "thread/start" },
      config: { command: MOCK_APP_SERVER, skillDirs: [await skill(scratch, "alpha")] },
    })).rejects.toThrow(/mock failure/);
    const set = (await jsonLines<Request>(requestsFile)).find((r) => r.method === "skills/extraRoots/set")!;
    expect(await exists(path.dirname((set.params!["extraRoots"] as string[])[0]!))).toBe(false);
  });

  it("without skills still use codex exec", async () => {
    const cwd = await tempDir();
    const argsFile = path.join(await tempDir(), "args.jsonl");
    await executeCodexProvider({
      prompt: "hi",
      cwd,
      env: { MOCK_FORMAT: "codex", MOCK_DUMP_ARGS_TO: argsFile },
      config: { command: MOCK_EXEC, skillDirs: [] },
    });
    const text = await readFile(argsFile, "utf8");
    expect(text).toContain("exec");
    expect(text).not.toContain("app-server");
    expect(await exists(path.join(cwd, ".agents"))).toBe(false);
    expect((await lstat(cwd)).isDirectory()).toBe(true);
  });
});

describe("Codex app-server failures", () => {
  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

  /** Run `fn` with os.tmpdir() pointing at a fresh folder, so staged skills can be counted. */
  async function withTmp<T>(fn: (scratch: string) => Promise<T>): Promise<T> {
    const scratch = await tempDir();
    const original = process.env.TMPDIR;
    process.env.TMPDIR = scratch;
    try {
      return await fn(scratch);
    } finally {
      if (original === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = original;
    }
  }

  it("settles a send whose turn/start Codex rejects, and takes the next one", async () => {
    const session = await createCodexSession({
      cwd: await tempDir(),
      env: { MOCK_CODEX_FAIL_METHOD: "turn/start", MOCK_CODEX_FAIL_ONCE: "1" },
      config: { command: MOCK_APP_SERVER },
    });
    expect(await (await session.send("one")).result).toMatchObject({
      status: "failed",
      errorCode: "turn_start_failed",
      errorMessage: expect.stringContaining("mock failure: turn/start"),
    });
    expect(session.state).toBe("idle");
    expect(await (await session.send("two")).result).toMatchObject({ status: "completed", summary: "echo: two" });
    await session.close();
  });

  it("starts without the skills when skills/extraRoots/set never answers", async () => {
    const stderr: string[] = [];
    const started = Date.now();
    const session = await createCodexSession({
      cwd: await tempDir(),
      env: { MOCK_CODEX_HANG_METHOD: "skills/extraRoots/set" },
      config: { command: MOCK_APP_SERVER, skillDirs: [await skill(await tempDir(), "alpha")] },
      onOutput: (stream, chunk) => { if (stream === "stderr") stderr.push(chunk); },
    });
    expect(Date.now() - started).toBeLessThan(9_000);
    expect(stderr.join("")).toMatch(/no answer in 5s/);
    expect(await (await session.send("hi")).result).toMatchObject({ status: "completed" });
    await session.close();
  }, 15_000);

  it("keeps every old link when git can't say what it tracks", async () => {
    const cwd = await tempDir();
    const alpha = await skill(await tempDir(), "alpha");
    const beta = await skill(await tempDir(), "beta");
    const folder = path.join(cwd, ".agents", "skills");
    await mkdir(folder, { recursive: true });
    const git = (...args: string[]) => execFileSync("git", args, { cwd, stdio: "pipe" });
    git("init", "-q");
    git("config", "user.email", "test@example.com");
    git("config", "user.name", "test");
    await symlink(alpha, path.join(folder, "alpha"), "dir");
    git("add", ".agents/skills/alpha");
    git("commit", "-q", "-m", "committed by an older agentex");
    await symlink(beta, path.join(folder, "beta"), "dir");
    // A broken repo: git fails, so what's tracked is unknown.
    await writeFile(path.join(cwd, ".git", "HEAD"), "not a ref\n");

    const session = await createCodexSession({ cwd, config: { command: MOCK_APP_SERVER, skillDirs: [alpha, beta] } });
    await session.close();
    expect((await readdir(folder)).sort()).toEqual(["alpha", "beta"]);
  });

  it("times out a stalled one-shot startup, stops the process, and removes the skills", async () => {
    await withTmp(async (scratch) => {
      const pidFile = path.join(await tempDir(), "pid");
      const started = Date.now();
      const result = await executeCodexProvider({
        prompt: "hi",
        cwd: await tempDir(),
        env: { MOCK_CODEX_HANG_METHOD: "initialize", MOCK_PID_FILE: pidFile },
        config: { command: MOCK_APP_SERVER, skillDirs: [await skill(await tempDir(), "alpha")], timeoutSec: 1, graceSec: 1 },
      });
      expect(result).toMatchObject({ status: "timeout", errorCode: "timeout", errorMessage: "Timed out after 1s" });
      expect(Date.now() - started).toBeLessThan(6_000);
      expect(alive(Number(await readFile(pidFile, "utf8")))).toBe(false);
      expect((await readdir(scratch)).filter((name) => name.startsWith("agentex-skills-"))).toEqual([]);
    });
  });

  it("cancels a stalled one-shot startup on the caller's signal", async () => {
    await withTmp(async (scratch) => {
      const pidFile = path.join(await tempDir(), "pid");
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 300);
      const result = await executeCodexProvider({
        prompt: "hi",
        cwd: await tempDir(),
        signal: controller.signal,
        env: { MOCK_CODEX_HANG_METHOD: "initialize", MOCK_PID_FILE: pidFile },
        config: { command: MOCK_APP_SERVER, skillDirs: [await skill(await tempDir(), "alpha")], graceSec: 1 },
      });
      expect(result).toMatchObject({ status: "aborted", errorCode: "aborted" });
      expect(alive(Number(await readFile(pidFile, "utf8")))).toBe(false);
      expect((await readdir(scratch)).filter((name) => name.startsWith("agentex-skills-"))).toEqual([]);
    });
  });

  it("fails a one-shot run whose turn/start Codex rejects, and closes the session", async () => {
    await withTmp(async (scratch) => {
      const pidFile = path.join(await tempDir(), "pid");
      const result = await executeCodexProvider({
        prompt: "hi",
        cwd: await tempDir(),
        env: { MOCK_CODEX_FAIL_METHOD: "turn/start", MOCK_PID_FILE: pidFile },
        config: { command: MOCK_APP_SERVER, skillDirs: [await skill(await tempDir(), "alpha")], graceSec: 1 },
      });
      expect(result).toMatchObject({ status: "failed", errorCode: "turn_start_failed", sessionDisplayId: "mock-thread" });
      expect(alive(Number(await readFile(pidFile, "utf8")))).toBe(false);
      expect((await readdir(scratch)).filter((name) => name.startsWith("agentex-skills-"))).toEqual([]);
    });
  });

  it("translates the codex exec flags a host passed", async () => {
    const cwd = await tempDir();
    const scratch = await tempDir();
    await writeFile(path.join(cwd, "schema.json"), JSON.stringify({ type: "object" }));
    const argsFile = path.join(scratch, "args.txt");
    const requestsFile = path.join(scratch, "requests.jsonl");

    const result = await executeCodexProvider({
      prompt: "hello",
      cwd,
      env: { MOCK_DUMP_ARGS_TO: argsFile, MOCK_DUMP_REQUESTS_TO: requestsFile },
      config: {
        command: MOCK_APP_SERVER,
        skillDirs: [await skill(scratch, "alpha")],
        extraArgs: [
          "-c", 'model_verbosity="low"',
          "-m", "gpt-x", "-s", "workspace-write", "--ephemeral",
          "-i", "pic.png", "--output-schema", "schema.json", "-o", "last.txt",
          "--json", "--skip-git-repo-check", "--color", "never",
        ],
      },
    });

    expect(result).toMatchObject({ status: "completed", model: "gpt-x" });
    const args = await argLines(argsFile);
    expect(args).toEqual(expect.arrayContaining(["-c", 'model_verbosity="low"']));
    for (const dropped of ["--json", "--ephemeral", "-o", "--color", "-i"]) expect(args).not.toContain(dropped);
    const requests = await jsonLines<Request>(requestsFile);
    expect(requests.find((r) => r.method === "thread/start")!.params).toMatchObject({
      approvalPolicy: "never",
      sandbox: "workspace-write",
      ephemeral: true,
    });
    expect(requests.find((r) => r.method === "turn/start")!.params).toMatchObject({
      model: "gpt-x",
      outputSchema: { type: "object" },
      input: [{ type: "text", text: "hello" }, { type: "localImage", path: path.join(cwd, "pic.png") }],
    });
    expect(await readFile(path.join(cwd, "last.txt"), "utf8")).toBe("echo: hello");
  });

  it("fails before starting on an exec flag app-server has no equivalent for", async () => {
    const scratch = await tempDir();
    const argsFile = path.join(scratch, "args.txt");
    const result = await executeCodexProvider({
      prompt: "hi",
      cwd: await tempDir(),
      env: { MOCK_DUMP_ARGS_TO: argsFile },
      config: { command: MOCK_APP_SERVER, skillDirs: [await skill(scratch, "alpha")], extraArgs: ["--add-dir", "/elsewhere"] },
    });
    expect(result).toMatchObject({ status: "failed", errorCode: "unsupported_args" });
    expect(result.errorMessage).toContain("--add-dir");
    expect(await exists(argsFile)).toBe(false);
  });
});

describe("translateCodexExecArgs", () => {
  it("reads inline values, maps the bypass flag, and names what it can't translate", () => {
    expect(translateCodexExecArgs(["--model=gpt-x", "--color=always", "--dangerously-bypass-approvals-and-sandbox", "--image=a.png", "--image", "b.png"]))
      .toEqual({ model: "gpt-x", bypass: true, images: ["a.png", "b.png"], unsupported: [] });
    expect(translateCodexExecArgs(["--sandbox", "nope", "--oss", "--worktree"]).unsupported).toEqual(["--sandbox nope", "--oss", "--worktree"]);
  });
});
