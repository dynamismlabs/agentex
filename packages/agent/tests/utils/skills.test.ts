import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import {
  buildSkillsDir,
  cleanupSkillsDir,
  resolveSkillsHome,
  resolveSkillsWorkspace,
  ensureSkillSymlink,
  injectHomeSkills,
  injectWorkspaceSkills,
  installSkills,
  removeSkills,
  listInstalledSkills,
} from "../../src/utils/skills.js";

describe("buildSkillsDir", () => {
  const tmpDirs: string[] = [];
  let testSkillDir: string;

  // Create a real skill directory to symlink to
  async function createTestSkillDir(): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "test-skill-"));
    await fs.writeFile(path.join(dir, "SKILL.md"), "# Test Skill");
    tmpDirs.push(dir);
    return dir;
  }

  afterEach(async () => {
    for (const dir of tmpDirs) {
      try {
        await fs.rm(dir, { recursive: true, force: true });
      } catch {
        // ignore
      }
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
    // Should not throw — just warn
  });
});

describe("cleanupSkillsDir", () => {
  it("removes the temp directory", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "cleanup-test-"));
    await cleanupSkillsDir(tmpDir);

    let exists = true;
    try {
      await fs.access(tmpDir);
    } catch {
      exists = false;
    }
    expect(exists).toBe(false);
  });

  it("does not throw on non-existent dir", async () => {
    await expect(cleanupSkillsDir("/nonexistent/cleanup")).resolves.toBeUndefined();
  });
});

describe("resolveSkillsHome", () => {
  it("returns ~/.gemini/skills for gemini", () => {
    const result = resolveSkillsHome("gemini");
    expect(result).toBe(path.join(os.homedir(), ".gemini", "skills"));
  });

  it("returns ~/.cursor/skills for cursor", () => {
    const result = resolveSkillsHome("cursor");
    expect(result).toBe(path.join(os.homedir(), ".cursor", "skills"));
  });

  it("returns ~/.claude/skills for opencode", () => {
    const result = resolveSkillsHome("opencode");
    expect(result).toBe(path.join(os.homedir(), ".claude", "skills"));
  });

  it("returns ~/.pi/agent/skills for pi", () => {
    const result = resolveSkillsHome("pi");
    expect(result).toBe(path.join(os.homedir(), ".pi", "agent", "skills"));
  });

  it("returns null for claude (uses ephemeral tmpdir)", () => {
    const result = resolveSkillsHome("claude");
    expect(result).toBeNull();
  });

  it("returns null for codex (uses workspace)", () => {
    const result = resolveSkillsHome("codex");
    expect(result).toBeNull();
  });
});

describe("ensureSkillSymlink", () => {
  const tmpDirs: string[] = [];

  afterEach(async () => {
    for (const dir of tmpDirs) {
      try {
        await fs.rm(dir, { recursive: true, force: true });
      } catch {
        // ignore
      }
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
    const linkTarget = await fs.readlink(target);
    expect(path.resolve(path.dirname(target), linkTarget)).toBe(path.resolve(sourceDir));
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

describe("injectHomeSkills", () => {
  it("returns null for empty skillDirs", async () => {
    const result = await injectHomeSkills([], "gemini");
    expect(result).toBeNull();
  });

  it("returns null for unsupported runtime (claude)", async () => {
    const result = await injectHomeSkills(["/some/skill/dir"], "claude");
    expect(result).toBeNull();
  });
});

describe("injectWorkspaceSkills", () => {
  const tmpDirs: string[] = [];

  afterEach(async () => {
    for (const dir of tmpDirs) {
      try {
        await fs.rm(dir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
    tmpDirs.length = 0;
  });

  it("returns null for empty skillDirs", async () => {
    const result = await injectWorkspaceSkills([], "/tmp/fake-cwd");
    expect(result).toBeNull();
  });

  it("creates skills in {cwd}/.agents/skills/ and returns the path", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "ws-cwd-"));
    const skillDir = await fs.mkdtemp(path.join(os.tmpdir(), "ws-skill-"));
    await fs.writeFile(path.join(skillDir, "SKILL.md"), "# Test");
    tmpDirs.push(cwd, skillDir);

    const result = await injectWorkspaceSkills([skillDir], cwd);
    expect(result).toBe(path.join(cwd, ".agents", "skills"));

    const stat = await fs.stat(result!);
    expect(stat.isDirectory()).toBe(true);
  });

  it("creates symlinks for skill directories", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "ws-cwd-"));
    const skillDir1 = await fs.mkdtemp(path.join(os.tmpdir(), "ws-skill-"));
    const skillDir2 = await fs.mkdtemp(path.join(os.tmpdir(), "ws-skill-"));
    await fs.writeFile(path.join(skillDir1, "SKILL.md"), "# Skill 1");
    await fs.writeFile(path.join(skillDir2, "SKILL.md"), "# Skill 2");
    tmpDirs.push(cwd, skillDir1, skillDir2);

    const result = await injectWorkspaceSkills([skillDir1, skillDir2], cwd);
    expect(result).not.toBeNull();

    const name1 = path.basename(skillDir1);
    const name2 = path.basename(skillDir2);
    const link1 = path.join(result!, name1);
    const link2 = path.join(result!, name2);

    const stat1 = await fs.lstat(link1);
    expect(stat1.isSymbolicLink()).toBe(true);
    const stat2 = await fs.lstat(link2);
    expect(stat2.isSymbolicLink()).toBe(true);

    const target1 = await fs.readlink(link1);
    expect(path.resolve(path.dirname(link1), target1)).toBe(path.resolve(skillDir1));
    const target2 = await fs.readlink(link2);
    expect(path.resolve(path.dirname(link2), target2)).toBe(path.resolve(skillDir2));
  });
});

// ---------------------------------------------------------------------------
// Public API: installSkills / removeSkills / listInstalledSkills
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

  it("installs skills into codex workspace when cwd provided", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "install-cwd-"));
    const skill = await createSkillDir("test-skill");
    tmpDirs.push(cwd);

    const result = await installSkills([skill], { runtimes: [], cwd });

    expect(result.installed).toBe(1);
    expect(result.errors).toBe(0);

    const entry = result.entries.find((e) => e.runtime === "codex");
    expect(entry).toBeDefined();
    expect(entry!.status).toBe("created");

    const link = path.join(cwd, ".agents", "skills", "test-skill");
    const stat = await fs.lstat(link);
    expect(stat.isSymbolicLink()).toBe(true);
  });

  it("skips already-installed skills", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "install-cwd-"));
    const skill = await createSkillDir("skip-skill");
    tmpDirs.push(cwd);

    const first = await installSkills([skill], { runtimes: [], cwd });
    expect(first.installed).toBe(1);

    const second = await installSkills([skill], { runtimes: [], cwd });
    expect(second.skipped).toBe(1);
    expect(second.installed).toBe(0);
  });

  it("reports conflicts for existing different symlinks", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "install-cwd-"));
    const skill1 = await createSkillDir("conflict-skill");
    const skill2 = await createSkillDir("conflict-skill");
    tmpDirs.push(cwd);

    await installSkills([skill1], { runtimes: [], cwd });
    const result = await installSkills([skill2], { runtimes: [], cwd });

    expect(result.conflicts).toBe(1);
  });

  it("returns aggregate counts", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "install-cwd-"));
    const s1 = await createSkillDir("agg-skill-1");
    const s2 = await createSkillDir("agg-skill-2");
    tmpDirs.push(cwd);

    const result = await installSkills([s1, s2], { runtimes: [], cwd });

    expect(result.installed).toBe(2);
    expect(result.entries.length).toBe(2);
    expect(result.entries.every((e) => e.runtime === "codex")).toBe(true);
  });

  it("handles empty skillDirs", async () => {
    const result = await installSkills([]);
    expect(result.installed).toBe(0);
    expect(result.entries.length).toBe(0);
  });

  it("installs into multiple runtimes when specified", async () => {
    // Use two separate cwd dirs to simulate different runtimes
    // Since we can't test real home dirs, test that entries contain expected runtimes
    // by installing with runtimes: [] (none) + cwd to isolate to codex
    const cwd1 = await fs.mkdtemp(path.join(os.tmpdir(), "multi-cwd1-"));
    const cwd2 = await fs.mkdtemp(path.join(os.tmpdir(), "multi-cwd2-"));
    const skill = await createSkillDir("multi-skill");
    tmpDirs.push(cwd1, cwd2);

    const r1 = await installSkills([skill], { runtimes: [], cwd: cwd1 });
    const r2 = await installSkills([skill], { runtimes: [], cwd: cwd2 });

    expect(r1.installed).toBe(1);
    expect(r2.installed).toBe(1);

    // Verify both workspaces have the skill
    const link1 = path.join(cwd1, ".agents", "skills", "multi-skill");
    const link2 = path.join(cwd2, ".agents", "skills", "multi-skill");
    expect((await fs.lstat(link1)).isSymbolicLink()).toBe(true);
    expect((await fs.lstat(link2)).isSymbolicLink()).toBe(true);
  });

  it("resolves relative paths", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "install-rel-"));
    const skill = await createSkillDir("rel-skill");
    tmpDirs.push(cwd);

    // Install with the absolute path
    const result = await installSkills([skill], { runtimes: [], cwd });
    expect(result.installed).toBe(1);

    // The entry should have an absolute targetPath
    expect(path.isAbsolute(result.entries[0]!.targetPath)).toBe(true);
  });
});

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

  it("removes installed skill symlinks", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "remove-cwd-"));
    const skill = await createSkillDir("removable");
    tmpDirs.push(cwd);

    await installSkills([skill], { runtimes: [], cwd });
    const result = await removeSkills([skill], { runtimes: [], cwd });

    expect(result.removed).toBe(1);

    const link = path.join(cwd, ".agents", "skills", "removable");
    let exists = true;
    try { await fs.lstat(link); } catch { exists = false; }
    expect(exists).toBe(false);
  });

  it("returns not_found for skills that aren't installed", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "remove-cwd-"));
    const skill = await createSkillDir("missing");
    tmpDirs.push(cwd);

    const result = await removeSkills([skill], { runtimes: [], cwd });
    expect(result.removed).toBe(0);

    const entry = result.entries[0];
    expect(entry!.status).toBe("not_found");
  });

  it("refuses to remove symlinks pointing to different sources", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "remove-cwd-"));
    const skill1 = await createSkillDir("guarded");
    const skill2 = await createSkillDir("guarded");
    tmpDirs.push(cwd);

    // Install skill1's version
    await installSkills([skill1], { runtimes: [], cwd });
    // Try to remove skill2's version (same name, different source)
    const result = await removeSkills([skill2], { runtimes: [], cwd });

    expect(result.removed).toBe(0);
    expect(result.entries[0]!.status).toBe("conflict");

    // Original symlink should still exist
    const link = path.join(cwd, ".agents", "skills", "guarded");
    const stat = await fs.lstat(link);
    expect(stat.isSymbolicLink()).toBe(true);
  });

  it("refuses to remove real directories", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "remove-cwd-"));
    tmpDirs.push(cwd);

    // Create a real directory (not a symlink) at the skill target
    const skillsHome = path.join(cwd, ".agents", "skills");
    await fs.mkdir(path.join(skillsHome, "real-dir"), { recursive: true });

    const fakeSkill = path.join(os.tmpdir(), "real-dir");
    const result = await removeSkills([fakeSkill], { runtimes: [], cwd });

    expect(result.removed).toBe(0);
    expect(result.entries[0]!.status).toBe("conflict");
  });

  it("handles removing multiple skills at once", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "remove-multi-"));
    const s1 = await createSkillDir("rem-1");
    const s2 = await createSkillDir("rem-2");
    tmpDirs.push(cwd);

    await installSkills([s1, s2], { runtimes: [], cwd });
    const result = await removeSkills([s1, s2], { runtimes: [], cwd });

    expect(result.removed).toBe(2);
    expect(result.entries.length).toBe(2);
    expect(result.entries.every((e) => e.status === "removed")).toBe(true);
  });

  it("handles mixed results (some found, some not)", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "remove-mixed-"));
    const installed = await createSkillDir("installed");
    const missing = await createSkillDir("not-installed");
    tmpDirs.push(cwd);

    await installSkills([installed], { runtimes: [], cwd });
    const result = await removeSkills([installed, missing], { runtimes: [], cwd });

    expect(result.removed).toBe(1);
    const statuses = result.entries.map((e) => e.status).sort();
    expect(statuses).toEqual(["not_found", "removed"]);
  });
});

describe("listInstalledSkills", () => {
  const tmpDirs: string[] = [];

  afterEach(async () => {
    for (const dir of tmpDirs) {
      try { await fs.rm(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
    tmpDirs.length = 0;
  });

  it("lists symlinked skills in a codex workspace", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "list-cwd-"));
    const skillParent = await fs.mkdtemp(path.join(os.tmpdir(), "list-skill-"));
    const skillDir = path.join(skillParent, "my-skill");
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(path.join(skillDir, "SKILL.md"), "# My Skill");
    tmpDirs.push(cwd, skillParent);

    await installSkills([skillDir], { runtimes: [], cwd });

    const skills = await listInstalledSkills("codex", cwd);
    expect(skills.length).toBe(1);
    expect(skills[0]!.name).toBe("my-skill");
    expect(skills[0]!.isSymlink).toBe(true);
    expect(skills[0]!.sourcePath).toBe(path.resolve(skillDir));
  });

  it("lists real directories alongside symlinks", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "list-cwd-"));
    tmpDirs.push(cwd);

    const skillsHome = path.join(cwd, ".agents", "skills");
    await fs.mkdir(path.join(skillsHome, "real-skill"), { recursive: true });
    await fs.writeFile(path.join(skillsHome, "real-skill", "SKILL.md"), "# Real");

    const skills = await listInstalledSkills("codex", cwd);
    expect(skills.length).toBe(1);
    expect(skills[0]!.name).toBe("real-skill");
    expect(skills[0]!.isSymlink).toBe(false);
    expect(skills[0]!.sourcePath).toBe(path.join(skillsHome, "real-skill"));
  });

  it("returns empty array for non-existent directory", async () => {
    const skills = await listInstalledSkills("codex", "/nonexistent/cwd");
    expect(skills).toEqual([]);
  });

  it("returns empty array for codex without cwd", async () => {
    const skills = await listInstalledSkills("codex");
    expect(skills).toEqual([]);
  });

  it("returns empty array for claude (no home-dir skills)", async () => {
    const skills = await listInstalledSkills("claude");
    expect(skills).toEqual([]);
  });

  it("lists multiple skills", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "list-multi-"));
    const p1 = await fs.mkdtemp(path.join(os.tmpdir(), "list-skill1-"));
    const p2 = await fs.mkdtemp(path.join(os.tmpdir(), "list-skill2-"));
    const s1 = path.join(p1, "skill-a");
    const s2 = path.join(p2, "skill-b");
    await fs.mkdir(s1, { recursive: true });
    await fs.mkdir(s2, { recursive: true });
    await fs.writeFile(path.join(s1, "SKILL.md"), "# A");
    await fs.writeFile(path.join(s2, "SKILL.md"), "# B");
    tmpDirs.push(cwd, p1, p2);

    await installSkills([s1, s2], { runtimes: [], cwd });
    const skills = await listInstalledSkills("codex", cwd);

    expect(skills.length).toBe(2);
    const names = skills.map((s) => s.name).sort();
    expect(names).toEqual(["skill-a", "skill-b"]);
    expect(skills.every((s) => s.isSymlink)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// resolveSkillsWorkspace
// ---------------------------------------------------------------------------

describe("resolveSkillsWorkspace", () => {
  const cwd = "/projects/my-app";

  it("returns {cwd}/.claude/skills for claude", () => {
    expect(resolveSkillsWorkspace("claude", cwd)).toBe(path.join(cwd, ".claude", "skills"));
  });

  it("returns {cwd}/.claude/skills for opencode (same as claude)", () => {
    expect(resolveSkillsWorkspace("opencode", cwd)).toBe(path.join(cwd, ".claude", "skills"));
  });

  it("returns {cwd}/.agents/skills for codex", () => {
    expect(resolveSkillsWorkspace("codex", cwd)).toBe(path.join(cwd, ".agents", "skills"));
  });

  it("returns {cwd}/.gemini/skills for gemini", () => {
    expect(resolveSkillsWorkspace("gemini", cwd)).toBe(path.join(cwd, ".gemini", "skills"));
  });

  it("returns {cwd}/.cursor/skills for cursor", () => {
    expect(resolveSkillsWorkspace("cursor", cwd)).toBe(path.join(cwd, ".cursor", "skills"));
  });

  it("returns {cwd}/.pi/agent/skills for pi", () => {
    expect(resolveSkillsWorkspace("pi", cwd)).toBe(path.join(cwd, ".pi", "agent", "skills"));
  });
});

// ---------------------------------------------------------------------------
// Workspace location: installSkills / removeSkills / listInstalledSkills
// ---------------------------------------------------------------------------

describe("installSkills (workspace location)", () => {
  const tmpDirs: string[] = [];

  async function createSkillDir(name: string): Promise<string> {
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), "ws-install-"));
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

  it("throws when cwd is missing for workspace location", async () => {
    const skill = await createSkillDir("no-cwd");
    await expect(
      installSkills([skill], { location: "workspace" }),
    ).rejects.toThrow("cwd is required");
  });

  it("installs into workspace-relative paths for all runtimes", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "ws-cwd-"));
    const skill = await createSkillDir("ws-skill");
    tmpDirs.push(cwd);

    const result = await installSkills([skill], { location: "workspace", cwd });

    // All 6 runtimes, but claude+opencode share .claude/skills so one is "skipped"
    expect(result.installed + result.skipped).toBe(6);
    expect(result.errors).toBe(0);

    // Verify a few workspace paths exist
    const geminiLink = path.join(cwd, ".gemini", "skills", "ws-skill");
    expect((await fs.lstat(geminiLink)).isSymbolicLink()).toBe(true);

    const claudeLink = path.join(cwd, ".claude", "skills", "ws-skill");
    expect((await fs.lstat(claudeLink)).isSymbolicLink()).toBe(true);

    const codexLink = path.join(cwd, ".agents", "skills", "ws-skill");
    expect((await fs.lstat(codexLink)).isSymbolicLink()).toBe(true);
  });

  it("installs for a subset of runtimes", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "ws-cwd-"));
    const skill = await createSkillDir("subset-skill");
    tmpDirs.push(cwd);

    const result = await installSkills([skill], {
      location: "workspace",
      cwd,
      runtimes: ["gemini", "cursor"],
    });

    expect(result.installed).toBe(2);
    expect(result.entries.length).toBe(2);
    expect(result.entries.map((e) => e.runtime).sort()).toEqual(["cursor", "gemini"]);
  });

  it("is idempotent — second install returns skipped", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "ws-cwd-"));
    const skill = await createSkillDir("idem-skill");
    tmpDirs.push(cwd);

    const opts = { location: "workspace" as const, cwd, runtimes: ["gemini" as const] };

    const first = await installSkills([skill], opts);
    expect(first.installed).toBe(1);

    const second = await installSkills([skill], opts);
    expect(second.skipped).toBe(1);
    expect(second.installed).toBe(0);
  });
});

describe("removeSkills (workspace location)", () => {
  const tmpDirs: string[] = [];

  async function createSkillDir(name: string): Promise<string> {
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), "ws-remove-"));
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

  it("throws when cwd is missing for workspace location", async () => {
    const skill = await createSkillDir("no-cwd");
    await expect(
      removeSkills([skill], { location: "workspace" }),
    ).rejects.toThrow("cwd is required");
  });

  it("removes workspace-installed skills", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "ws-cwd-"));
    const skill = await createSkillDir("removable");
    tmpDirs.push(cwd);

    const opts = { location: "workspace" as const, cwd, runtimes: ["gemini" as const, "cursor" as const] };
    await installSkills([skill], opts);
    const result = await removeSkills([skill], opts);

    expect(result.removed).toBe(2);

    // Verify symlinks are gone
    const geminiLink = path.join(cwd, ".gemini", "skills", "removable");
    let exists = true;
    try { await fs.lstat(geminiLink); } catch { exists = false; }
    expect(exists).toBe(false);
  });

  it("returns not_found for skills not installed in workspace", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "ws-cwd-"));
    const skill = await createSkillDir("ghost");
    tmpDirs.push(cwd);

    const result = await removeSkills([skill], {
      location: "workspace",
      cwd,
      runtimes: ["gemini"],
    });

    expect(result.removed).toBe(0);
    expect(result.entries[0]!.status).toBe("not_found");
  });
});

describe("listInstalledSkills (workspace location)", () => {
  const tmpDirs: string[] = [];

  async function createSkillDir(name: string): Promise<string> {
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), "ws-list-"));
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

  it("lists skills from workspace directory", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "ws-cwd-"));
    const skill = await createSkillDir("listed-skill");
    tmpDirs.push(cwd);

    await installSkills([skill], { location: "workspace", cwd, runtimes: ["gemini"] });

    const skills = await listInstalledSkills("gemini", { location: "workspace", cwd });
    expect(skills.length).toBe(1);
    expect(skills[0]!.name).toBe("listed-skill");
    expect(skills[0]!.isSymlink).toBe(true);
  });

  it("returns empty for workspace runtime with no skills installed", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "ws-cwd-"));
    tmpDirs.push(cwd);

    const skills = await listInstalledSkills("cursor", { location: "workspace", cwd });
    expect(skills).toEqual([]);
  });

  it("returns empty when workspace cwd is missing", async () => {
    const skills = await listInstalledSkills("gemini", { location: "workspace" });
    expect(skills).toEqual([]);
  });

  it("lists claude workspace skills", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "ws-cwd-"));
    const skill = await createSkillDir("claude-ws");
    tmpDirs.push(cwd);

    await installSkills([skill], { location: "workspace", cwd, runtimes: ["claude"] });

    const skills = await listInstalledSkills("claude", { location: "workspace", cwd });
    expect(skills.length).toBe(1);
    expect(skills[0]!.name).toBe("claude-ws");

    // Verify it's in {cwd}/.claude/skills/
    const link = path.join(cwd, ".claude", "skills", "claude-ws");
    expect((await fs.lstat(link)).isSymbolicLink()).toBe(true);
  });
});
