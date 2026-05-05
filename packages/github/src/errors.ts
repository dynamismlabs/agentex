/**
 * Typed errors thrown by `@agentex/github` operations.
 *
 * Where `gh` produces stderr output, the raw text is also exposed via the
 * standard `Error#cause` slot so consumers can log it for debugging without
 * having to dig into properties.
 */

export class NotInstalledError extends Error {
  override readonly name = "NotInstalledError";
  constructor() {
    super("`gh` CLI is not installed or not on PATH. Install it from https://cli.github.com/.");
  }
}

export class NotAuthenticatedError extends Error {
  override readonly name = "NotAuthenticatedError";
  readonly host: string | undefined;
  constructor(host?: string) {
    super(
      host
        ? `Not authenticated to ${host}. Run \`gh auth login\` to sign in.`
        : "Not authenticated to GitHub. Run `gh auth login` to sign in.",
    );
    this.host = host;
  }
}

export class RateLimitedError extends Error {
  override readonly name = "RateLimitedError";
  readonly stderr: string;
  constructor(stderr: string) {
    super("GitHub API rate limit exceeded. Retry after the limit resets.", { cause: stderr });
    this.stderr = stderr;
  }
}

export class RepoNotFoundError extends Error {
  override readonly name = "RepoNotFoundError";
  readonly stderr: string;
  constructor(stderr: string) {
    super(`GitHub repository could not be resolved: ${firstLine(stderr)}`, { cause: stderr });
    this.stderr = stderr;
  }
}

export class BranchNotFoundError extends Error {
  override readonly name = "BranchNotFoundError";
  readonly stderr: string;
  constructor(stderr: string) {
    super(`Branch not found on remote: ${firstLine(stderr)}`, { cause: stderr });
    this.stderr = stderr;
  }
}

/**
 * Generic fallback for `gh` failures that don't match a typed pattern. Holds
 * the raw stderr/stdout so consumers can surface diagnostics. The standard
 * `Error#cause` carries `stderr` for log-aggregation tools that read it.
 */
export class GhCommandError extends Error {
  override readonly name = "GhCommandError";
  readonly args: readonly string[];
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  constructor(args: readonly string[], exitCode: number, stdout: string, stderr: string) {
    const summary = firstLine(stderr.trim() || stdout.trim()) || "(no output)";
    super(`gh ${args.join(" ")}: exit ${exitCode} — ${summary}`, { cause: stderr });
    this.args = args;
    this.exitCode = exitCode;
    this.stdout = stdout;
    this.stderr = stderr;
  }
}

function firstLine(s: string): string {
  return s.split("\n")[0] ?? "";
}
