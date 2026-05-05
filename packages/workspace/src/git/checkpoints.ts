import {
  deleteRef,
  forEachRefShort,
  refExists,
  resetHard,
  revParse,
  updateRef,
} from "./commands.js";

/**
 * Per-worktree checkpoint refs.
 *
 * `refs/worktree/*` is a per-worktree namespace in git: refs created here are
 * visible only to the worktree that created them, and are automatically
 * cleaned up when the worktree is removed (`git worktree remove`). This makes
 * checkpoints workspace-scoped without us having to manage cleanup ourselves.
 */
const CHECKPOINTS_PREFIX = "refs/worktree/agentex/checkpoints/";

function assertLabel(label: string): void {
  if (typeof label !== "string" || label.length === 0) {
    throw new Error("checkpoint: label must be a non-empty string");
  }
  if (
    label.includes(" ") ||
    label.includes("..") ||
    label.startsWith("/") ||
    label.endsWith("/")
  ) {
    throw new Error(`checkpoint: invalid label (got: ${JSON.stringify(label)})`);
  }
  // git ref-name validation is stricter than this; let git reject anything
  // that slips through with its native error message.
}

function refFor(label: string): string {
  return `${CHECKPOINTS_PREFIX}${label}`;
}

export async function createCheckpoint(workspacePath: string, label: string): Promise<void> {
  assertLabel(label);
  const head = await revParse(workspacePath, "HEAD");
  await updateRef(workspacePath, refFor(label), head);
}

export async function restoreCheckpoint(workspacePath: string, label: string): Promise<void> {
  assertLabel(label);
  const ref = refFor(label);
  if (!(await refExists(workspacePath, ref))) {
    throw new Error(`restore: checkpoint not found (label: ${label})`);
  }
  await resetHard(workspacePath, ref);
}

export async function listCheckpoints(workspacePath: string): Promise<string[]> {
  const refs = await forEachRefShort(workspacePath, CHECKPOINTS_PREFIX);
  return refs
    .filter((r) => r.startsWith(CHECKPOINTS_PREFIX))
    .map((r) => r.slice(CHECKPOINTS_PREFIX.length))
    .sort();
}

export async function deleteCheckpoint(workspacePath: string, label: string): Promise<void> {
  assertLabel(label);
  const ref = refFor(label);
  if (!(await refExists(workspacePath, ref))) return;
  await deleteRef(workspacePath, ref);
}
