import * as path from "node:path";
import { execFileSafe } from "../util/exec.js";

/**
 * Resolve the *source* repository path from a workspace path, whether it's a
 * worktree (where `.git` is a pointer file) or the main repo (where `.git` is
 * a directory). Uses `git rev-parse --git-common-dir` so we don't have to
 * reimplement git's `.git`-pointer-file dereferencing.
 *
 * Returns `null` if the path isn't a git repo at all.
 */
export async function resolveSourceFromWorkspace(
  workspacePath: string,
): Promise<string | null> {
  let stdout: string;
  try {
    const result = await execFileSafe(
      "git",
      ["rev-parse", "--git-common-dir"],
      { cwd: workspacePath },
    );
    stdout = result.stdout;
  } catch {
    return null;
  }

  const commonDir = stdout.trim();
  if (commonDir.length === 0) return null;

  const absoluteCommonDir = path.isAbsolute(commonDir)
    ? commonDir
    : path.resolve(workspacePath, commonDir);

  // Strip trailing `.git` if present; the source repo is its parent directory.
  if (path.basename(absoluteCommonDir) === ".git") {
    return path.dirname(absoluteCommonDir);
  }

  // Custom GIT_DIR setups: best we can do is return the directory itself.
  return absoluteCommonDir;
}
