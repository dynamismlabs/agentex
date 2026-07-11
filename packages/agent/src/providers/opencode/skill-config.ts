import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

export interface OpenCodeSkillConfig {
  env: Record<string, string>;
  cleanup(): Promise<void>;
}

function sourceConfigDir(env: Record<string, string>): string {
  if (env["OPENCODE_CONFIG_DIR"]) return env["OPENCODE_CONFIG_DIR"];
  const configHome = env["XDG_CONFIG_HOME"]
    ?? path.join(env["HOME"] ?? os.homedir(), ".config");
  return path.join(configHome, "opencode");
}

/**
 * Build an isolated OpenCode config directory containing requested skills.
 * Existing global config is copied first, so config precedence is preserved
 * without writing into the user's home or workspace.
 */
export async function prepareOpenCodeSkillConfig(
  env: Record<string, string>,
  skillDirs: string[] | undefined,
): Promise<OpenCodeSkillConfig> {
  if (!skillDirs?.length) return { env, cleanup: async () => {} };

  const configDir = await fs.mkdtemp(path.join(os.tmpdir(), "agentex-opencode-"));
  try {
    await fs.cp(sourceConfigDir(env), configDir, {
      recursive: true,
      force: false,
      errorOnExist: false,
    });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      await fs.rm(configDir, { recursive: true, force: true });
      throw error;
    }
  }

  try {
    const skillsDir = path.join(configDir, "skills");
    await fs.mkdir(skillsDir, { recursive: true });
    for (const directory of skillDirs) {
      const source = path.resolve(directory);
      const name = path.basename(source);
      const stat = await fs.stat(path.join(source, "SKILL.md"));
      if (!stat.isFile()) throw new Error(`OpenCode skill has no SKILL.md: ${source}`);
      const target = path.join(skillsDir, name);
      await fs.rm(target, { recursive: true, force: true });
      await fs.symlink(source, target, process.platform === "win32" ? "junction" : "dir");
    }
  } catch (error) {
    await fs.rm(configDir, { recursive: true, force: true });
    throw error;
  }

  return {
    env: { ...env, OPENCODE_CONFIG_DIR: configDir },
    cleanup: () => fs.rm(configDir, { recursive: true, force: true }),
  };
}
