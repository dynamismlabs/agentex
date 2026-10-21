import { afterAll, afterEach, beforeEach, describe, it, expect } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { executePiProvider } from "../../../src/providers/pi/execute.js";
import type { ExecutionContext, StreamEvent } from "../../../src/types.js";

const MOCK_PI = path.resolve(import.meta.dirname, "../../fixtures/mock-pi.sh");
const CWD = process.cwd();

function makeCtx(overrides: Partial<ExecutionContext> = {}): ExecutionContext {
  return {
    runId: "test-pi-run",
    prompt: "Hello pi test",
    cwd: CWD,
    ...overrides,
  };
}

describe("executePiProvider", () => {
  it("handles successful execution", async () => {
    const events: StreamEvent[] = [];
    const outputs: Array<{ stream: string; chunk: string }> = [];

    const result = await executePiProvider(makeCtx({
      config: { command: MOCK_PI },
      env: { MOCK_BEHAVIOR: "success" },
      onEvent: (event) => { events.push(event); },
      onOutput: (stream, chunk) => { outputs.push({ stream, chunk }); },
    }));

    expect(result.exitCode).toBe(0);
    expect(result.status).toBe("completed");
    expect(result.sessionParams).toBeDefined();
    expect(result.summary).toContain("Done");
    expect(result.errorCode).toBeNull();
    expect(result.billingType).toBe("api");
    expect(events.length).toBeGreaterThan(0);
    expect(outputs.length).toBeGreaterThan(0);
  });

  it("handles timeout", async () => {
    const result = await executePiProvider(makeCtx({
      config: { command: MOCK_PI, timeoutSec: 1, graceSec: 1 },
      env: { MOCK_BEHAVIOR: "timeout" },
    }));

    expect(result.status).toBe("timeout");
    expect(result.errorCode).toBe("timeout");
  }, 10_000);

  it("handles generic error", async () => {
    const result = await executePiProvider(makeCtx({
      config: { command: MOCK_PI },
      env: { MOCK_BEHAVIOR: "error" },
    }));

    expect(result.exitCode).not.toBe(0);
  });

  it("handles binary not found", async () => {
    const result = await executePiProvider(makeCtx({
      config: { command: "/nonexistent/pi-binary" },
    }));

    expect(result.errorCode).toBe("binary_not_found");
  });
});

describe("executePiProvider skills", () => {
  const originalHome = process.env.HOME;
  const tempDirs: string[] = [];
  let home: string;

  const tempDir = async (): Promise<string> => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agentex-pi-skills-"));
    tempDirs.push(dir);
    return dir;
  };

  beforeEach(async () => {
    // The legacy-link cleanup reads the home folder; keep it off the real one.
    home = await tempDir();
    process.env.HOME = home;
  });

  afterEach(() => {
    process.env.HOME = originalHome;
  });

  afterAll(async () => {
    await Promise.all(tempDirs.map((dir) => fs.rm(dir, { recursive: true, force: true })));
  });

  async function skill(parent: string, name: string): Promise<string> {
    const dir = path.join(parent, name);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${name} skill\n---\n`);
    return dir;
  }

  async function argsOf(file: string): Promise<string[]> {
    const [line] = (await fs.readFile(file, "utf8")).trim().split("\n");
    return JSON.parse(line!) as string[];
  }

  it("passes each skill folder with its own --skill and writes nothing global", async () => {
    const parent = await tempDir();
    const alpha = await skill(parent, "alpha");
    const beta = await skill(parent, "beta");
    const argsFile = path.join(parent, "args.jsonl");

    const result = await executePiProvider(makeCtx({
      config: { command: MOCK_PI, skillDirs: [alpha, beta, alpha], extraArgs: ["--host-flag"] },
      env: { MOCK_BEHAVIOR: "success", MOCK_DUMP_ARGS_TO: argsFile },
    }));

    expect(result.status).toBe("completed");
    const args = await argsOf(argsFile);
    const skillArgs = args.flatMap((arg, i) => (args[i - 1] === "--skill" ? [arg] : []));
    expect(skillArgs).toEqual([alpha, beta]);
    expect(args.at(-1)).toBe("--host-flag");
    await expect(fs.access(path.join(home, ".pi", "agent"))).rejects.toThrow();
  });

  it("removes the links older versions left in ~/.pi/agent/skills, and none of the user's", async () => {
    const parent = await tempDir();
    const alpha = await skill(parent, "alpha");
    const other = await skill(parent, "other");
    const legacy = path.join(home, ".pi", "agent", "skills");
    await fs.mkdir(legacy, { recursive: true });
    await fs.symlink(alpha, path.join(legacy, "alpha"), "dir");
    await fs.symlink(other, path.join(legacy, "other"), "dir");
    await fs.symlink(path.join(parent, "renamed-away"), path.join(legacy, "renamed"), "dir");
    // Someone's own skill on a drive that isn't mounted right now: not agentex's to remove.
    await fs.symlink(path.join(home, "Volumes", "external", "theirs"), path.join(legacy, "theirs"), "dir");
    await skill(legacy, "mine");

    await executePiProvider(makeCtx({
      config: { command: MOCK_PI, skillDirs: [alpha] },
      env: { MOCK_BEHAVIOR: "success" },
    }));

    expect((await fs.readdir(legacy)).sort()).toEqual(["mine", "other", "theirs"]);
  });

  it("passes no --skill without skills", async () => {
    const argsFile = path.join(await tempDir(), "args.jsonl");
    await executePiProvider(makeCtx({
      config: { command: MOCK_PI, skillDirs: [] },
      env: { MOCK_BEHAVIOR: "success", MOCK_DUMP_ARGS_TO: argsFile },
    }));
    expect(await argsOf(argsFile)).not.toContain("--skill");
  });
});
