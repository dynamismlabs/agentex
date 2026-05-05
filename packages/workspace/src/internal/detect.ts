import * as path from "node:path";
import { NoDefaultBranchError } from "../errors.js";
import { execFileSafe } from "../util/exec.js";
import { pathExists } from "../util/fs.js";
import type { WorkspaceKind } from "../types.js";

/**
 * Detect whether `absolutePath` is a git workspace (worktree or main repo) or
 * a bare workspace. Throws if the path does not exist on disk.
 */
export async function detectKindFromDisk(absolutePath: string): Promise<WorkspaceKind> {
  if (!(await pathExists(absolutePath))) {
    throw new Error(`detectKind: path does not exist (${absolutePath})`);
  }
  const dotGit = path.join(absolutePath, ".git");
  if (await pathExists(dotGit)) return "git";
  return "bare";
}

/**
 * Resolve the default branch for `remote` at `absolutePath`. Tries:
 *   1. `<remote>/HEAD` symbolic ref
 *   2. `<remote>/main` if it exists
 *   3. `<remote>/master` if it exists
 *   4. `init.defaultBranch` config value
 * Throws `NoDefaultBranchError` if none resolve.
 */
export async function detectDefaultBranchFromDisk(
  absolutePath: string,
  remote: string,
): Promise<string> {
  // 1) <remote>/HEAD symbolic ref → "<remote>/<name>"
  try {
    const { stdout } = await execFileSafe(
      "git",
      ["symbolic-ref", `refs/remotes/${remote}/HEAD`],
      { cwd: absolutePath },
    );
    const ref = stdout.trim();
    const expected = `refs/remotes/${remote}/`;
    if (ref.startsWith(expected)) {
      return ref.slice(expected.length);
    }
  } catch {
    // fall through
  }

  // 2) <remote>/main / <remote>/master existence
  for (const candidate of ["main", "master"]) {
    try {
      await execFileSafe(
        "git",
        ["show-ref", "--verify", "--quiet", `refs/remotes/${remote}/${candidate}`],
        { cwd: absolutePath },
      );
      return candidate;
    } catch {
      // try next
    }
  }

  // 3) init.defaultBranch
  try {
    const { stdout } = await execFileSafe(
      "git",
      ["config", "--get", "init.defaultBranch"],
      { cwd: absolutePath },
    );
    const name = stdout.trim();
    if (name.length > 0) return name;
  } catch {
    // fall through
  }

  throw new NoDefaultBranchError(absolutePath, remote);
}
