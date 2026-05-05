import { execFileSafe } from "../util/exec.js";

/**
 * Read the worktree's active sparse-checkout patterns. Returns `null` when the
 * workspace isn't a sparse worktree (or isn't git at all). The caller treats
 * `null` as "no sparse restriction; copy/link everything we matched."
 *
 * Cone-mode patterns from `git sparse-checkout list` are directory paths (no
 * leading slash, no trailing slash). The matcher in `isInsideSparse` follows
 * cone semantics: top-level files are always inside, and any path under one of
 * the listed dirs is inside.
 */
export async function readSparsePatterns(workspacePath: string): Promise<string[] | null> {
  let stdout: string;
  try {
    const result = await execFileSafe(
      "git",
      ["sparse-checkout", "list"],
      { cwd: workspacePath },
    );
    stdout = result.stdout;
  } catch {
    return null;
  }

  const patterns = stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  if (patterns.length === 0) return null;
  return patterns;
}

/**
 * Cone-mode containment check: a path is "inside" the sparse-checkout if it is
 * a top-level file, or it lives under one of the listed directories.
 */
export function isInsideSparse(relPath: string, patterns: readonly string[]): boolean {
  if (!relPath.includes("/")) return true;
  for (const pattern of patterns) {
    if (relPath === pattern) return true;
    if (relPath.startsWith(pattern + "/")) return true;
  }
  return false;
}
