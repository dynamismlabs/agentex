import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import {
  resolveInstructions,
  installInstructions,
  removeInstructions,
  resolveInstructionTargets,
  upsertManagedBlock,
  stripManagedBlock,
} from "../../src/utils/instructions.js";

// ---------------------------------------------------------------------------
// resolveInstructions (read)
// ---------------------------------------------------------------------------

describe("resolveInstructions", () => {
  const tempFiles: string[] = [];

  afterEach(async () => {
    for (const f of tempFiles) {
      try {
        await fs.unlink(f);
      } catch {
        // ignore
      }
    }
    tempFiles.length = 0;
  });

  it("returns null when filePath is undefined", async () => {
    const result = await resolveInstructions(undefined);
    expect(result).toBeNull();
  });

  it("returns null when filePath is empty string", async () => {
    const result = await resolveInstructions("");
    expect(result).toBeNull();
  });

  it("returns file content when file exists", async () => {
    const tmpFile = path.join(os.tmpdir(), `agentex-test-instructions-${Date.now()}.txt`);
    tempFiles.push(tmpFile);
    await fs.writeFile(tmpFile, "You are a helpful assistant.", "utf-8");

    const result = await resolveInstructions(tmpFile);
    expect(result).toBe("You are a helpful assistant.");
  });

  it("throws a clear error when file does not exist (ENOENT)", async () => {
    const missing = path.join(os.tmpdir(), `agentex-nonexistent-${Date.now()}.txt`);
    await expect(resolveInstructions(missing)).rejects.toThrow(
      `Instructions file not found: ${missing}`,
    );
  });

  it("re-throws non-ENOENT errors", async () => {
    // Reading a directory as a file triggers EISDIR on most platforms
    const tmpDir = path.join(os.tmpdir(), `agentex-test-dir-${Date.now()}`);
    await fs.mkdir(tmpDir, { recursive: true });
    tempFiles.push(tmpDir); // cleanup won't unlink a dir, but that's fine

    await expect(resolveInstructions(tmpDir)).rejects.toThrow();
    // Ensure it's NOT the "Instructions file not found" wrapper
    try {
      await resolveInstructions(tmpDir);
    } catch (err) {
      expect((err as Error).message).not.toContain("Instructions file not found");
    }
  });
});

// ---------------------------------------------------------------------------
// resolveInstructionTargets (pure path resolution)
// ---------------------------------------------------------------------------

describe("resolveInstructionTargets", () => {
  const cwd = "/projects/my-app";

  it("workspace default → CLAUDE.md + AGENTS.md once each", () => {
    const targets = resolveInstructionTargets({ location: "workspace", cwd });
    const byFile = Object.fromEntries(targets.map((t) => [t.filename, t]));

    expect(Object.keys(byFile).sort()).toEqual(["AGENTS.md", "CLAUDE.md"]);
    expect(byFile["CLAUDE.md"]!.targetPath).toBe(path.join(cwd, "CLAUDE.md"));
    expect(byFile["AGENTS.md"]!.targetPath).toBe(path.join(cwd, "AGENTS.md"));
    // CLAUDE.md serves claude; AGENTS.md serves everyone else.
    expect(byFile["CLAUDE.md"]!.runtimes).toEqual(["claude"]);
    expect(byFile["AGENTS.md"]!.runtimes.sort()).toEqual(
      ["codex", "cursor", "gemini", "opencode", "pi"].sort(),
    );
  });

  it("workspace dedupes AGENTS.md across multiple runtimes", () => {
    const targets = resolveInstructionTargets({
      location: "workspace",
      cwd,
      runtimes: ["codex", "opencode", "cursor"],
    });
    expect(targets).toHaveLength(1);
    expect(targets[0]!.filename).toBe("AGENTS.md");
    expect(targets[0]!.runtimes.sort()).toEqual(["codex", "cursor", "opencode"]);
  });

  it("includeNativeFiles adds GEMINI.md alongside AGENTS.md", () => {
    const targets = resolveInstructionTargets({
      location: "workspace",
      cwd,
      runtimes: ["gemini"],
      includeNativeFiles: true,
    });
    const files = targets.map((t) => t.filename).sort();
    expect(files).toEqual(["AGENTS.md", "GEMINI.md"]);
  });

  it("includeNativeFiles is a no-op for runtimes whose native file is the standard", () => {
    const targets = resolveInstructionTargets({
      location: "workspace",
      cwd,
      runtimes: ["codex"],
      includeNativeFiles: true,
    });
    expect(targets.map((t) => t.filename)).toEqual(["AGENTS.md"]);
  });

  it("throws for workspace without cwd", () => {
    expect(() => resolveInstructionTargets({ location: "workspace" })).toThrow("cwd is required");
  });

  it("global → one native file per runtime in its home dir", () => {
    const home = "/home/test";
    const targets = resolveInstructionTargets({ location: "global", homeDir: home });
    const byPath = Object.fromEntries(targets.map((t) => [t.targetPath, t]));

    expect(byPath[path.join(home, ".claude", "CLAUDE.md")]).toBeDefined();
    expect(byPath[path.join(home, ".codex", "AGENTS.md")]).toBeDefined();
    expect(byPath[path.join(home, ".gemini", "GEMINI.md")]).toBeDefined();
    expect(byPath[path.join(home, ".config", "opencode", "AGENTS.md")]).toBeDefined();
    expect(byPath[path.join(home, ".pi", "AGENTS.md")]).toBeDefined();
  });

  it("global omits cursor (no file-based global config)", () => {
    const targets = resolveInstructionTargets({ location: "global", homeDir: "/home/test" });
    expect(targets.some((t) => t.runtimes.includes("cursor"))).toBe(false);
    // 6 runtimes minus cursor = 5 files.
    expect(targets).toHaveLength(5);
  });
});

// ---------------------------------------------------------------------------
// upsertManagedBlock / stripManagedBlock (pure merge logic)
// ---------------------------------------------------------------------------

describe("upsertManagedBlock", () => {
  it("creates a block from null", () => {
    const result = upsertManagedBlock(null, "hello");
    expect(result).toContain("<!-- agentex:managed:start");
    expect(result).toContain("<!-- agentex:managed:end -->");
    expect(result).toContain("hello");
  });

  it("embeds a content hash in the start marker", () => {
    const result = upsertManagedBlock(null, "hello");
    expect(result).toMatch(/<!-- agentex:managed:start hash=[0-9a-f]{12} -->/);
  });

  it("replaces only the managed region, preserving content outside", () => {
    const original = upsertManagedBlock(null, "v1") + "\n# User notes\nkeep me\n";
    const updated = upsertManagedBlock(original, "v2");
    expect(updated).toContain("v2");
    expect(updated).not.toContain("v1");
    expect(updated).toContain("# User notes");
    expect(updated).toContain("keep me");
  });

  it("prepends to a marker-less file, keeping prior content below", () => {
    const existing = "# My existing AGENTS.md\nsome rules\n";
    const result = upsertManagedBlock(existing, "managed brief");
    expect(result.indexOf("managed brief")).toBeLessThan(result.indexOf("My existing AGENTS.md"));
    expect(result).toContain("some rules");
  });

  it("is idempotent — re-upserting identical content yields identical bytes", () => {
    const once = upsertManagedBlock(null, "stable content");
    const twice = upsertManagedBlock(once, "stable content");
    expect(twice).toBe(once);
  });

  it("idempotent through the prepend path too", () => {
    const existing = "user stuff\n";
    const once = upsertManagedBlock(existing, "brief");
    const twice = upsertManagedBlock(once, "brief");
    expect(twice).toBe(once);
  });

  it("supports a custom tag", () => {
    const result = upsertManagedBlock(null, "x", { tag: "flow" });
    expect(result).toContain("<!-- flow:managed:start");
    expect(result).toContain("<!-- flow:managed:end -->");
  });

  it("independent tags don't fight over one region", () => {
    const a = upsertManagedBlock(null, "from-a", { tag: "a" });
    const both = upsertManagedBlock(a, "from-b", { tag: "b" });
    // updating tag b leaves tag a's block intact
    const reUpsertA = upsertManagedBlock(both, "from-a", { tag: "a" });
    expect(reUpsertA).toContain("from-a");
    expect(reUpsertA).toContain("from-b");
  });
});

describe("stripManagedBlock", () => {
  it("removes the managed region, preserving user content", () => {
    const content = upsertManagedBlock(null, "brief") + "\n# user\nkeep\n";
    const stripped = stripManagedBlock(content);
    expect(stripped).not.toBeNull();
    expect(stripped).not.toContain("brief");
    expect(stripped).toContain("# user");
    expect(stripped).toContain("keep");
  });

  it("returns null when only the managed block remains", () => {
    const content = upsertManagedBlock(null, "brief");
    expect(stripManagedBlock(content)).toBeNull();
  });

  it("returns the original string when there is no managed region", () => {
    const content = "# just a user file\n";
    expect(stripManagedBlock(content)).toBe(content);
  });
});

// ---------------------------------------------------------------------------
// installInstructions (workspace)
// ---------------------------------------------------------------------------

describe("installInstructions (workspace)", () => {
  const tmpDirs: string[] = [];

  afterEach(async () => {
    for (const dir of tmpDirs) {
      try {
        await fs.rm(dir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
    tmpDirs.length = 0;
  });

  async function mkCwd(): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "install-instr-"));
    tmpDirs.push(dir);
    return dir;
  }

  it("default writes CLAUDE.md + AGENTS.md, both with the managed block", async () => {
    const cwd = await mkCwd();
    const result = await installInstructions("orientation brief", { location: "workspace", cwd });

    expect(result.installed).toBe(2);
    expect(result.errors).toBe(0);

    const claude = await fs.readFile(path.join(cwd, "CLAUDE.md"), "utf-8");
    const agents = await fs.readFile(path.join(cwd, "AGENTS.md"), "utf-8");
    expect(claude).toContain("orientation brief");
    expect(claude).toContain("agentex:managed:start");
    expect(agents).toContain("orientation brief");
  });

  it("is idempotent — re-install with same content reports all skipped", async () => {
    const cwd = await mkCwd();
    await installInstructions("brief", { location: "workspace", cwd });
    const second = await installInstructions("brief", { location: "workspace", cwd });

    expect(second.skipped).toBe(2);
    expect(second.installed).toBe(0);
    expect(second.updated).toBe(0);
  });

  it("user content outside the markers survives a changed re-install", async () => {
    const cwd = await mkCwd();
    await installInstructions("v1", { location: "workspace", cwd });

    // User appends their own content below the managed block.
    const agentsPath = path.join(cwd, "AGENTS.md");
    const withUser = (await fs.readFile(agentsPath, "utf-8")) + "\n# user-owned\nhand-written rule\n";
    await fs.writeFile(agentsPath, withUser);

    const result = await installInstructions("v2", { location: "workspace", cwd });
    expect(result.updated).toBeGreaterThanOrEqual(1);

    const after = await fs.readFile(agentsPath, "utf-8");
    expect(after).toContain("v2");
    expect(after).not.toContain("v1");
    expect(after).toContain("# user-owned");
    expect(after).toContain("hand-written rule");
  });

  it("a pre-existing marker-less file is preserved below a freshly-prepended block", async () => {
    const cwd = await mkCwd();
    const agentsPath = path.join(cwd, "AGENTS.md");
    await fs.writeFile(agentsPath, "# pre-existing\nmy rules\n");

    const result = await installInstructions("brief", {
      location: "workspace",
      cwd,
      runtimes: ["codex"],
    });
    expect(result.updated).toBe(1);

    const after = await fs.readFile(agentsPath, "utf-8");
    expect(after.indexOf("brief")).toBeLessThan(after.indexOf("# pre-existing"));
    expect(after).toContain("my rules");
  });

  it("managed:false overwrites the whole file", async () => {
    const cwd = await mkCwd();
    const agentsPath = path.join(cwd, "AGENTS.md");
    await fs.writeFile(agentsPath, "# old content\n");

    await installInstructions("brand new", {
      location: "workspace",
      cwd,
      runtimes: ["codex"],
      managed: false,
    });

    const after = await fs.readFile(agentsPath, "utf-8");
    expect(after).toBe("brand new\n");
    expect(after).not.toContain("managed:start");
    expect(after).not.toContain("# old content");
  });

  it("includeNativeFiles also writes GEMINI.md", async () => {
    const cwd = await mkCwd();
    const result = await installInstructions("brief", {
      location: "workspace",
      cwd,
      runtimes: ["gemini"],
      includeNativeFiles: true,
    });

    expect(result.installed).toBe(2); // AGENTS.md + GEMINI.md
    const gemini = await fs.readFile(path.join(cwd, "GEMINI.md"), "utf-8");
    expect(gemini).toContain("brief");
  });

  it("reports an error entry when a target path is a directory", async () => {
    const cwd = await mkCwd();
    // Make AGENTS.md a directory so writing/reading it fails.
    await fs.mkdir(path.join(cwd, "AGENTS.md"), { recursive: true });

    const result = await installInstructions("brief", {
      location: "workspace",
      cwd,
      runtimes: ["codex"],
    });
    expect(result.errors).toBe(1);
    expect(result.entries[0]!.status).toBe("error");
    expect(result.entries[0]!.error).toBeTruthy();
  });

  it("throws for workspace without cwd", async () => {
    await expect(installInstructions("brief", { location: "workspace" })).rejects.toThrow(
      "cwd is required",
    );
  });
});

// ---------------------------------------------------------------------------
// installInstructions (global) — sandboxed via homeDir override
// ---------------------------------------------------------------------------

describe("installInstructions (global)", () => {
  const tmpDirs: string[] = [];

  afterEach(async () => {
    for (const dir of tmpDirs) {
      try {
        await fs.rm(dir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
    tmpDirs.length = 0;
  });

  async function mkHome(): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "install-home-"));
    tmpDirs.push(dir);
    return dir;
  }

  it("writes one native file per runtime in its home dir, skipping cursor", async () => {
    const home = await mkHome();
    const result = await installInstructions("global brief", { location: "global", homeDir: home });

    expect(result.installed).toBe(5); // all but cursor
    expect(result.errors).toBe(0);

    expect(await fs.readFile(path.join(home, ".claude", "CLAUDE.md"), "utf-8")).toContain(
      "global brief",
    );
    expect(await fs.readFile(path.join(home, ".codex", "AGENTS.md"), "utf-8")).toContain(
      "global brief",
    );
    expect(await fs.readFile(path.join(home, ".gemini", "GEMINI.md"), "utf-8")).toContain(
      "global brief",
    );
    expect(
      await fs.readFile(path.join(home, ".config", "opencode", "AGENTS.md"), "utf-8"),
    ).toContain("global brief");
    expect(await fs.readFile(path.join(home, ".pi", "AGENTS.md"), "utf-8")).toContain("global brief");

    // cursor has no file-based global config → nothing written.
    let cursorExists = true;
    try {
      await fs.access(path.join(home, ".cursor"));
    } catch {
      cursorExists = false;
    }
    expect(cursorExists).toBe(false);
  });

  it("respects a runtimes subset", async () => {
    const home = await mkHome();
    const result = await installInstructions("x", {
      location: "global",
      homeDir: home,
      runtimes: ["claude", "codex"],
    });
    expect(result.installed).toBe(2);
    expect(result.entries.map((e) => e.filename).sort()).toEqual(["AGENTS.md", "CLAUDE.md"]);
  });
});

// ---------------------------------------------------------------------------
// removeInstructions
// ---------------------------------------------------------------------------

describe("removeInstructions", () => {
  const tmpDirs: string[] = [];

  afterEach(async () => {
    for (const dir of tmpDirs) {
      try {
        await fs.rm(dir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
    tmpDirs.length = 0;
  });

  async function mkCwd(): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "remove-instr-"));
    tmpDirs.push(dir);
    return dir;
  }

  it("removes the managed block but preserves user content", async () => {
    const cwd = await mkCwd();
    await installInstructions("brief", { location: "workspace", cwd, runtimes: ["codex"] });

    const agentsPath = path.join(cwd, "AGENTS.md");
    await fs.writeFile(agentsPath, (await fs.readFile(agentsPath, "utf-8")) + "\n# mine\nkeep\n");

    const result = await removeInstructions({ location: "workspace", cwd, runtimes: ["codex"] });
    expect(result.removed).toBe(1);

    const after = await fs.readFile(agentsPath, "utf-8");
    expect(after).not.toContain("brief");
    expect(after).toContain("# mine");
    expect(after).toContain("keep");
  });

  it("deletes the file when only the managed block remains", async () => {
    const cwd = await mkCwd();
    await installInstructions("brief", { location: "workspace", cwd, runtimes: ["codex"] });

    const result = await removeInstructions({ location: "workspace", cwd, runtimes: ["codex"] });
    expect(result.removed).toBe(1);

    let exists = true;
    try {
      await fs.access(path.join(cwd, "AGENTS.md"));
    } catch {
      exists = false;
    }
    expect(exists).toBe(false);
  });

  it("reports not_found when no file exists", async () => {
    const cwd = await mkCwd();
    const result = await removeInstructions({ location: "workspace", cwd, runtimes: ["codex"] });
    expect(result.removed).toBe(0);
    expect(result.entries[0]!.status).toBe("not_found");
  });

  it("never touches a user-owned file without a managed region", async () => {
    const cwd = await mkCwd();
    const agentsPath = path.join(cwd, "AGENTS.md");
    await fs.writeFile(agentsPath, "# purely user-owned\n");

    const result = await removeInstructions({ location: "workspace", cwd, runtimes: ["codex"] });
    expect(result.removed).toBe(0);
    expect(result.entries[0]!.status).toBe("skipped");
    expect(await fs.readFile(agentsPath, "utf-8")).toBe("# purely user-owned\n");
  });

  it("round-trips: install → remove leaves a clean tree", async () => {
    const cwd = await mkCwd();
    await installInstructions("brief", { location: "workspace", cwd });
    const removed = await removeInstructions({ location: "workspace", cwd });
    expect(removed.removed).toBe(2);

    for (const f of ["CLAUDE.md", "AGENTS.md"]) {
      let exists = true;
      try {
        await fs.access(path.join(cwd, f));
      } catch {
        exists = false;
      }
      expect(exists).toBe(false);
    }
  });
});
