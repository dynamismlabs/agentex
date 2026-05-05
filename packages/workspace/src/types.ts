/**
 * Public type surface for `@agentex/workspace`.
 *
 * `Workspace` is a discriminated union by `kind`. Both flavors share a common
 * surface (`context`, `ports`, `runScript`, `tree`, `watch`,
 * `copyFromSource`, `linkFromSource`, `fromSourceWarnings`); the git flavor
 * adds `git` with branch/diff/status/checkpoint operations.
 */

export type WorkspaceKind = "bare" | "git";

export interface ContextDir {
  /** Absolute path to `<workspace>/.context`. The directory is lazy — not created until first write. */
  readonly dir: string;
  /** Read a file relative to `.context/`. Throws if missing. */
  read(rel: string): Promise<string>;
  /** Write a file relative to `.context/`. Creates `.context/` and any parent dirs on first write. */
  write(rel: string, body: string): Promise<void>;
  /**
   * Copy `srcPath` into `.context/attachments/`, preserving the basename. If a
   * file with that name already exists, the destination gets a collision suffix
   * (e.g. `file (2).txt`). Returns the absolute path of the written attachment.
   */
  attach(srcPath: string): Promise<string>;
  /** List files and directories under `.context/<subdir?>`. Returns `[]` if `.context/` does not exist. */
  list(subdir?: string): Promise<string[]>;
}

export interface PortAllocator {
  /**
   * Allocate `count` free TCP ports on the loopback interface. The library
   * probes the OS for free ports, then records them in an in-process held set.
   *
   * Note: this is a "recently free" guarantee, not a reservation — once
   * `allocate` returns, the port is technically available to other processes.
   * The expected usage is to bind to the returned port immediately.
   */
  allocate(count: number): Promise<number[]>;
  /** Release a previously-allocated port from the held set. */
  release(port: number): void;
  /** Snapshot of currently-held ports. */
  held(): number[];
}

export interface FromSourceWarnings {
  /**
   * Relative paths skipped because their destination directory is excluded by
   * the worktree's sparse-checkout. Populated by `copyFromSource`,
   * `linkFromSource`, and the auto-apply of `fromSource` config at
   * `workspace.create`. Append-only across calls within a session.
   */
  readonly skippedOutsideSparse: string[];
}

export interface WorkspaceStatus {
  /** True if any of `untracked`, `modified`, or `staged` is non-empty. */
  readonly dirty: boolean;
  readonly untracked: string[];
  readonly modified: string[];
  readonly staged: string[];
  /** Commits on this branch not yet pushed to its upstream. `0` if no upstream. */
  readonly ahead: number;
  /** Commits on the upstream not yet on this branch. `0` if no upstream. */
  readonly behind: number;
}

export interface ShortStat {
  readonly files: number;
  readonly additions: number;
  readonly deletions: number;
}

/**
 * What to compare against when computing diffs/shortstats.
 * - `"base"` — compare against the workspace's atomic `baseSha`.
 * - `{ checkpoint }` — compare against the workspace-scoped checkpoint ref.
 */
export type DiffSpec = "base" | { checkpoint: string };

export interface PullLatestBaseOptions {
  /** Default `"merge"` (safer; no history rewrite). */
  strategy?: "merge" | "rebase";
}

export interface StructuredDiffLine {
  readonly kind: "add" | "del" | "ctx";
  readonly text: string;
}

export interface StructuredDiffHunk {
  readonly oldStart: number;
  readonly oldLines: number;
  readonly newStart: number;
  readonly newLines: number;
  readonly lines: readonly StructuredDiffLine[];
}

export interface StructuredDiffFile {
  readonly path: string;
  readonly status: "added" | "modified" | "deleted" | "renamed";
  readonly oldPath?: string;
  readonly hunks: readonly StructuredDiffHunk[];
}

export interface StructuredDiff {
  readonly files: readonly StructuredDiffFile[];
}

export interface TreeNode {
  readonly name: string;
  /** Absolute path. */
  readonly path: string;
  readonly kind: "file" | "dir";
  /** Present (sorted alphabetically) only when `kind === "dir"`. */
  readonly children?: readonly TreeNode[];
}

export type WatchEventKind = "add" | "remove" | "modify";

export interface WatchEvent {
  readonly kind: WatchEventKind;
  /** Absolute path of the changed entry. */
  readonly path: string;
}

export type WatchHandler = (events: WatchEvent[]) => void;

export interface WatchOptions {
  /**
   * Invoked when the underlying watcher emits an error, or when `handler`
   * throws. If omitted, errors are logged to `console.error` and the watcher
   * continues.
   */
  onError?: (err: unknown) => void;
}

export interface WatchSubscription {
  /**
   * Resolves once the underlying recursive scan is up — events for changes
   * after this point are guaranteed to be delivered. Events for changes
   * during initialization are not surfaced (the watcher uses `ignoreInitial`).
   */
  readonly ready: Promise<void>;
  /** Stop the watcher; idempotent. Drops any pending batch without delivering. */
  dispose(): void;
}

/** @deprecated Kept for backward compatibility — use `WatchSubscription`'s `dispose` directly. */
export type Disposer = () => void;

export interface GitCapability {
  /** Current branch on this worktree. */
  readonly branch: string;
  /** Base branch the worktree was created from. */
  readonly base: string;
  /**
   * SHA the base branch resolved to. On `workspace.create` this is captured
   * atomically with the worktree-add (the immutable "what we branched from").
   * On `workspace.open` without metadata, it may be derived freshly via
   * `git rev-parse <baseBranch>` — see `baseShaIsFreshlyDerived`.
   */
  readonly baseSha: string;
  /**
   * `true` when `baseSha` was derived at `workspace.open` time from `baseBranch`
   * (because the per-worktree metadata file was missing). `false` (or `undefined`)
   * when `baseSha` came from the metadata written at create time. Consumers
   * tracking "what we branched from" should treat freshly-derived values as
   * "best guess" rather than authoritative.
   */
  readonly baseShaIsFreshlyDerived?: boolean;

  /**
   * Snapshot of the worktree's status: untracked/modified/staged file lists
   * plus ahead/behind counts vs the upstream. The basis for safe-archive
   * checks, "uncommitted changes" warnings, and remote-divergence indicators.
   */
  status(): Promise<WorkspaceStatus>;

  /**
   * Cheap `{files, additions, deletions}` count of tracked changes between
   * `vs` and the current working tree (committed + staged + unstaged).
   * Untracked files are not counted.
   */
  shortstat(vs: DiffSpec): Promise<ShortStat>;

  /**
   * Stage **everything** in the worktree (`git add -A` — tracked + untracked
   * + deletions) and commit with the given message. Right shape for "agent
   * finished a task; snapshot the result." If you need staged-only or
   * tracked-only commits, drop to `ws.git.raw(["commit", ...])`.
   *
   * Throws if the workspace has nothing to commit.
   */
  commit(message: string): Promise<void>;

  /**
   * Push the current branch to `origin`. If the branch has no upstream, sets
   * `origin/<branch>` as the upstream on first push.
   */
  push(): Promise<void>;

  /**
   * Fetch the latest of `base` from `origin` and merge (default) or rebase it
   * into the current branch. On conflicts, throws `MergeConflictError({
   * files })`. The conflicting state is left in place so a consumer can route
   * resolution to the agent or the user.
   */
  pullLatestBase(opts?: PullLatestBaseOptions): Promise<void>;

  /**
   * Structured diff of the working tree (committed + staged + unstaged + new)
   * against `vs`. Includes untracked files as synthetic `"added"` entries with
   * a single all-`"add"` hunk so consumers can render them alongside tracked
   * changes. Binary files are reported with `status` set but no hunks.
   */
  diff(vs: DiffSpec): Promise<StructuredDiff>;

  /**
   * Snapshot the worktree's current `HEAD` as a per-worktree ref under
   * `refs/worktree/agentex/checkpoints/<label>`. Local to this worktree only —
   * not visible to sibling worktrees of the same source, and auto-cleaned on
   * `git worktree remove`. Subsequent `restore(label)` does `git reset --hard`
   * back to it.
   */
  checkpoint(label: string): Promise<void>;

  /**
   * Reset `HEAD` to the workspace's `<label>` checkpoint (`git reset --hard`).
   * Throws if the checkpoint does not exist.
   */
  restore(label: string): Promise<void>;

  /** Names of all checkpoints currently recorded for this worktree. */
  checkpoints(): Promise<string[]>;

  /** Delete the workspace's `<label>` checkpoint. No-op if it doesn't exist. */
  deleteCheckpoint(label: string): Promise<void>;

  /**
   * Switch the worktree's `HEAD` to `ref` (a branch name, tag, or SHA).
   * Wraps `git checkout`; if the switch would clobber uncommitted changes,
   * git's own error message bubbles up.
   */
  checkout(ref: string): Promise<void>;

  /**
   * Merge (or rebase) `ref` *into* the current branch. Same conflict
   * semantics as `pullLatestBase` — throws `MergeConflictError({ files })`
   * on conflict and leaves the worktree in the conflicting state for the
   * consumer (or agent) to resolve.
   */
  mergeFrom(ref: string, opts?: { strategy?: "merge" | "rebase" }): Promise<void>;

  /**
   * Add a new remote pointing at `url`. Throws `RemoteAlreadyExistsError`
   * if a remote with that name already exists. Use `setOrigin` for an
   * idempotent upsert of `origin`.
   */
  addRemote(name: string, url: string): Promise<void>;

  /** Idempotent upsert: set `origin` to `url`, creating it if missing or updating it if present. */
  setOrigin(url: string): Promise<void>;

  /**
   * Escape hatch for git operations the typed surface doesn't cover
   * (e.g. `subtree`, `blame`, `log`, `stash`). The `args` are passed to
   * `git` as an array — never shell-interpolated — so user-supplied values
   * cannot inject. Returns the full result; non-zero exits are *not*
   * thrown — the consumer decides how to handle them.
   */
  raw(args: readonly string[]): Promise<GitRawResult>;
}

export interface GitRawResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

export interface RunHandle {
  /** PID of the spawned shell that leads the script's process group. */
  readonly pid: number;
  /**
   * Combined stdout + stderr as a Web `ReadableStream<Uint8Array>`. The two
   * channels are interleaved in arrival order. The stream ends when both
   * child pipes close (i.e. the script has finished writing).
   */
  readonly output: ReadableStream<Uint8Array>;
  /**
   * Send a signal to the entire process group (default `SIGTERM`). Resolves
   * once the leader has exited. Idempotent — subsequent calls await the same
   * exit.
   */
  kill(signal?: NodeJS.Signals): Promise<void>;
}

interface CommonWorkspace {
  readonly path: string;
  readonly context: ContextDir;
  readonly ports: PortAllocator;
  readonly fromSourceWarnings: FromSourceWarnings;
  /**
   * Copy files from `source` into the workspace. `globs` is matched against
   * source's files (picomatch dialect, dot-aware). Existing destinations are
   * overwritten (`cp -f`).
   *
   * Throws `SourceNotProvidedError` if the workspace was created without a
   * `source`. Throws `SourceFileMissingError` if a matched source vanishes
   * between scan and copy.
   */
  copyFromSource(globs: readonly string[]): Promise<void>;
  /**
   * Symlink each entry from `source` into the same relative location inside
   * the workspace. An existing symlink or file at the destination is replaced
   * (`ln -sf`). An existing **real directory** at the destination throws
   * `LinkDestinationConflictError` rather than being recursively deleted —
   * consumers who want to replace real directories must `fs.rm` them first.
   *
   * Throws `SourceNotProvidedError` if the workspace was created without a
   * `source`. Throws `SourceFileMissingError` if any entry's source path
   * does not exist (no silent broken symlinks).
   */
  linkFromSource(paths: readonly string[]): Promise<void>;
  /**
   * Spawn `scripts.<name>` from `agentex.workspace.json` as a long-running
   * subprocess in its own process group. Returns a `RunHandle` whose `kill()`
   * tears down the entire group.
   *
   * Throws `ScriptNotFoundError` when the name is not in the config.
   * Throws `EmptyScriptError` when the name maps to an empty/whitespace
   * command (the entry exists but has no body).
   *
   * Env: the script sees `AGENTEX_WORKSPACE`, `AGENTEX_SOURCE` (when the
   * workspace has a source), and `AGENTEX_PORT` (set to `ws.ports.held()[0]`
   * — i.e. the first port the consumer has already allocated). **Allocate
   * before calling** if your script reads `$AGENTEX_PORT`; otherwise the env
   * var won't be set.
   */
  runScript(name: string): Promise<RunHandle>;

  /**
   * Eagerly walk the workspace and return a structured tree. Always skips
   * `.git/` (at every depth). No other filtering — consumers decide what to
   * hide for display.
   */
  tree(): Promise<TreeNode>;

  /**
   * Watch the workspace recursively and call `handler` with batched events
   * (debounced ~100ms). Returns a `WatchSubscription` whose `dispose()` stops
   * the watcher and whose `ready` resolves once the initial scan is complete.
   *
   * `.git/` is always ignored. Watcher and handler errors route to
   * `opts.onError` if provided, else `console.error`.
   */
  watch(handler: WatchHandler, opts?: WatchOptions): WatchSubscription;
}

export interface BareWorkspace extends CommonWorkspace {
  readonly kind: "bare";
  readonly source: string | undefined;
}

export interface GitWorkspace extends CommonWorkspace {
  readonly kind: "git";
  readonly source: string;
  readonly git: GitCapability;
}

export type Workspace = BareWorkspace | GitWorkspace;

interface CommonCreateOptions {
  /**
   * If `true` (the default), the library applies `agentex.workspace.json`'s
   * `fromSource` block automatically at the end of `workspace.create` (after
   * the worktree/dir is set up, before any consumer-driven `runScript` calls).
   * Set to `false` if the consumer wants to call `copyFromSource` /
   * `linkFromSource` themselves.
   */
  applyFromSource?: boolean;
}

export interface CreateBareOptions extends CommonCreateOptions {
  kind: "bare";
  /** Absolute path to the workspace directory. Created if missing; used as-is if present. */
  path: string;
  /** Optional absolute path to the original source. Required for `copyFromSource` / `linkFromSource`. */
  source?: string;
}

export interface CreateGitOptions extends CommonCreateOptions {
  kind: "git";
  /** Absolute path to the source git repo. Must be a git repository. */
  source: string;
  /** Base branch the worktree is created from. Must exist in `source`. */
  baseBranch: string;
  /** Absolute path where the worktree will be created. Must not exist (or must be empty) per `git worktree add`. */
  path: string;
  /** New branch name to create on the worktree. Throws `BranchExistsError` if it already exists. */
  branch: string;
  /**
   * Optional cone-mode sparse-checkout patterns (directory paths) to limit
   * which subset of the source is materialized in the worktree. Each entry is
   * passed to `git sparse-checkout set` after init.
   */
  sparseInclude?: string[];
}

export type CreateOptions = CreateBareOptions | CreateGitOptions;

export interface OpenOptions {
  /**
   * Optional absolute path to the original source. The library does not write
   * a marker file for bare workspaces, so `source` cannot be recovered from
   * disk. Pass it in if `copyFromSource` / `linkFromSource` should work on the
   * reopened bare handle.
   *
   * For git workspaces, the source is auto-resolved from the worktree's `.git`
   * pointer; this opt is an override.
   */
  source?: string;
  /**
   * For git workspaces only. If omitted, the library reads the worktree's
   * per-worktree metadata file written at create time. Pass this in to override
   * (e.g. for a worktree created by another tool that doesn't write our metadata).
   */
  baseBranch?: string;
  /**
   * For git workspaces only. If omitted *and* the per-worktree metadata file
   * exists, its `baseSha` is used. If omitted *and* metadata is missing but
   * `baseBranch` is supplied (or readable from metadata), the library derives
   * `baseSha` freshly via `git rev-parse <baseBranch>` and sets
   * `git.baseShaIsFreshlyDerived = true` on the handle.
   */
  baseSha?: string;
}

export interface ArchiveOptions {
  /**
   * Skip the dirty-check on git workspaces and use `git worktree remove --force`.
   * Default behavior throws `DirtyWorktreeError` if the worktree has
   * uncommitted or unpushed changes.
   */
  force?: boolean;
  /**
   * For git workspaces only:
   *  - When the path exists: overrides the source auto-resolved from the `.git` pointer.
   *  - When the path is missing on disk (multi-device case): the source the
   *    library should `git worktree prune` against to clean stale tracking.
   */
  source?: string;
}
