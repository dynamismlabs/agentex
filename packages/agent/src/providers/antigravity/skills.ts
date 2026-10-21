import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ProviderConfig } from "../../types.js";
import { buildSkillsDir, cleanupSkillsDir, removeLegacySkillLinks } from "../../utils/skills.js";
import { agySkipsPermissions } from "./runtime.js";

/** A chat's `skillDirs`, staged for agy. */
export interface AgySkills {
  /** Temporary folder holding `.agents/skills/<name>` links. Removed when the chat ends. */
  dir: string;
  /** `--add-dir` arguments for every agy process the chat starts. */
  args: string[];
}

/**
 * Where agentex 0.0.40 to 0.0.45 linked a chat's skills, and never removed
 * them. agy 1.4.3 doesn't give the agent skills from this folder (its /skills
 * menu lists them and a typed `/<name>` expands, nothing more), so the links
 * only exposed a host's skills, as slash commands, to every agy session on
 * the machine.
 */
export function legacyAgySkillsHome(): string {
  return path.join(os.homedir(), ".gemini", "antigravity-cli", "skills");
}

/**
 * Stage `skillDirs` for one chat. agy takes skills from the `.agents/skills`
 * of every folder in its workspace, so they go in a temporary folder of links
 * added with `--add-dir`: nothing global changes, and the skills end with the
 * chat. Headless agy refuses to read a file whose real path is outside the
 * workspace, linked or not, unless it skips permissions. So unless it does,
 * each skill's own folder is added too (one already under `cwd` needn't be),
 * or the agent would see a skill and be denied its SKILL.md. Links rather
 * than copies keep a skill edited mid-chat current, as Claude's do.
 *
 * Also clears the links older agentex versions left in agy's legacy folder.
 * Returns null when there are no skills.
 */
export async function prepareAgySkills(
  skillDirs: string[] | undefined,
  cwd: string,
  config: ProviderConfig,
): Promise<AgySkills | null> {
  if (!skillDirs || skillDirs.length === 0) return null;
  // Only agentex ever wrote to agy's legacy folder, so every dead link there goes.
  await removeLegacySkillLinks(legacyAgySkillsHome(), skillDirs, { anyDeadLink: true });

  const dir = await buildSkillsDir(skillDirs, "antigravity");
  const args = ["--add-dir", dir];
  if (agySkipsPermissions(config)) return { dir, args };
  const workspace = await realpathOrResolve(cwd);
  const added = new Set<string>();
  for (const skillDir of skillDirs) {
    let root: string;
    try {
      root = await fs.realpath(skillDir);
    } catch {
      continue; // A missing skill has nothing to read.
    }
    if (added.has(root) || isWithin(root, workspace)) continue;
    added.add(root);
    args.push("--add-dir", root);
  }
  return { dir, args };
}

export async function cleanupAgySkills(skills: AgySkills | null): Promise<void> {
  if (skills) await cleanupSkillsDir(skills.dir);
}

async function realpathOrResolve(dir: string): Promise<string> {
  try {
    return await fs.realpath(dir);
  } catch {
    return path.resolve(dir);
  }
}

function isWithin(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}
