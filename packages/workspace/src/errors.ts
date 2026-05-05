import type { WorkspaceStatus } from "./types.js";

export class WorkspaceNotFoundError extends Error {
  override readonly name = "WorkspaceNotFoundError";
  readonly path: string;
  constructor(path: string) {
    super(`Workspace not found: ${path}`);
    this.path = path;
  }
}

export class BranchExistsError extends Error {
  override readonly name = "BranchExistsError";
  readonly branch: string;
  constructor(branch: string) {
    super(`Branch already exists: ${branch}`);
    this.branch = branch;
  }
}

export class NotAGitRepoError extends Error {
  override readonly name = "NotAGitRepoError";
  readonly path: string;
  constructor(path: string) {
    super(`Path is not a git repository: ${path}`);
    this.path = path;
  }
}

export class SourceNotProvidedError extends Error {
  override readonly name = "SourceNotProvidedError";
  constructor() {
    super(
      "copyFromSource / linkFromSource require a workspace created with a `source` (or opened with { source }).",
    );
  }
}

export class SourceFileMissingError extends Error {
  override readonly name = "SourceFileMissingError";
  readonly path: string;
  constructor(path: string) {
    super(`Source file or directory does not exist: ${path}`);
    this.path = path;
  }
}

/**
 * Thrown by `linkFromSource` when the destination already exists as a real
 * directory (not a symlink). The library refuses to recursively delete real
 * directory contents — consumers who want that must `fs.rm` first.
 */
export class LinkDestinationConflictError extends Error {
  override readonly name = "LinkDestinationConflictError";
  readonly dest: string;
  constructor(dest: string) {
    super(
      `linkFromSource: destination already exists as a directory; refusing to overwrite. Remove it manually first if you intend to replace it: ${dest}`,
    );
    this.dest = dest;
  }
}

export class ScriptNotFoundError extends Error {
  override readonly name = "ScriptNotFoundError";
  readonly script: string;
  readonly available: string[];
  constructor(script: string, available: string[]) {
    super(
      `No script named "${script}" in agentex.workspace.json. Available: ${available.length === 0 ? "(none)" : available.join(", ")}`,
    );
    this.script = script;
    this.available = available;
  }
}

/**
 * Thrown by `runScript` when the named script exists in the config but its
 * value is empty/whitespace. Distinct from `ScriptNotFoundError` so consumers
 * can distinguish "you misspelled the name" from "the entry is intentionally
 * empty / commented out."
 */
export class EmptyScriptError extends Error {
  override readonly name = "EmptyScriptError";
  readonly script: string;
  constructor(script: string) {
    super(`Script "${script}" is configured but has an empty/whitespace command.`);
    this.script = script;
  }
}

export class DirtyWorktreeError extends Error {
  override readonly name = "DirtyWorktreeError";
  readonly status: WorkspaceStatus;
  constructor(status: WorkspaceStatus) {
    const summary = [
      status.untracked.length > 0 ? `${status.untracked.length} untracked` : null,
      status.modified.length > 0 ? `${status.modified.length} modified` : null,
      status.staged.length > 0 ? `${status.staged.length} staged` : null,
      status.ahead > 0 ? `${status.ahead} commits ahead of remote` : null,
    ]
      .filter(Boolean)
      .join(", ");
    super(`Workspace has uncommitted or unpushed work: ${summary || "(unknown)"}`);
    this.status = status;
  }
}

export class MergeConflictError extends Error {
  override readonly name = "MergeConflictError";
  readonly files: string[];
  constructor(files: string[]) {
    super(
      `Merge conflict in ${files.length} file(s): ${files.slice(0, 5).join(", ")}${files.length > 5 ? ", ..." : ""}`,
    );
    this.files = files;
  }
}

export class NoDefaultBranchError extends Error {
  override readonly name = "NoDefaultBranchError";
  readonly path: string;
  readonly remote: string;
  constructor(path: string, remote: string) {
    super(
      `Could not resolve a default branch for "${remote}" at ${path} (tried ${remote}/HEAD, ${remote}/main, ${remote}/master, init.defaultBranch).`,
    );
    this.path = path;
    this.remote = remote;
  }
}

export class MalformedConfigError extends Error {
  override readonly name = "MalformedConfigError";
  readonly path: string;
  constructor(p: string, cause: unknown) {
    super(`agentex.workspace.json at ${p} is not valid JSON`, { cause });
    this.path = p;
  }
}

export class RemoteAlreadyExistsError extends Error {
  override readonly name = "RemoteAlreadyExistsError";
  readonly remote: string;
  constructor(remote: string) {
    super(`Remote already exists: ${remote}`);
    this.remote = remote;
  }
}

export class ArchiveScriptFailedError extends Error {
  override readonly name = "ArchiveScriptFailedError";
  readonly script: string;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stderr: string;
  constructor(args: {
    script: string;
    exitCode: number | null;
    signal: NodeJS.Signals | null;
    stderr: string;
  }) {
    const reason =
      args.exitCode != null
        ? `exit ${args.exitCode}`
        : args.signal != null
        ? `signal ${args.signal}`
        : "unknown failure";
    super(`Archive script failed (${reason}): ${args.script}`);
    this.script = args.script;
    this.exitCode = args.exitCode;
    this.signal = args.signal;
    this.stderr = args.stderr;
  }
}
