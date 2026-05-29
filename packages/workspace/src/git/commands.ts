import { execFileResult, execFileSafe, type ExecFullResult, type ExecResult } from "../util/exec.js";

/**
 * Thin wrappers over `git` for the operations the workspace package needs.
 *
 * Every wrapper uses `execFile` with an args array (never shell strings).
 * Wrappers are leaf operations: they parse `stdout` when the command has a
 * scriptable surface, and otherwise return the raw `ExecResult` so callers can
 * inspect both stdout and stderr.
 *
 * Higher-level orchestration (mapping stderr patterns to typed errors,
 * sequencing worktree+sparse+checkout, retrying push without upstream) lives
 * in the per-feature modules under `git/` and in `workspace.ts`.
 */

/* -------------------------------------------------------------------------- */
/*                                    refs                                    */
/* -------------------------------------------------------------------------- */

export async function revParseGitDir(cwd: string): Promise<string> {
  const { stdout } = await execFileSafe("git", ["rev-parse", "--git-dir"], { cwd });
  return stdout.trim();
}

export async function revParse(cwd: string, ref: string): Promise<string> {
  const { stdout } = await execFileSafe("git", ["rev-parse", ref], { cwd });
  return stdout.trim();
}

export async function revParseGitPath(cwd: string, relative: string): Promise<string> {
  const { stdout } = await execFileSafe("git", ["rev-parse", "--git-path", relative], { cwd });
  return stdout.trim();
}

export async function getCurrentBranch(cwd: string): Promise<string> {
  const { stdout } = await execFileSafe("git", ["symbolic-ref", "--short", "HEAD"], { cwd });
  return stdout.trim();
}

export async function branchExists(cwd: string, branch: string): Promise<boolean> {
  try {
    await execFileSafe(
      "git",
      ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
      { cwd },
    );
    return true;
  } catch {
    return false;
  }
}

export async function branchDelete(
  cwd: string,
  branch: string,
  opts: { force?: boolean } = {},
): Promise<void> {
  // `-d` (lowercase) is the safe delete: git refuses with "not fully merged"
  // if the branch has commits that aren't reachable from its upstream or the
  // current HEAD — which is what protects against silently dropping unpushed,
  // unmerged work. `-D` skips that check and deletes unconditionally; callers
  // opt into it via `force: true` (they've explicitly accepted destruction).
  // Default (`force` undefined) is `-D` for the standalone primitive; the
  // archive flow always passes an explicit `force`.
  const flag = opts.force === false ? "-d" : "-D";
  await execFileSafe("git", ["branch", flag, branch], { cwd });
}

export async function refExists(cwd: string, ref: string): Promise<boolean> {
  try {
    await execFileSafe("git", ["show-ref", "--verify", "--quiet", ref], { cwd });
    return true;
  } catch {
    return false;
  }
}

export async function updateRef(cwd: string, ref: string, value: string): Promise<void> {
  await execFileSafe("git", ["update-ref", ref, value], { cwd });
}

export async function deleteRef(cwd: string, ref: string): Promise<void> {
  await execFileSafe("git", ["update-ref", "-d", ref], { cwd });
}

export async function forEachRefShort(cwd: string, prefix: string): Promise<string[]> {
  const { stdout } = await execFileSafe(
    "git",
    ["for-each-ref", "--format=%(refname)", prefix],
    { cwd },
  );
  return stdout.split("\n").filter((s) => s.length > 0);
}

/* -------------------------------------------------------------------------- */
/*                                  worktrees                                 */
/* -------------------------------------------------------------------------- */

export async function worktreeAdd(args: {
  cwd: string;
  path: string;
  branch: string;
  base: string;
  noCheckout?: boolean;
}): Promise<ExecResult> {
  const argv = ["worktree", "add"];
  if (args.noCheckout) argv.push("--no-checkout");
  argv.push(args.path, "-b", args.branch, args.base);
  return execFileSafe("git", argv, { cwd: args.cwd });
}

export async function worktreeRemove(args: {
  cwd: string;
  path: string;
  force?: boolean;
}): Promise<void> {
  const argv = ["worktree", "remove"];
  if (args.force) argv.push("--force");
  argv.push(args.path);
  await execFileSafe("git", argv, { cwd: args.cwd });
}

export async function worktreePrune(cwd: string): Promise<void> {
  await execFileSafe("git", ["worktree", "prune"], { cwd });
}

/* -------------------------------------------------------------------------- */
/*                              sparse-checkout                               */
/* -------------------------------------------------------------------------- */

export async function sparseCheckoutInit(cwd: string, mode: "cone" | "no-cone"): Promise<void> {
  const argv = ["sparse-checkout", "init"];
  if (mode === "cone") argv.push("--cone");
  else argv.push("--no-cone");
  await execFileSafe("git", argv, { cwd });
}

export async function sparseCheckoutSet(cwd: string, patterns: readonly string[]): Promise<void> {
  await execFileSafe("git", ["sparse-checkout", "set", ...patterns], { cwd });
}

export async function checkout(cwd: string, ref: string): Promise<void> {
  await execFileSafe("git", ["checkout", ref], { cwd });
}

/* -------------------------------------------------------------------------- */
/*                               status / diff                                */
/* -------------------------------------------------------------------------- */

export async function statusPorcelainV2(cwd: string): Promise<string> {
  const { stdout } = await execFileSafe(
    "git",
    ["status", "--porcelain=v2", "--branch", "-z"],
    { cwd },
  );
  return stdout;
}

export async function diffShortstat(cwd: string, vs: string): Promise<string> {
  const { stdout } = await execFileSafe("git", ["diff", "--shortstat", vs], { cwd });
  return stdout;
}

export async function diffPatch(cwd: string, vs: string): Promise<string> {
  const { stdout } = await execFileSafe(
    "git",
    [
      // -c core.quotePath=false disables high-bit-character path quoting; we
      // still handle the (separate) double-quote-on-spaces form in the parser.
      "-c",
      "core.quotePath=false",
      "diff",
      "--no-color",
      "--no-ext-diff",
      "--find-renames",
      "--unified=3",
      vs,
    ],
    { cwd },
  );
  return stdout;
}

export async function unmergedFiles(cwd: string): Promise<string[]> {
  const { stdout } = await execFileSafe(
    "git",
    ["diff", "--name-only", "--diff-filter=U", "-z"],
    { cwd },
  );
  return stdout.split("\0").filter((s) => s.length > 0);
}

export async function listUntracked(cwd: string): Promise<string[]> {
  const { stdout } = await execFileSafe(
    "git",
    ["ls-files", "--others", "--exclude-standard", "-z"],
    { cwd },
  );
  return stdout.split("\0").filter((s) => s.length > 0);
}

/* -------------------------------------------------------------------------- */
/*                            index-write / commit                            */
/* -------------------------------------------------------------------------- */

export async function addAll(cwd: string): Promise<void> {
  await execFileSafe("git", ["add", "-A"], { cwd });
}

export async function commitMessage(cwd: string, message: string): Promise<void> {
  await execFileSafe("git", ["commit", "-m", message], { cwd });
}

export async function resetHard(cwd: string, ref: string): Promise<void> {
  await execFileSafe("git", ["reset", "--hard", ref], { cwd });
}

/* -------------------------------------------------------------------------- */
/*                            remote sync (low-level)                         */
/* -------------------------------------------------------------------------- */

export async function pushDefault(cwd: string): Promise<void> {
  await execFileSafe("git", ["push"], { cwd });
}

export async function pushSetUpstream(cwd: string, remote: string, branch: string): Promise<void> {
  await execFileSafe("git", ["push", "--set-upstream", remote, branch], { cwd });
}

export async function fetchRef(cwd: string, remote: string, ref: string): Promise<void> {
  await execFileSafe("git", ["fetch", remote, ref], { cwd });
}

export async function mergeRef(cwd: string, ref: string): Promise<void> {
  await execFileSafe("git", ["merge", "--no-edit", ref], { cwd });
}

export async function rebaseOnto(cwd: string, ref: string): Promise<void> {
  await execFileSafe("git", ["rebase", ref], { cwd });
}

export async function mergeAbort(cwd: string): Promise<void> {
  try {
    await execFileSafe("git", ["merge", "--abort"], { cwd });
  } catch {
    // no-op — no merge in progress
  }
}

export async function rebaseAbort(cwd: string): Promise<void> {
  try {
    await execFileSafe("git", ["rebase", "--abort"], { cwd });
  } catch {
    // no-op — no rebase in progress
  }
}

/* -------------------------------------------------------------------------- */
/*                                  remotes                                   */
/* -------------------------------------------------------------------------- */

export async function remoteAdd(cwd: string, name: string, url: string): Promise<void> {
  await execFileSafe("git", ["remote", "add", name, url], { cwd });
}

export async function remoteSetUrl(cwd: string, name: string, url: string): Promise<void> {
  await execFileSafe("git", ["remote", "set-url", name, url], { cwd });
}

export async function remoteExists(cwd: string, name: string): Promise<boolean> {
  try {
    await execFileSafe("git", ["remote", "get-url", name], { cwd });
    return true;
  } catch {
    return false;
  }
}

/* -------------------------------------------------------------------------- */
/*                                escape hatch                                */
/* -------------------------------------------------------------------------- */

/**
 * Run `git <args>` against `cwd` and return the full `{stdout, stderr, exitCode}`
 * — non-zero exits do not throw. Used by `ws.git.raw` so consumers can drop
 * down to git operations the typed surface doesn't cover without losing
 * cwd correctness or process safety (no shell interpolation).
 */
export async function rawGit(cwd: string, args: readonly string[]): Promise<ExecFullResult> {
  return execFileResult("git", args, { cwd });
}
