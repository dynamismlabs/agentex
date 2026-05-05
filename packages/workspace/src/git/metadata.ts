import * as fs from "node:fs/promises";
import { revParseGitPath } from "./commands.js";

const METADATA_REL = "info/agentex.json";

export interface WorktreeMetadata {
  baseBranch: string;
  baseSha: string;
}

/**
 * Per-worktree metadata stored at `<gitdir-of-worktree>/info/agentex.json`. The
 * file lives inside the worktree's own git directory (`.git/worktrees/<name>/`
 * on the source side), so it is bounded to the workspace lifetime — when the
 * worktree is removed, the file goes with it.
 *
 * This is *not* library state: the library only writes this file to a worktree
 * the consumer asked us to create, and only reads it back from a worktree the
 * consumer asked us to open.
 */
export async function writeWorktreeMetadata(
  worktreePath: string,
  metadata: WorktreeMetadata,
): Promise<void> {
  const target = await revParseGitPath(worktreePath, METADATA_REL);
  await fs.writeFile(target, JSON.stringify(metadata, null, 2) + "\n", "utf-8");
}

export async function readWorktreeMetadata(
  worktreePath: string,
): Promise<WorktreeMetadata | null> {
  const target = await revParseGitPath(worktreePath, METADATA_REL);
  try {
    const buf = await fs.readFile(target, "utf-8");
    const parsed = JSON.parse(buf) as Partial<WorktreeMetadata>;
    if (typeof parsed.baseBranch !== "string" || typeof parsed.baseSha !== "string") {
      return null;
    }
    return { baseBranch: parsed.baseBranch, baseSha: parsed.baseSha };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}
