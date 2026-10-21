import * as os from "node:os";
import * as path from "node:path";
import { removeLegacySkillLinks } from "../../utils/skills.js";

/**
 * Where agentex 0.0.46 and earlier linked a chat's skills, for good, and then
 * passed the whole folder with `--skill`.
 */
export function legacyPiSkillsHome(): string {
  return path.join(os.homedir(), ".pi", "agent", "skills");
}

/**
 * `--skill` arguments for one chat's `skillDirs`. pi loads each path it is
 * given (repeatable, and additive even with `--no-skills`), and a folder
 * holding a SKILL.md is that one skill, so every skill folder is passed as
 * itself: nothing is written anywhere, and the skills reach only this chat.
 * pi has no permission gate, so the agent reads a skill wherever it lives.
 *
 * Also clears the links older agentex versions left in pi's global folder.
 */
export async function preparePiSkills(skillDirs: string[] | undefined): Promise<string[]> {
  if (!skillDirs || skillDirs.length === 0) return [];
  await removeLegacySkillLinks(legacyPiSkillsHome(), skillDirs);
  const paths = [...new Set(skillDirs.map((dir) => path.resolve(dir)))];
  return paths.flatMap((dir) => ["--skill", dir]);
}
