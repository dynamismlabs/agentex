import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import {
  buildSkillsDir,
  cleanupSkillsDir,
  resolveSkillsHome,
  resolveSkillsWorkspace,
  resolveNativeSkillsHome,
  resolveNativeSkillsWorkspace,
  ensureSkillSymlink,
  installSkills,
  removeSkills,
  listInstalledSkills,
  removeLegacySkillLinks,
} from "../../src/utils/skills.js";

// ---------------------------------------------------------------------------
// buildSkillsDir / cleanupSkillsDir (internal helpers for provider execution)
// ---------------------------------------------------------------------------

describe("buildSkillsDir", () => {
  const tmpDirs: string[] = [];
  let testSkillDir: string;

  async function createTestSkillDir(): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "test-skill-"));
    await fs.writeFile(path.join(dir, "SKILL.md"), "# Test Skill");
    tmpDirs.push(dir);
    return dir;
  }

  afterEach(async () => {
    for (const dir of tmpDirs) {
      try { await fs.rm(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
    tmpDirs.length = 0;
  });

  it("creates Claude skill dir structure", async () => {
    testSkillDir = await createTestSkillDir();
    const tmpDir = await buildSkillsDir([testSkillDir], "claude");
    tmpDirs.push(tmpDir);

    const skillName = path.basename(testSkillDir);
    const symlinkPath = path.join(tmpDir, ".claude", "skills", skillName);

    const stat = await fs.lstat(symlinkPath);
    expect(stat.isSymbolicLink()).toBe(true);

    const target = await fs.readlink(symlinkPath);
    expect(target).toBe(testSkillDir);
  });

  it("creates Codex skill dir structure", async () => {
    testSkillDir = await createTestSkillDir();
    const tmpDir = await buildSkillsDir([testSkillDir], "codex");
    tmpDirs.push(tmpDir);

    const skillName = path.basename(testSkillDir);
    const symlinkPath = path.join(tmpDir, "skills", skillName);

    const stat = await fs.lstat(symlinkPath);
    expect(stat.isSymbolicLink()).toBe(true);
  });

  it("creates Antigravity skill dir structure, the .agents/skills agy reads in an added folder", async () => {
    testSkillDir = await createTestSkillDir();
    const tmpDir = await buildSkillsDir([testSkillDir], "antigravity");
    tmpDirs.push(tmpDir);

    const symlinkPath = path.join(tmpDir, ".agents", "skills", path.basename(testSkillDir));
    expect((await fs.lstat(symlinkPath)).isSymbolicLink()).toBe(true);
    expect(await fs.readlink(symlinkPath)).toBe(testSkillDir);
  });

  it("links a relative skill dir by its absolute path", async () => {
    testSkillDir = await createTestSkillDir();
    const tmpDir = await buildSkillsDir([path.relative(process.cwd(), testSkillDir)], "claude");
    tmpDirs.push(tmpDir);

    const symlinkPath = path.join(tmpDir, ".claude", "skills", path.basename(testSkillDir));
    expect(await fs.readlink(symlinkPath)).toBe(testSkillDir);
    expect(await fs.readFile(path.join(symlinkPath, "SKILL.md"), "utf-8")).toBe("# Test Skill");
  });

  it("creates multiple symlinks", async () => {
    const skill1 = await createTestSkillDir();
    const skill2 = await createTestSkillDir();
    const tmpDir = await buildSkillsDir([skill1, skill2], "claude");
    tmpDirs.push(tmpDir);

    const entries = await fs.readdir(path.join(tmpDir, ".claude", "skills"));
    expect(entries.length).toBe(2);
  });

  it("warns but does not throw for non-existent skill dir", async () => {
    const tmpDir = await buildSkillsDir(["/nonexistent/path/skill"], "claude");
    tmpDirs.push(tmpDir);
  });
});

describe("cleanupSkillsDir", () => {
  it("removes the temp directory", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "cleanup-test-"));
    await cleanupSkillsDir(tmpDir);
    let exists = true;
    try { await fs.access(tmpDir); } catch { exists = false; }
    expect(exists).toBe(false);
  });

  it("does not throw on non-existent dir", async () => {
    await expect(cleanupSkillsDir("/nonexistent/cleanup")).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Path resolvers
// ---------------------------------------------------------------------------

describe("resolveSkillsHome", () => {
  it("returns ~/.agents/skills for agents channel", () => {
    expect(resolveSkillsHome("agents")).toBe(path.join(os.homedir(), ".agents", "skills"));
  });

  it("returns ~/.claude/skills for claude channel", () => {
    expect(resolveSkillsHome("claude")).toBe(path.join(os.homedir(), ".claude", "skills"));
  });
});

describe("resolveSkillsWorkspace", () => {
  const cwd = "/projects/my-app";

  it("returns {cwd}/.agents/skills for agents channel", () => {
    expect(resolveSkillsWorkspace("agents", cwd)).toBe(path.join(cwd, ".agents", "skills"));
  });

  it("returns {cwd}/.claude/skills for claude channel", () => {
    expect(resolveSkillsWorkspace("claude", cwd)).toBe(path.join(cwd, ".claude", "skills"));
  });
});

describe("resolveNativeSkillsHome", () => {
  it("returns ~/.gemini/skills for gemini", () => {
    expect(resolveNativeSkillsHome("gemini")).toBe(path.join(os.homedir(), ".gemini", "skills"));
  });

  it("returns ~/.cursor/skills for cursor", () => {
    expect(resolveNativeSkillsHome("cursor")).toBe(path.join(os.homedir(), ".cursor", "skills"));
  });

  it("returns ~/.config/opencode/skills for opencode", () => {
    expect(resolveNativeSkillsHome("opencode")).toBe(path.join(os.homedir(), ".config", "opencode", "skills"));
  });

  it("returns ~/.pi/agent/skills for pi", () => {
    expect(resolveNativeSkillsHome("pi")).toBe(path.join(os.homedir(), ".pi", "agent", "skills"));
  });

  it("returns ~/.gemini/config/skills for antigravity, the global folder agy gives the agent", () => {
    expect(resolveNativeSkillsHome("antigravity")).toBe(path.join(os.homedir(), ".gemini", "config", "skills"));
  });

  it("returns null for claude (uses standard channel)", () => {
    expect(resolveNativeSkillsHome("claude")).toBeNull();
  });

  it("returns null for codex (uses standard channel)", () => {
    expect(resolveNativeSkillsHome("codex")).toBeNull();
  });
});

describe("resolveNativeSkillsWorkspace", () => {
  const cwd = "/projects/my-app";

  it("returns {cwd}/.gemini/skills for gemini", () => {
    expect(resolveNativeSkillsWorkspace("gemini", cwd)).toBe(path.join(cwd, ".gemini", "skills"));
  });

  it("returns {cwd}/.opencode/skills for opencode", () => {
    expect(resolveNativeSkillsWorkspace("opencode", cwd)).toBe(path.join(cwd, ".opencode", "skills"));
  });

  it("returns {cwd}/.pi/skills for pi", () => {
    expect(resolveNativeSkillsWorkspace("pi", cwd)).toBe(path.join(cwd, ".pi", "skills"));
  });

  it("returns the standard {cwd}/.agents/skills channel for antigravity", () => {
    expect(resolveNativeSkillsWorkspace("antigravity", cwd)).toBe(path.join(cwd, ".agents", "skills"));
  });

  it("returns null for claude", () => {
    expect(resolveNativeSkillsWorkspace("claude", cwd)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// ensureSkillSymlink
// ---------------------------------------------------------------------------

describe("ensureSkillSymlink", () => {
  const tmpDirs: string[] = [];

  afterEach(async () => {
    for (const dir of tmpDirs) {
      try { await fs.rm(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
    tmpDirs.length = 0;
  });

  it("creates symlink when target doesn't exist", async () => {
    const sourceDir = await fs.mkdtemp(path.join(os.tmpdir(), "symlink-src-"));
    const parentDir = await fs.mkdtemp(path.join(os.tmpdir(), "symlink-parent-"));
    tmpDirs.push(sourceDir, parentDir);

    const target = path.join(parentDir, "my-skill");
    const result = await ensureSkillSymlink(sourceDir, target);
    expect(result).toBe("created");

    const stat = await fs.lstat(target);
    expect(stat.isSymbolicLink()).toBe(true);
  });

  it("skips when symlink already points to same source", async () => {
    const sourceDir = await fs.mkdtemp(path.join(os.tmpdir(), "symlink-src-"));
    const parentDir = await fs.mkdtemp(path.join(os.tmpdir(), "symlink-parent-"));
    tmpDirs.push(sourceDir, parentDir);

    const target = path.join(parentDir, "my-skill");
    await fs.symlink(sourceDir, target, "dir");

    const result = await ensureSkillSymlink(sourceDir, target);
    expect(result).toBe("skipped");
  });

  it("reports conflict when symlink points elsewhere", async () => {
    const sourceDir = await fs.mkdtemp(path.join(os.tmpdir(), "symlink-src-"));
    const otherDir = await fs.mkdtemp(path.join(os.tmpdir(), "symlink-other-"));
    const parentDir = await fs.mkdtemp(path.join(os.tmpdir(), "symlink-parent-"));
    tmpDirs.push(sourceDir, otherDir, parentDir);

    const target = path.join(parentDir, "my-skill");
    await fs.symlink(otherDir, target, "dir");

    const result = await ensureSkillSymlink(sourceDir, target);
    expect(result).toBe("conflict");
  });

  it("reports conflict when target is a real directory", async () => {
    const sourceDir = await fs.mkdtemp(path.join(os.tmpdir(), "symlink-src-"));
    const parentDir = await fs.mkdtemp(path.join(os.tmpdir(), "symlink-parent-"));
    tmpDirs.push(sourceDir, parentDir);

    const target = path.join(parentDir, "my-skill");
    await fs.mkdir(target, { recursive: true });

    const result = await ensureSkillSymlink(sourceDir, target);
    expect(result).toBe("conflict");
  });
});

// ---------------------------------------------------------------------------
// Public API: installSkills
// ---------------------------------------------------------------------------

describe("installSkills", () => {
  const tmpDirs: string[] = [];

  async function createSkillDir(name: string): Promise<string> {
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), "install-skills-"));
    const dir = path.join(parent, name);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "SKILL.md"), `# ${name}`);
    tmpDirs.push(parent);
    return dir;
  }

  afterEach(async () => {
    for (const dir of tmpDirs) {
      try { await fs.rm(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
    tmpDirs.length = 0;
  });

  it("installs into both standard channels (workspace)", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "install-cwd-"));
    const skill = await createSkillDir("my-skill");
    tmpDirs.push(cwd);

    const result = await installSkills([skill], { location: "workspace", cwd });

    expect(result.installed).toBe(2); // .agents + .claude
    expect(result.errors).toBe(0);

    const agentsLink = path.join(cwd, ".agents", "skills", "my-skill");
    const claudeLink = path.join(cwd, ".claude", "skills", "my-skill");
    expect((await fs.lstat(agentsLink)).isSymbolicLink()).toBe(true);
    expect((await fs.lstat(claudeLink)).isSymbolicLink()).toBe(true);
  });

  it("installs into both standard channels (global)", async () => {
    // We can't easily test real home dirs, so test workspace as a proxy
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "install-cwd-"));
    const skill = await createSkillDir("global-skill");
    tmpDirs.push(cwd);

    const result = await installSkills([skill], { location: "workspace", cwd });
    expect(result.installed).toBe(2);
    expect(result.entries.map((e) => e.target).sort()).toEqual(["agents", "claude"]);
  });

  it("is idempotent — second install returns skipped", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "install-cwd-"));
    const skill = await createSkillDir("idem-skill");
    tmpDirs.push(cwd);

    const first = await installSkills([skill], { location: "workspace", cwd });
    expect(first.installed).toBe(2);

    const second = await installSkills([skill], { location: "workspace", cwd });
    expect(second.skipped).toBe(2);
    expect(second.installed).toBe(0);
  });

  it("reports conflicts for existing different symlinks", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "install-cwd-"));
    const skill1 = await createSkillDir("conflict-skill");
    const skill2 = await createSkillDir("conflict-skill");
    tmpDirs.push(cwd);

    await installSkills([skill1], { location: "workspace", cwd });
    const result = await installSkills([skill2], { location: "workspace", cwd });
    expect(result.conflicts).toBe(2); // both channels conflict
  });

  it("handles empty skillDirs", async () => {
    const result = await installSkills([]);
    expect(result.installed).toBe(0);
    expect(result.entries.length).toBe(0);
  });

  it("handles multiple skills", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "install-cwd-"));
    const s1 = await createSkillDir("skill-1");
    const s2 = await createSkillDir("skill-2");
    tmpDirs.push(cwd);

    const result = await installSkills([s1, s2], { location: "workspace", cwd });
    expect(result.installed).toBe(4); // 2 skills × 2 channels
  });

  it("throws when workspace location without cwd", async () => {
    const skill = await createSkillDir("no-cwd");
    await expect(
      installSkills([skill], { location: "workspace" }),
    ).rejects.toThrow("cwd is required");
  });

  it("includes native dirs when includeNativeDirs is true", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "install-native-"));
    const skill = await createSkillDir("native-skill");
    tmpDirs.push(cwd);

    const result = await installSkills([skill], {
      location: "workspace",
      cwd,
      includeNativeDirs: true,
    });

    // 2 standard + 4 native (gemini, cursor, opencode, pi). Antigravity's
    // workspace folder is the standard .agents/skills channel, so it is not
    // installed (or reported) twice.
    expect(result.installed).toBe(6);
    expect(new Set(result.entries.map((e) => e.targetPath)).size).toBe(result.entries.length);

    const targets = result.entries.map((e) => e.target).sort();
    expect(targets).toEqual(["agents", "claude", "cursor", "gemini", "opencode", "pi"]);

    // Verify a native dir was created
    const geminiLink = path.join(cwd, ".gemini", "skills", "native-skill");
    expect((await fs.lstat(geminiLink)).isSymbolicLink()).toBe(true);
  });

  it("installs into exactly the folders named, once each, ignoring location", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "install-folders-"));
    tmpDirs.push(root);
    const skill = await createSkillDir("folder-skill");
    const a = path.join(root, "a", "skills");
    const b = path.join(root, "b", "skills");

    const result = await installSkills([skill], {
      folders: [a, b, path.join(b, "..", "skills")],
      location: "workspace",
      includeNativeDirs: true,
    });

    expect(result.installed).toBe(2);
    expect(result.entries.map((e) => [e.target, e.targetPath])).toEqual([
      [a, path.join(a, "folder-skill")],
      [b, path.join(b, "folder-skill")],
    ]);
    expect(await fs.readlink(path.join(a, "folder-skill"))).toBe(skill);
    // Nothing went to the standard channels.
    await expect(fs.access(path.join(root, ".agents"))).rejects.toThrow();
  });

  it("reports a folder it can't make as errors for that folder, and installs the rest", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "install-folders-"));
    tmpDirs.push(root);
    const skill = await createSkillDir("blocked-skill");
    const file = path.join(root, "not-a-folder");
    await fs.writeFile(file, "");
    const blocked = path.join(file, "skills");
    const good = path.join(root, "good");

    const result = await installSkills([skill], { folders: [blocked, good] });

    expect(result.errors).toBe(1);
    expect(result.installed).toBe(1);
    expect(result.entries[0]).toMatchObject({ target: blocked, skillName: "blocked-skill", status: "error" });
    expect(result.entries[0]!.error).toMatch(/ENOTDIR|EEXIST/);
    expect(await fs.readlink(path.join(good, "blocked-skill"))).toBe(skill);
  });

  it("reports a dead link at a skill's name as a conflict by default", async () => {
    const folder = await fs.mkdtemp(path.join(os.tmpdir(), "install-dead-"));
    tmpDirs.push(folder);
    const skill = await createSkillDir("dead-skill");
    await fs.symlink(path.join(folder, "gone"), path.join(folder, "dead-skill"), "dir");

    const result = await installSkills([skill], { folders: [folder] });

    expect(result.conflicts).toBe(1);
    expect(await fs.readlink(path.join(folder, "dead-skill"))).toBe(path.join(folder, "gone"));
  });

  it("replaces a dead link with replaceDeadLinks, and leaves anything live", async () => {
    const folder = await fs.mkdtemp(path.join(os.tmpdir(), "install-dead-"));
    tmpDirs.push(folder);
    const dead = await createSkillDir("dead");
    const live = await createSkillDir("live");
    const real = await createSkillDir("real");
    const elsewhere = await createSkillDir("elsewhere");
    await fs.symlink(path.join(folder, "gone"), path.join(folder, "dead"), "dir");
    await fs.symlink(elsewhere, path.join(folder, "live"), "dir");
    await fs.mkdir(path.join(folder, "real"));

    const result = await installSkills([dead, live, real], { folders: [folder], replaceDeadLinks: true });

    expect(Object.fromEntries(result.entries.map((e) => [e.skillName, e.status]))).toEqual({
      dead: "created",
      live: "conflict",
      real: "conflict",
    });
    expect(await fs.readlink(path.join(folder, "dead"))).toBe(dead);
    expect(await fs.readlink(path.join(folder, "live"))).toBe(elsewhere);
    expect((await fs.lstat(path.join(folder, "real"))).isDirectory()).toBe(true);
  });

  it("keeps an existing link to the skill itself with replaceDeadLinks, even while the skill is missing", async () => {
    const folder = await fs.mkdtemp(path.join(os.tmpdir(), "install-dead-"));
    tmpDirs.push(folder);
    const missing = path.join(folder, "source", "missing-skill");
    await fs.symlink(missing, path.join(folder, "missing-skill"), "dir");

    const result = await installSkills([missing], { folders: [folder], replaceDeadLinks: true });

    expect(result.entries[0]!.status).toBe("skipped");
  });
});

// ---------------------------------------------------------------------------
// Public API: removeSkills
// ---------------------------------------------------------------------------

describe("removeSkills", () => {
  const tmpDirs: string[] = [];

  async function createSkillDir(name: string): Promise<string> {
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), "remove-skills-"));
    const dir = path.join(parent, name);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "SKILL.md"), `# ${name}`);
    tmpDirs.push(parent);
    return dir;
  }

  afterEach(async () => {
    for (const dir of tmpDirs) {
      try { await fs.rm(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
    tmpDirs.length = 0;
  });

  it("removes from both standard channels", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "remove-cwd-"));
    const skill = await createSkillDir("removable");
    tmpDirs.push(cwd);

    await installSkills([skill], { location: "workspace", cwd });
    const result = await removeSkills([skill], { location: "workspace", cwd });

    expect(result.removed).toBe(2);

    const agentsLink = path.join(cwd, ".agents", "skills", "removable");
    const claudeLink = path.join(cwd, ".claude", "skills", "removable");
    let agentsExists = true;
    let claudeExists = true;
    try { await fs.lstat(agentsLink); } catch { agentsExists = false; }
    try { await fs.lstat(claudeLink); } catch { claudeExists = false; }
    expect(agentsExists).toBe(false);
    expect(claudeExists).toBe(false);
  });

  it("returns not_found for skills that aren't installed", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "remove-cwd-"));
    const skill = await createSkillDir("missing");
    tmpDirs.push(cwd);

    const result = await removeSkills([skill], { location: "workspace", cwd });
    expect(result.removed).toBe(0);
    expect(result.entries.every((e) => e.status === "not_found")).toBe(true);
  });

  it("refuses to remove symlinks pointing to different sources", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "remove-cwd-"));
    const skill1 = await createSkillDir("guarded");
    const skill2 = await createSkillDir("guarded");
    tmpDirs.push(cwd);

    await installSkills([skill1], { location: "workspace", cwd });
    const result = await removeSkills([skill2], { location: "workspace", cwd });

    expect(result.removed).toBe(0);
    expect(result.entries.every((e) => e.status === "conflict")).toBe(true);
  });

  it("refuses to remove real directories", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "remove-cwd-"));
    tmpDirs.push(cwd);

    const agentsDir = path.join(cwd, ".agents", "skills");
    await fs.mkdir(path.join(agentsDir, "real-dir"), { recursive: true });
    const claudeDir = path.join(cwd, ".claude", "skills");
    await fs.mkdir(path.join(claudeDir, "real-dir"), { recursive: true });

    const fakeSkill = path.join(os.tmpdir(), "real-dir");
    const result = await removeSkills([fakeSkill], { location: "workspace", cwd });

    expect(result.removed).toBe(0);
    expect(result.entries.every((e) => e.status === "conflict")).toBe(true);
  });

  it("handles multiple skills", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "remove-multi-"));
    const s1 = await createSkillDir("rem-1");
    const s2 = await createSkillDir("rem-2");
    tmpDirs.push(cwd);

    await installSkills([s1, s2], { location: "workspace", cwd });
    const result = await removeSkills([s1, s2], { location: "workspace", cwd });

    expect(result.removed).toBe(4); // 2 skills × 2 channels
  });

  it("throws when workspace location without cwd", async () => {
    const skill = await createSkillDir("no-cwd");
    await expect(
      removeSkills([skill], { location: "workspace" }),
    ).rejects.toThrow("cwd is required");
  });

  it("removes from native dirs when includeNativeDirs is true", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "remove-native-"));
    const skill = await createSkillDir("native-rm");
    tmpDirs.push(cwd);

    await installSkills([skill], { location: "workspace", cwd, includeNativeDirs: true });
    const result = await removeSkills([skill], { location: "workspace", cwd, includeNativeDirs: true });

    expect(result.removed).toBe(6); // 2 standard + 4 native
  });
});

// ---------------------------------------------------------------------------
// Public API: listInstalledSkills
// ---------------------------------------------------------------------------

describe("listInstalledSkills", () => {
  const tmpDirs: string[] = [];

  async function createSkillDir(name: string): Promise<string> {
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), "list-skills-"));
    const dir = path.join(parent, name);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "SKILL.md"), `# ${name}`);
    tmpDirs.push(parent);
    return dir;
  }

  afterEach(async () => {
    for (const dir of tmpDirs) {
      try { await fs.rm(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
    tmpDirs.length = 0;
  });

  it("returns both channels", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "list-cwd-"));
    const skill = await createSkillDir("listed-skill");
    tmpDirs.push(cwd);

    await installSkills([skill], { location: "workspace", cwd });

    const result = await listInstalledSkills({ location: "workspace", cwd });
    expect(Object.keys(result).sort()).toEqual(["agents", "claude"]);
    expect(result.agents.length).toBe(1);
    expect(result.claude.length).toBe(1);
    expect(result.agents[0]!.name).toBe("listed-skill");
    expect(result.agents[0]!.isSymlink).toBe(true);
  });

  it("returns empty arrays when no skills installed", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "list-cwd-"));
    tmpDirs.push(cwd);

    const result = await listInstalledSkills({ location: "workspace", cwd });
    expect(result.agents).toEqual([]);
    expect(result.claude).toEqual([]);
  });

  it("lists real directories alongside symlinks", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "list-cwd-"));
    tmpDirs.push(cwd);

    const agentsDir = path.join(cwd, ".agents", "skills");
    await fs.mkdir(path.join(agentsDir, "real-skill"), { recursive: true });
    await fs.writeFile(path.join(agentsDir, "real-skill", "SKILL.md"), "# Real");

    const result = await listInstalledSkills({ location: "workspace", cwd });
    expect(result.agents.length).toBe(1);
    expect(result.agents[0]!.name).toBe("real-skill");
    expect(result.agents[0]!.isSymlink).toBe(false);
  });

  it("includes native dirs when includeNativeDirs is true", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "list-native-"));
    const skill = await createSkillDir("native-listed");
    tmpDirs.push(cwd);

    await installSkills([skill], { location: "workspace", cwd, includeNativeDirs: true });

    const result = await listInstalledSkills({ location: "workspace", cwd, includeNativeDirs: true });
    expect(Object.keys(result).sort()).toEqual(["agents", "claude", "cursor", "gemini", "opencode", "pi"]);
    expect(result.gemini.length).toBe(1);
    expect(result.gemini[0]!.name).toBe("native-listed");
  });

  it("lists multiple skills", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "list-multi-"));
    const s1 = await createSkillDir("skill-a");
    const s2 = await createSkillDir("skill-b");
    tmpDirs.push(cwd);

    await installSkills([s1, s2], { location: "workspace", cwd });
    const result = await listInstalledSkills({ location: "workspace", cwd });

    expect(result.agents.length).toBe(2);
    const names = result.agents.map((s) => s.name).sort();
    expect(names).toEqual(["skill-a", "skill-b"]);
  });

  it("defaults to global location", async () => {
    // Just verify it doesn't throw — actual global paths may or may not exist
    const result = await listInstalledSkills();
    expect(result).toHaveProperty("agents");
    expect(result).toHaveProperty("claude");
  });
});

// ---------------------------------------------------------------------------
// Integration: install → list → remove → list round-trip
// ---------------------------------------------------------------------------

describe("install → list → remove round-trip", () => {
  const tmpDirs: string[] = [];

  async function createSkillDir(name: string): Promise<string> {
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), "roundtrip-"));
    const dir = path.join(parent, name);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "SKILL.md"), `# ${name}`);
    tmpDirs.push(parent);
    return dir;
  }

  afterEach(async () => {
    for (const dir of tmpDirs) {
      try { await fs.rm(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
    tmpDirs.length = 0;
  });

  it("full lifecycle: install, verify via list, remove, verify empty", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "roundtrip-cwd-"));
    const skill1 = await createSkillDir("alpha");
    const skill2 = await createSkillDir("beta");
    tmpDirs.push(cwd);
    const opts = { location: "workspace" as const, cwd };

    // 1) Install
    const installResult = await installSkills([skill1, skill2], opts);
    expect(installResult.installed).toBe(4); // 2 skills × 2 channels
    expect(installResult.errors).toBe(0);

    // 2) List — verify both skills in both channels
    const listed = await listInstalledSkills(opts);
    expect(listed.agents.length).toBe(2);
    expect(listed.claude.length).toBe(2);
    const agentNames = listed.agents.map((s) => s.name).sort();
    expect(agentNames).toEqual(["alpha", "beta"]);
    for (const skill of listed.agents) {
      expect(skill.isSymlink).toBe(true);
      expect(skill.sourcePath).not.toBeNull();
    }

    // 3) Re-install is idempotent
    const reinstall = await installSkills([skill1, skill2], opts);
    expect(reinstall.skipped).toBe(4);
    expect(reinstall.installed).toBe(0);

    // 4) Remove
    const removeResult = await removeSkills([skill1, skill2], opts);
    expect(removeResult.removed).toBe(4);

    // 5) List — verify empty
    const afterRemove = await listInstalledSkills(opts);
    expect(afterRemove.agents.length).toBe(0);
    expect(afterRemove.claude.length).toBe(0);

    // 6) Remove again — not_found
    const removeAgain = await removeSkills([skill1, skill2], opts);
    expect(removeAgain.removed).toBe(0);
    expect(removeAgain.entries.every((e) => e.status === "not_found")).toBe(true);
  });

  it("partial remove only affects specified skills", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "roundtrip-cwd-"));
    const skill1 = await createSkillDir("keep-me");
    const skill2 = await createSkillDir("remove-me");
    tmpDirs.push(cwd);
    const opts = { location: "workspace" as const, cwd };

    await installSkills([skill1, skill2], opts);

    // Remove only skill2
    const removeResult = await removeSkills([skill2], opts);
    expect(removeResult.removed).toBe(2);

    // skill1 still installed
    const listed = await listInstalledSkills(opts);
    expect(listed.agents.length).toBe(1);
    expect(listed.agents[0]!.name).toBe("keep-me");
    expect(listed.claude.length).toBe(1);
    expect(listed.claude[0]!.name).toBe("keep-me");
  });

  it("includeNativeDirs round-trip", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "roundtrip-native-"));
    const skill = await createSkillDir("native-rt");
    tmpDirs.push(cwd);
    const opts = { location: "workspace" as const, cwd, includeNativeDirs: true };

    // Install into all 6 targets
    const installResult = await installSkills([skill], opts);
    expect(installResult.installed).toBe(6);

    // List — all 6 targets present
    const listed = await listInstalledSkills(opts);
    expect(Object.keys(listed).sort()).toEqual(["agents", "claude", "cursor", "gemini", "opencode", "pi"]);
    for (const channel of Object.keys(listed)) {
      expect(listed[channel]!.length).toBe(1);
      expect(listed[channel]![0]!.name).toBe("native-rt");
    }

    // Remove from all 6
    const removeResult = await removeSkills([skill], opts);
    expect(removeResult.removed).toBe(6);

    // Verify empty
    const afterRemove = await listInstalledSkills(opts);
    for (const channel of Object.keys(afterRemove)) {
      expect(afterRemove[channel]!.length).toBe(0);
    }
  });

  it("folders round-trip, keyed by folder", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "roundtrip-folders-"));
    tmpDirs.push(root);
    const skill = await createSkillDir("folder-rt");
    const other = await createSkillDir("folder-other");
    const a = path.join(root, "a");
    const b = path.join(root, "b");
    const opts = { folders: [a, b] };

    expect((await installSkills([skill], opts)).installed).toBe(2);
    // Someone else's link in one folder is listed but never removed.
    await fs.symlink(other, path.join(b, "folder-other"), "dir");

    const listed = await listInstalledSkills(opts);
    expect(Object.keys(listed)).toEqual([a, b]);
    expect(listed[a]!.map((s) => s.name)).toEqual(["folder-rt"]);
    expect(listed[b]!.map((s) => s.name).sort()).toEqual(["folder-other", "folder-rt"]);

    const removed = await removeSkills([skill], opts);
    expect(removed.removed).toBe(2);
    expect(removed.entries.map((e) => e.target)).toEqual([a, b]);

    const after = await listInstalledSkills(opts);
    expect(after[a]).toEqual([]);
    expect(after[b]!.map((s) => s.name)).toEqual(["folder-other"]);
  });
});

// ---------------------------------------------------------------------------
// removeLegacySkillLinks (internal, used by the Antigravity, Cursor and Pi providers)
// ---------------------------------------------------------------------------

describe("removeLegacySkillLinks", () => {
  const tmpDirs: string[] = [];

  afterEach(async () => {
    for (const dir of tmpDirs) {
      try { await fs.rm(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
    tmpDirs.length = 0;
  });

  async function setup() {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "legacy-links-"));
    tmpDirs.push(root);
    const sources = path.join(root, "host", "skills");
    const alpha = path.join(sources, "alpha");
    const other = path.join(root, "elsewhere", "other");
    for (const dir of [alpha, other]) {
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, "SKILL.md"), "# skill");
    }
    const folder = path.join(root, "global");
    await fs.mkdir(path.join(folder, "mine"), { recursive: true });
    await fs.symlink(alpha, path.join(folder, "alpha"), "dir");
    await fs.symlink(other, path.join(folder, "other"), "dir");
    // Left for a host skill since renamed: dead, and pointing where the host keeps its skills.
    await fs.symlink(path.join(sources, "old-name"), path.join(folder, "old-name"), "dir");
    // Dead at a name this chat uses, pointing anywhere.
    await fs.symlink(path.join(root, "gone", "beta"), path.join(folder, "beta"), "dir");
    // Someone's own skill on a drive that isn't mounted right now.
    await fs.symlink(path.join(root, "Volumes", "external", "theirs"), path.join(folder, "theirs"), "dir");
    const beta = path.join(sources, "beta");
    return { folder, skillDirs: [alpha, beta] };
  }

  it("removes this chat's links and dead links agentex could have made, and leaves other dead links", async () => {
    const { folder, skillDirs } = await setup();
    await removeLegacySkillLinks(folder, skillDirs);
    expect((await fs.readdir(folder)).sort()).toEqual(["mine", "other", "theirs"]);
  });

  it("removes every dead link with anyDeadLink, for a folder only agentex wrote", async () => {
    const { folder, skillDirs } = await setup();
    await removeLegacySkillLinks(folder, skillDirs, { anyDeadLink: true });
    expect((await fs.readdir(folder)).sort()).toEqual(["mine", "other"]);
  });

  it("does nothing when the folder doesn't exist", async () => {
    await expect(removeLegacySkillLinks("/nonexistent/legacy/skills", ["/x/alpha"])).resolves.toBeUndefined();
  });
});
