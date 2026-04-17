import * as os from "node:os";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { uuidv7 } from "./uuid.js";

const exec = promisify(execFile);

export interface WorkspaceOptions {
  /** Isolation strategy */
  strategy: "worktree";
  /** Base branch to create worktree from (default: current HEAD) */
  baseBranch?: string;
  /** Custom branch name (default: auto-generated) */
  branchName?: string;
  /** Custom directory for the worktree (default: os.tmpdir()) */
  targetDir?: string;
}

export interface DiffOptions {
  /** Ref to compare against (default: the base branch used when creating the worktree). */
  base?: string;
  /**
   * What to include in the diff:
   * - "all"         — committed + uncommitted + untracked (default)
   * - "committed"   — only changes committed to the worktree branch vs base
   * - "uncommitted" — only staged + unstaged changes in the working tree
   * - "untracked"   — only new files not yet tracked by git
   */
  scope?: "all" | "committed" | "uncommitted" | "untracked";
  /** Return `--stat` summary instead of full patch. */
  stat?: boolean;
}

export interface PreparedWorkspace {
  /** Path to the worktree directory — use as `cwd` for execute() */
  cwd: string;
  /** Branch name created for this worktree */
  branch: string;
  /** The strategy that was used */
  strategy: "worktree";
  /** The original repo path */
  originalCwd: string;
  /**
   * Get a unified diff of changes in this worktree.
   *
   * With no arguments, returns everything that changed (committed + uncommitted + untracked).
   * Use `options.scope` to narrow, `options.base` to compare against a different ref,
   * or `options.stat` for a summary.
   */
  diff(options?: DiffOptions | string): Promise<string>;
  /** Remove the worktree and optionally delete the branch */
  cleanup(options?: { deleteBranch?: boolean }): Promise<void>;
}

/**
 * Create an isolated workspace for agent execution.
 *
 * Uses `git worktree add` to create a lightweight checkout on a new branch.
 * The worktree shares git history with the original repo, so diffs, merges,
 * and PRs all work normally.
 */
export async function prepareWorkspace(
  cwd: string,
  options: WorkspaceOptions,
): Promise<PreparedWorkspace> {
  // Validate git repo
  try {
    await exec("git", ["rev-parse", "--git-dir"], { cwd });
  } catch {
    throw new Error(`Not a git repository: ${cwd}`);
  }

  const shortId = uuidv7().slice(0, 8);
  const branch = options.branchName ?? `agentex/${Date.now()}-${shortId}`;
  const targetDir = options.targetDir ?? path.join(os.tmpdir(), `agentex-ws-${shortId}`);

  // Create worktree
  const worktreeArgs = ["worktree", "add", targetDir, "-b", branch];
  if (options.baseBranch) {
    worktreeArgs.push(options.baseBranch);
  }
  await exec("git", worktreeArgs, { cwd });

  const baseBranch = options.baseBranch ?? "main";

  return {
    cwd: targetDir,
    branch,
    strategy: "worktree",
    originalCwd: cwd,

    async diff(optionsOrBase?: DiffOptions | string): Promise<string> {
      const opts: DiffOptions = typeof optionsOrBase === "string"
        ? { base: optionsOrBase }
        : optionsOrBase ?? {};
      const diffBase = opts.base ?? baseBranch;
      const scope = opts.scope ?? "all";
      const statFlag = opts.stat ? ["--stat"] : [];

      const parts: string[] = [];

      // Committed changes: base...branch (only commits on the branch)
      if (scope === "all" || scope === "committed") {
        const { stdout } = await exec(
          "git", ["diff", ...statFlag, `${diffBase}...${branch}`],
          { cwd },
        );
        if (stdout.trim()) parts.push(stdout);
      }

      // Uncommitted changes: staged + unstaged vs HEAD
      if (scope === "all" || scope === "uncommitted") {
        const { stdout } = await exec(
          "git", ["diff", ...statFlag, "HEAD"],
          { cwd: targetDir },
        );
        if (stdout.trim()) parts.push(stdout);
      }

      // Untracked files: new files not yet staged
      if (scope === "all" || scope === "untracked") {
        const { stdout: untrackedRaw } = await exec(
          "git", ["ls-files", "--others", "--exclude-standard"],
          { cwd: targetDir },
        );
        const untrackedFiles = untrackedRaw.split("\n").filter(Boolean);

        if (opts.stat) {
          // Stat mode: just list filenames with (new) marker
          for (const f of untrackedFiles) {
            parts.push(` ${f} (new file)`);
          }
        } else if (untrackedFiles.length > 0) {
          // Full diff: use git diff with --no-index against /dev/null in a single call
          // Stage temporarily, diff, then unstage — faster than per-file diff
          await exec("git", ["add", "--intent-to-add", ...untrackedFiles], { cwd: targetDir });
          const { stdout } = await exec("git", ["diff", ...untrackedFiles], { cwd: targetDir });
          await exec("git", ["reset", "HEAD", ...untrackedFiles], { cwd: targetDir });
          if (stdout.trim()) parts.push(stdout);
        }
      }

      return parts.join("\n");
    },

    async cleanup(opts?: { deleteBranch?: boolean }): Promise<void> {
      await exec("git", ["worktree", "remove", targetDir, "--force"], { cwd });
      if (opts?.deleteBranch) {
        await exec("git", ["branch", "-D", branch], { cwd }).catch(() => {
          // Branch may already be deleted or not exist
        });
      }
    },
  };
}
