import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { promisify } from "node:util";
import { buildSkillsDir, cleanupSkillsDir, findLegacySkillLinks } from "../../utils/skills.js";

const execFileAsync = promisify(execFile);

/** A chat's `skillDirs`, staged for one `codex app-server` process. */
export interface CodexSkills {
  /** Temporary folder, removed when the chat ends. */
  dir: string;
  /** The skill root handed to `skills/extraRoots/set`: links to each skill folder. */
  root: string;
}

/**
 * Stage `skillDirs` for one chat. Codex takes extra skill roots for a single
 * app-server process (`skills/extraRoots/set`, checked against codex-cli
 * 0.163.0): each root is a folder whose subfolders are skills, linked or
 * real; nothing is written to the project or the user's config, and another
 * process in the same folder sees none of them. So the skills go in a
 * temporary folder of links that the session hands over before its thread
 * starts. `codex exec` has no such option, which is why one-shot runs with
 * skills go through the app-server too.
 *
 * Also removes the links agentex 0.0.47 and earlier left for these skills in
 * the project's `.agents/skills`, except any git tracks: deleting a committed
 * file would leave a change in someone's working tree.
 */
export async function prepareCodexSkills(skillDirs: string[] | undefined, cwd: string): Promise<CodexSkills | null> {
  if (!skillDirs || skillDirs.length === 0) return null;
  await removeLegacyProjectSkillLinks(cwd, skillDirs);
  const dir = await buildSkillsDir(skillDirs, "codex");
  return { dir, root: path.join(dir, "skills") };
}

export async function cleanupCodexSkills(skills: CodexSkills | null): Promise<void> {
  if (skills) await cleanupSkillsDir(skills.dir);
}

async function removeLegacyProjectSkillLinks(cwd: string, skillDirs: string[]): Promise<void> {
  const agents = path.join(cwd, ".agents");
  const folder = path.join(agents, "skills");
  const links = await findLegacySkillLinks(folder, skillDirs);
  if (links.length === 0) return;
  const tracked = await gitTrackedFiles(cwd, folder);
  // Unknown tracking keeps every link: removing a committed one would change
  // the working tree, and a leftover link only costs a duplicate skill.
  if (tracked === null) return;
  // git reports real paths (/private/tmp, not /tmp), so compare through the folder's.
  const realFolder = await fs.realpath(folder).catch(() => folder);
  let removed = false;
  for (const link of links) {
    if (tracked.has(path.join(realFolder, path.basename(link)))) continue;
    await fs.unlink(link).then(() => { removed = true; }, () => undefined);
  }
  // Folders agentex made only to hold those links go too. rmdir leaves a
  // folder that still holds anything.
  if (removed) {
    await fs.rmdir(folder).catch(() => undefined);
    await fs.rmdir(agents).catch(() => undefined);
  }
}

/**
 * Real paths of files git tracks under `folder`, or null when that can't be
 * known. With no `.git` in `cwd`'s real folder or above it, nothing is
 * tracked. In a repo, git has to say: a failure (no git, a timeout, a broken
 * repo) is null, never "nothing tracked". So is a folder that can't be
 * inspected.
 */
async function gitTrackedFiles(cwd: string, folder: string): Promise<Set<string> | null> {
  const repo = await insideGitRepo(cwd);
  if (repo === null) return null;
  if (!repo) return new Set();
  try {
    // Real paths throughout: git resolves the folder it runs in, and rejects
    // a path that reaches the repo through a link as outside it.
    const realCwd = await fs.realpath(cwd);
    const realFolder = await fs.realpath(folder);
    const { stdout: top } = await execFileAsync("git", ["rev-parse", "--show-toplevel"], { cwd: realCwd, timeout: 10_000 });
    const { stdout } = await execFileAsync("git", ["ls-files", "-z", "--full-name", "--", realFolder], { cwd: realCwd, timeout: 10_000 });
    const root = await fs.realpath(top.trim()).catch(() => top.trim());
    return new Set(stdout.split("\0").filter(Boolean).map((file) => path.join(root, file)));
  } catch {
    return null;
  }
}

/**
 * A `.git` folder or file (a worktree's) in `dir` or any folder above it,
 * walking up from the real folder: a `cwd` that links into a repo's
 * subfolder is in that repo, as git sees it. Null when the walk can't tell.
 */
async function insideGitRepo(dir: string): Promise<boolean | null> {
  let current: string;
  try {
    current = await fs.realpath(dir);
  } catch {
    return null;
  }
  for (; ; current = path.dirname(current)) {
    try {
      await fs.lstat(path.join(current, ".git"));
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") return null;
    }
    if (path.dirname(current) === current) return false;
  }
}
