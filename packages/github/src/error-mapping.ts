import {
  BranchNotFoundError,
  GhCommandError,
  NotAuthenticatedError,
  RateLimitedError,
  RepoNotFoundError,
} from "./errors.js";
import type { GhExecResult } from "./internal/gh-exec.js";

/**
 * Map a non-zero `gh` execution result to a typed error. Falls back to a
 * generic `GhCommandError` so callers always receive a typed thrown value.
 */
export function mapAndThrow(args: readonly string[], r: GhExecResult): never {
  const stderrLc = r.stderr.toLowerCase();

  if (
    r.exitCode === 4 ||
    stderrLc.includes("not authenticated") ||
    stderrLc.includes("authentication required") ||
    stderrLc.includes("authentication token") ||
    stderrLc.includes("you are not logged into") ||
    stderrLc.includes("could not prompt") /* gh auth status hits this when no creds */
  ) {
    throw new NotAuthenticatedError();
  }

  if (stderrLc.includes("rate limit") || stderrLc.includes("api rate limit exceeded")) {
    throw new RateLimitedError(r.stderr);
  }

  if (
    stderrLc.includes("could not resolve to a repository") ||
    stderrLc.includes("repository not found") ||
    stderrLc.includes("could not resolve") ||
    stderrLc.includes("no repositories found")
  ) {
    throw new RepoNotFoundError(r.stderr);
  }

  if (
    (stderrLc.includes("branch") && stderrLc.includes("not found")) ||
    stderrLc.includes("no commits between") ||
    stderrLc.includes("must first push the current branch")
  ) {
    throw new BranchNotFoundError(r.stderr);
  }

  throw new GhCommandError(args, r.exitCode, r.stdout, r.stderr);
}
