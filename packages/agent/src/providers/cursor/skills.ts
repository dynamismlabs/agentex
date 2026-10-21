import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { cleanupSkillsDir, removeLegacySkillLinks } from "../../utils/skills.js";

/** A chat's `skillDirs`, staged as a temporary Cursor plugin. */
export interface CursorSkills {
  /** Temporary plugin folder. Removed when the run ends or the session closes. */
  dir: string;
  /** `--plugin-dir` arguments for every Cursor process the chat starts. */
  args: string[];
  skillDirs: string[];
}

/** Cursor requires a plugin name: lowercase letters, digits, dots and dashes. */
const PLUGIN_NAME = "agentex-skills";

/** Where agentex 0.0.46 and earlier linked a chat's skills, for good. */
export function legacyCursorSkillsHome(): string {
  return path.join(os.homedir(), ".cursor", "skills");
}

/**
 * Stage `skillDirs` for one chat as a temporary plugin passed with
 * `--plugin-dir`. Checked against Cursor CLI 2026.10.19:
 *
 * - `--add-dir` loads `.cursor/skills` from an added folder, but every new
 *   folder must be trusted, so a run without `--trust` or `--force` fails
 *   ("Workspace Trust Required"), even in a trusted cwd. `--trust` would
 *   also trust the cwd, which is the user's call, not agentex's.
 * - `--plugin-dir` needs no trust and leaves nothing in ~/.cursor, but
 *   Cursor loads a plugin skill only from a real folder with a real
 *   SKILL.md: a linked folder or a manifest path to one is ignored.
 *
 * So the skills are copied in. `refreshCursorSkills` copies them again
 * before every run, so a skill edited mid-session is current from the next
 * turn, while the folder's path stays the same for the whole session.
 *
 * Also clears the links older agentex versions left in ~/.cursor/skills.
 * Returns null when there are no skills.
 */
export async function prepareCursorSkills(skillDirs: string[] | undefined): Promise<CursorSkills | null> {
  if (!skillDirs || skillDirs.length === 0) return null;
  await removeLegacySkillLinks(legacyCursorSkillsHome(), skillDirs);

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agentex-skills-"));
  await fs.mkdir(path.join(dir, ".cursor-plugin"));
  await fs.writeFile(path.join(dir, ".cursor-plugin", "plugin.json"), `${JSON.stringify({ name: PLUGIN_NAME })}\n`);
  const skills: CursorSkills = { dir, args: ["--plugin-dir", dir], skillDirs: [...skillDirs] };
  await refreshCursorSkills(skills);
  return skills;
}

/** Copy every skill in again, replacing the copies from the last run. */
export async function refreshCursorSkills(skills: CursorSkills): Promise<void> {
  const root = path.join(skills.dir, "skills");
  await fs.rm(root, { recursive: true, force: true });
  await fs.mkdir(root);
  for (const skillDir of skills.skillDirs) {
    const name = path.basename(path.resolve(skillDir));
    const target = path.join(root, name);
    try {
      // The skill's own folder is copied, never a link to it. Links inside
      // it are kept, pointing where they did.
      await fs.cp(await fs.realpath(skillDir), target, { recursive: true, errorOnExist: true, force: false });
      await realizeFile(path.join(target, "SKILL.md"));
    } catch (err) {
      console.warn(`Failed to stage skill "${name}" for Cursor: ${err}`);
    }
  }
}

export async function cleanupCursorSkills(skills: CursorSkills | null): Promise<void> {
  if (skills) await cleanupSkillsDir(skills.dir);
}

/** Replace a linked file with a copy of what it points at. */
async function realizeFile(file: string): Promise<void> {
  if (!(await fs.lstat(file)).isSymbolicLink()) return;
  const content = await fs.readFile(file);
  await fs.unlink(file);
  await fs.writeFile(file, content);
}
