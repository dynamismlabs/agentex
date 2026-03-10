import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

export type SkillRuntime = "claude" | "codex";

export async function buildSkillsDir(skillDirs: string[], runtime: SkillRuntime): Promise<string> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "agentex-skills-"));

  let skillsRoot: string;
  if (runtime === "claude") {
    skillsRoot = path.join(tmpDir, ".claude", "skills");
  } else {
    skillsRoot = path.join(tmpDir, "skills");
  }
  await fs.mkdir(skillsRoot, { recursive: true });

  for (const dir of skillDirs) {
    const name = path.basename(dir);
    try {
      await fs.symlink(dir, path.join(skillsRoot, name), "dir");
    } catch (err) {
      console.warn(`Failed to symlink skill "${name}": ${err}`);
    }
  }

  return tmpDir;
}

export async function cleanupSkillsDir(tmpDir: string): Promise<void> {
  try {
    await fs.rm(tmpDir, { recursive: true, force: true });
  } catch {
    // Best effort cleanup
  }
}
