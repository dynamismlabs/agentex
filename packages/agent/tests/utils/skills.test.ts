import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { buildSkillsDir, cleanupSkillsDir } from "../../src/utils/skills.js";

describe("buildSkillsDir", () => {
  const tmpDirs: string[] = [];
  let testSkillDir: string;

  // Create a real skill directory to symlink to
  async function createTestSkillDir(): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "test-skill-"));
    await fs.writeFile(path.join(dir, "skill.md"), "# Test Skill");
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
