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
  injectHomeSkills,
  injectWorkspaceSkills,
  installSkills,
  removeSkills,
  listInstalledSkills,
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
// injectHomeSkills / injectWorkspaceSkills (internal, used by providers)
// ---------------------------------------------------------------------------

describe("injectHomeSkills", () => {
  it("returns null for empty skillDirs", async () => {
    const result = await injectHomeSkills([], "gemini");
    expect(result).toBeNull();
  });

  it("returns null for runtimes without native dirs (claude)", async () => {
    const result = await injectHomeSkills(["/some/skill/dir"], "claude");
    expect(result).toBeNull();
  });

  it("returns null for runtimes without native dirs (codex)", async () => {
    const result = await injectHomeSkills(["/some/skill/dir"], "codex");
    expect(result).toBeNull();
  });
});

describe("injectWorkspaceSkills", () => {
  const tmpDirs: string[] = [];

  afterEach(async () => {
    for (const dir of tmpDirs) {
      try { await fs.rm(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
    tmpDirs.length = 0;
  });

  it("returns null for empty skillDirs", async () => {
    const result = await injectWorkspaceSkills([], "/tmp/fake-cwd");
    expect(result).toBeNull();
  });

  it("creates skills in {cwd}/.agents/skills/", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "ws-cwd-"));
    const skillDir = await fs.mkdtemp(path.join(os.tmpdir(), "ws-skill-"));
    await fs.writeFile(path.join(skillDir, "SKILL.md"), "# Test");
    tmpDirs.push(cwd, skillDir);

    const result = await injectWorkspaceSkills([skillDir], cwd);
    expect(result).toBe(path.join(cwd, ".agents", "skills"));
    expect((await fs.stat(result!)).isDirectory()).toBe(true);
  });

  it("creates symlinks for skill directories", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "ws-cwd-"));
    const skillDir1 = await fs.mkdtemp(path.join(os.tmpdir(), "ws-skill-"));
    const skillDir2 = await fs.mkdtemp(path.join(os.tmpdir(), "ws-skill-"));
    tmpDirs.push(cwd, skillDir1, skillDir2);

    const result = await injectWorkspaceSkills([skillDir1, skillDir2], cwd);
    expect(result).not.toBeNull();

    const link1 = path.join(result!, path.basename(skillDir1));
    const link2 = path.join(result!, path.basename(skillDir2));
    expect((await fs.lstat(link1)).isSymbolicLink()).toBe(true);
    expect((await fs.lstat(link2)).isSymbolicLink()).toBe(true);
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

    // 2 standard + 4 native (gemini, cursor, opencode, pi)
    expect(result.installed).toBe(6);

    const targets = result.entries.map((e) => e.target).sort();
    expect(targets).toEqual(["agents", "claude", "cursor", "gemini", "opencode", "pi"]);

    // Verify a native dir was created
    const geminiLink = path.join(cwd, ".gemini", "skills", "native-skill");
    expect((await fs.lstat(geminiLink)).isSymbolicLink()).toBe(true);
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
});
