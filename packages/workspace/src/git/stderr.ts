/**
 * Helpers for inspecting `child_process` errors thrown by `execFile("git", ...)`.
 *
 * Centralized so the various places that map `git` failures to typed errors
 * (workspace.create's branch-exists path, commit-push's no-upstream path) all
 * pull from one source of truth.
 */

export function readStderrFromUnknown(err: unknown): string {
  if (err && typeof err === "object" && "stderr" in err) {
    const raw = (err as { stderr: unknown }).stderr;
    if (typeof raw === "string") return raw;
    if (raw instanceof Buffer) return raw.toString();
  }
  return "";
}

export function looksLikeBranchExists(stderr: string, branch: string): boolean {
  if (stderr.length === 0) return false;
  const lc = stderr.toLowerCase();
  const lcBranch = branch.toLowerCase();
  if (lc.includes(`a branch named '${lcBranch}' already exists`)) return true;
  if (lc.includes(`'${lcBranch}' is already checked out at`)) return true;
  return false;
}

export function looksLikeNoUpstream(stderr: string): boolean {
  if (stderr.length === 0) return false;
  const lc = stderr.toLowerCase();
  return (
    lc.includes("has no upstream branch") ||
    lc.includes("--set-upstream") ||
    lc.includes("set-upstream")
  );
}
