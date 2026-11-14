import * as fs from "node:fs/promises";
import { revParseGitCommonDir, revParseGitDir, revParseGitPath } from "./commands.js";

// Deliberately *not* under `info/`: git treats `info/` as common to every
// worktree, so `--git-path info/<x>` from a linked worktree resolves into the
// shared `<common>/info/` and each sibling `create` would clobber the last.
// An unrecognized top-level name like this one is per-worktree.
const METADATA_REL = "agentex.json";

// Where <= 0.0.4 wrote metadata (`<common>/info/agentex.json`, shared by every
// worktree). Read-only fallback so worktrees created before the move still open.
const LEGACY_METADATA_REL = "info/agentex.json";

export interface WorktreeMetadata {
  baseBranch: string;
  baseSha: string;
}

/**
 * Per-worktree metadata stored at `<gitdir-of-worktree>/agentex.json`
 * (`.git/worktrees/<name>/agentex.json` on the source side), so each worktree
 * has its own and the file is bounded to the workspace lifetime — when the
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

/**
 * Read the metadata written by `writeWorktreeMetadata`, or `null` when there is
 * none (or it doesn't have the expected shape). Other read/parse errors
 * propagate.
 *
 * A linked worktree without per-worktree metadata falls back to the legacy
 * shared `<common>/info/agentex.json` written by <= 0.0.4. That file is only
 * trustworthy for the most recently created sibling (the same behavior those
 * versions had); anything created since writes per-worktree and never reaches
 * the fallback. A normal checkout never falls back: the legacy file was always
 * written on behalf of a linked worktree, never the checkout itself.
 */
export async function readWorktreeMetadata(
  worktreePath: string,
): Promise<WorktreeMetadata | null> {
  const current = await readMetadataFile(await revParseGitPath(worktreePath, METADATA_REL));
  if (current !== undefined) return current;

  if (!(await isLinkedWorktree(worktreePath))) return null;
  const legacy = await readMetadataFile(await revParseGitPath(worktreePath, LEGACY_METADATA_REL));
  return legacy ?? null;
}

/** `undefined` when the file doesn't exist; `null` when it has the wrong shape. */
async function readMetadataFile(target: string): Promise<WorktreeMetadata | null | undefined> {
  try {
    const buf = await fs.readFile(target, "utf-8");
    const parsed = JSON.parse(buf) as Partial<WorktreeMetadata> | null;
    if (typeof parsed?.baseBranch !== "string" || typeof parsed.baseSha !== "string") {
      return null;
    }
    return { baseBranch: parsed.baseBranch, baseSha: parsed.baseSha };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
}

async function isLinkedWorktree(worktreePath: string): Promise<boolean> {
  const [gitDir, commonDir] = await Promise.all([
    revParseGitDir(worktreePath),
    revParseGitCommonDir(worktreePath),
  ]);
  return gitDir !== commonDir;
}
