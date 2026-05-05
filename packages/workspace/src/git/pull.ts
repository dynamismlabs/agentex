import { MergeConflictError } from "../errors.js";
import {
  fetchRef,
  mergeRef,
  rebaseOnto,
  unmergedFiles,
} from "./commands.js";

const DEFAULT_REMOTE = "origin";

/**
 * Run `merge` or `rebase` against `ref` in `cwd`. On conflict, throws
 * `MergeConflictError({ files })` with the unmerged file list and leaves the
 * worktree in the conflicting state for the consumer to resolve.
 */
async function integrateRef(
  cwd: string,
  ref: string,
  strategy: "merge" | "rebase",
): Promise<void> {
  try {
    if (strategy === "rebase") {
      await rebaseOnto(cwd, ref);
    } else {
      await mergeRef(cwd, ref);
    }
  } catch (err) {
    const conflicts = await unmergedFiles(cwd);
    if (conflicts.length > 0) {
      throw new MergeConflictError(conflicts);
    }
    throw err;
  }
}

/**
 * Fetch `base` from `origin`, then integrate it into the current branch via
 * merge (default) or rebase.
 */
export async function pullLatestBaseInto(args: {
  workspacePath: string;
  base: string;
  strategy: "merge" | "rebase";
}): Promise<void> {
  await fetchRef(args.workspacePath, DEFAULT_REMOTE, args.base);
  const target = `${DEFAULT_REMOTE}/${args.base}`;
  await integrateRef(args.workspacePath, target, args.strategy);
}

/**
 * Merge (or rebase) an arbitrary local `ref` *into* the current branch. Same
 * conflict semantics as `pullLatestBaseInto`. No fetch — `ref` must already
 * be reachable from the local repo.
 */
export async function mergeFromInto(args: {
  workspacePath: string;
  ref: string;
  strategy: "merge" | "rebase";
}): Promise<void> {
  await integrateRef(args.workspacePath, args.ref, args.strategy);
}
