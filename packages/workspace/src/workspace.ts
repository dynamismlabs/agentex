import * as fs from "node:fs/promises";
import * as path from "node:path";
import { loadWorkspaceConfig } from "./config.js";
import {
  BranchExistsError,
  DirtyWorktreeError,
  NotAGitRepoError,
  WorkspaceNotFoundError,
} from "./errors.js";
import {
  branchDelete,
  branchExists,
  checkout,
  getCurrentBranch,
  mergeBase,
  revParse,
  revParseGitDir,
  sparseCheckoutInit,
  sparseCheckoutSet,
  worktreeAdd,
  worktreeAddExisting,
  worktreePrune,
  worktreeRemove,
} from "./git/commands.js";
import { ensureContextExcluded } from "./git/info-exclude.js";
import {
  readWorktreeMetadata,
  writeWorktreeMetadata,
} from "./git/metadata.js";
import { resolveSourceFromWorkspace } from "./git/source.js";
import { readStatus } from "./git/status.js";
import { looksLikeBranchExists, readStderrFromUnknown } from "./git/stderr.js";
import { makeBareHandle } from "./internal/bare-handle.js";
import {
  detectDefaultBranchFromDisk,
  detectKindFromDisk,
} from "./internal/detect.js";
import { makeGitHandle } from "./internal/git-handle.js";
import { runArchiveScriptIfPresent } from "./internal/run-archive-script.js";
import type {
  ArchiveOptions,
  CreateBareOptions,
  CreateGitOptions,
  CreateOptions,
  GitWorkspace,
  OpenOptions,
  Workspace,
  WorkspaceKind,
} from "./types.js";
import { assertAbsolutePath, assertNonEmpty } from "./util/assertions.js";
import { ensureDir, pathExists, removeRecursive } from "./util/fs.js";

/**
 * Canonicalize an existing path to its realpath. The library normalizes both
 * `path` and `source` so that handles returned by `create` and re-hydrated by
 * `open` agree on string identity even when the caller passed an alias path
 * (e.g. macOS `/var/folders/...` vs the realpath `/private/var/folders/...`).
 */
async function canonicalize(p: string): Promise<string> {
  return fs.realpath(p);
}

/**
 * Internal "is this path a git workspace?" probe. Syntactic sugar for
 * `detectKindFromDisk(p) === "git"` so the call sites read more naturally.
 */
async function isGitPath(absolutePath: string): Promise<boolean> {
  return (await detectKindFromDisk(absolutePath)) === "git";
}

/* -------------------------------------------------------------------------- */
/*                                   create                                   */
/* -------------------------------------------------------------------------- */

async function create(opts: CreateOptions): Promise<Workspace> {
  if (opts.kind === "bare") return createBare(opts);
  if (opts.kind === "git") return createGit(opts);
  throw new Error(
    `workspace.create: unsupported kind (got: ${(opts as { kind: string }).kind})`,
  );
}

async function createBare(opts: CreateBareOptions): Promise<Workspace> {
  assertAbsolutePath(opts.path, "path");
  if (opts.source !== undefined) assertAbsolutePath(opts.source, "source");

  await ensureDir(opts.path);

  // If the dir already contains a `.git` entry, the consumer almost certainly
  // meant `kind: "git"`. Reject loudly rather than silently producing a bare
  // handle whose `open()` would later detect as git — which would surprise
  // anyone re-hydrating from a stored path.
  if (await pathExists(path.join(opts.path, ".git"))) {
    throw new Error(
      `workspace.create({kind: "bare"}): path already contains a .git/ entry — did you mean kind: "git"? (path: ${opts.path})`,
    );
  }

  const wsPath = await canonicalize(opts.path);
  const source = opts.source !== undefined ? await canonicalize(opts.source) : undefined;
  const ws = makeBareHandle({ path: wsPath, source });
  if (opts.applyFromSource !== false) {
    await autoApplyFromSource(ws, source);
  }
  return ws;
}

async function createGit(opts: CreateGitOptions): Promise<GitWorkspace> {
  assertAbsolutePath(opts.source, "source");
  assertAbsolutePath(opts.path, "path");
  assertNonEmpty(opts.baseBranch, "baseBranch");
  assertNonEmpty(opts.branch, "branch");
  if (opts.sparseInclude !== undefined) assertSparseIncludeValid(opts.sparseInclude);

  const source = await canonicalize(opts.source);

  // Validate source is a git repo (and tighten the error type).
  try {
    await revParseGitDir(source);
  } catch {
    throw new NotAGitRepoError(source);
  }

  // Preflight branch existence so we throw the typed error before we let git
  // mutate anything. Belt-and-suspenders: also map the post-add stderr in
  // case of a race.
  const branchAlreadyExists = await branchExists(source, opts.branch);
  const reuse = branchAlreadyExists && opts.reuseBranch === true;
  if (branchAlreadyExists && !reuse) {
    throw new BranchExistsError(opts.branch);
  }

  // baseSha means "where this branch diverged from base" — the ref diff("base")
  // and shortstat("base") run against. For a *new* branch that's the base tip
  // (captured atomically before the add, so it matches what git branches from).
  // For a *reused* branch we recover the actual divergence point via merge-base
  // so the diff reports only the branch's own changes, not how far base has
  // advanced since. Fall back to the base tip if the two share no history.
  let baseSha: string;
  if (reuse) {
    try {
      baseSha = await mergeBase(source, opts.branch, opts.baseBranch);
    } catch {
      baseSha = await revParse(source, opts.baseBranch);
    }
  } else {
    baseSha = await revParse(source, opts.baseBranch);
  }

  try {
    if (reuse) {
      // Adopt the existing branch into the worktree — HEAD lands at its tip.
      await worktreeAddExisting({
        cwd: source,
        path: opts.path,
        branch: opts.branch,
        noCheckout: opts.sparseInclude !== undefined,
      });
    } else {
      await worktreeAdd({
        cwd: source,
        path: opts.path,
        branch: opts.branch,
        base: opts.baseBranch,
        noCheckout: opts.sparseInclude !== undefined,
      });
    }
  } catch (err) {
    const stderr = readStderrFromUnknown(err);
    // Race: the branch appeared between our preflight and the add. We don't
    // adopt races — surfacing BranchExistsError here is intentional even when
    // reuseBranch was opted in (reuse only kicks in when the branch was already
    // present at preflight time).
    if (!reuse && looksLikeBranchExists(stderr, opts.branch)) {
      throw new BranchExistsError(opts.branch);
    }
    throw err;
  }

  if (opts.sparseInclude !== undefined) {
    await sparseCheckoutInit(opts.path, "cone");
    await sparseCheckoutSet(opts.path, opts.sparseInclude);
    await checkout(opts.path, opts.branch);
  }

  // Worktree path now exists on disk; canonicalize so it agrees with whatever
  // realpath open will see (git resolves common-dir to realpath internally).
  const wsPath = await canonicalize(opts.path);

  await writeWorktreeMetadata(wsPath, {
    baseBranch: opts.baseBranch,
    baseSha,
  });
  await ensureContextExcluded(wsPath);

  const ws = makeGitHandle({
    path: wsPath,
    source,
    branch: opts.branch,
    base: opts.baseBranch,
    baseSha,
  });
  if (opts.applyFromSource !== false) {
    await autoApplyFromSource(ws, source);
  }
  return ws;
}

/**
 * Auto-apply the `fromSource` block from `agentex.workspace.json` after the
 * workspace dir / worktree is set up. No-op when no source is available, when
 * the config file has no `fromSource`, or when the consumer opted out via
 * `applyFromSource: false`.
 */
async function autoApplyFromSource(ws: Workspace, source: string | undefined): Promise<void> {
  if (source === undefined) return;

  const config = await loadWorkspaceConfig({ source, workspacePath: ws.path });
  const block = config.fromSource;
  if (!block) return;

  if (block.copy && block.copy.length > 0) {
    await ws.copyFromSource(block.copy);
  }
  if (block.link && block.link.length > 0) {
    await ws.linkFromSource(block.link);
  }
}

/* -------------------------------------------------------------------------- */
/*                                    open                                    */
/* -------------------------------------------------------------------------- */

async function open(absolutePath: string, opts: OpenOptions = {}): Promise<Workspace> {
  assertAbsolutePath(absolutePath, "path");
  if (opts.source !== undefined) assertAbsolutePath(opts.source, "source");

  if (!(await pathExists(absolutePath))) {
    throw new WorkspaceNotFoundError(absolutePath);
  }

  const wsPath = await canonicalize(absolutePath);

  if (await isGitPath(wsPath)) {
    return openGit(wsPath, opts);
  }
  const source = opts.source !== undefined ? await canonicalize(opts.source) : undefined;
  return makeBareHandle({ path: wsPath, source });
}

async function openGit(wsPath: string, opts: OpenOptions): Promise<GitWorkspace> {
  const sourceRaw = opts.source ?? (await resolveSourceFromWorkspace(wsPath));
  if (sourceRaw === null) {
    throw new Error(
      `workspace.open: path looks like a git workspace but its source repo could not be resolved (path: ${wsPath}). Pass { source } to override.`,
    );
  }
  const source = await canonicalize(sourceRaw);

  const branch = await getCurrentBranch(wsPath);

  const metadata = await readWorktreeMetadata(wsPath);
  const baseBranch = opts.baseBranch ?? metadata?.baseBranch;

  if (baseBranch === undefined) {
    throw new Error(
      `workspace.open: git workspace at ${wsPath} has no base metadata. ` +
        `This worktree was not created by @agentex/workspace, or its metadata ` +
        `file was deleted. Pass { baseBranch } (and optionally { baseSha }) to ` +
        `open it explicitly.`,
    );
  }

  // Resolve baseSha:
  //   1) opts.baseSha (highest precedence — consumer is authoritative)
  //   2) metadata.baseSha (the value captured atomically at create time)
  //   3) freshly derived from `git rev-parse <baseBranch>` — flagged so the
  //      consumer knows it's "best guess" rather than the original branch point.
  let baseSha: string;
  let baseShaIsFreshlyDerived = false;
  if (opts.baseSha !== undefined) {
    baseSha = opts.baseSha;
  } else if (metadata?.baseSha !== undefined) {
    baseSha = metadata.baseSha;
  } else {
    baseSha = await revParse(source, baseBranch);
    baseShaIsFreshlyDerived = true;
  }

  return makeGitHandle({
    path: wsPath,
    source,
    branch,
    base: baseBranch,
    baseSha,
    baseShaIsFreshlyDerived,
  });
}

/* -------------------------------------------------------------------------- */
/*                                  archive                                   */
/* -------------------------------------------------------------------------- */

async function archive(absolutePath: string, opts: ArchiveOptions = {}): Promise<void> {
  assertAbsolutePath(absolutePath, "path");
  if (opts.source !== undefined) assertAbsolutePath(opts.source, "source");

  if (!(await pathExists(absolutePath))) {
    // Missing on disk: bare → no-op; git (signaled by opts.source) → prune.
    if (opts.source !== undefined) {
      const sourceReal = await canonicalize(opts.source);
      await worktreePrune(sourceReal);
    }
    return;
  }

  const wsPath = await canonicalize(absolutePath);

  if (await isGitPath(wsPath)) {
    return archiveGit(wsPath, opts);
  }
  return archiveBare(wsPath, opts);
}

async function archiveBare(wsPath: string, opts: ArchiveOptions): Promise<void> {
  const source = opts.source !== undefined ? await canonicalize(opts.source) : undefined;

  const config = await loadWorkspaceConfig({ source, workspacePath: wsPath });

  await runArchiveScriptIfPresent({
    archiveScript: config.scripts?.archive,
    workspacePath: wsPath,
    source,
  });

  await removeRecursive(wsPath);
}

async function archiveGit(wsPath: string, opts: ArchiveOptions): Promise<void> {
  const sourceRaw = opts.source ?? (await resolveSourceFromWorkspace(wsPath));
  if (sourceRaw === null) {
    throw new Error(
      `workspace.archive: git workspace's source repo could not be resolved (path: ${wsPath}). Pass { source } to override.`,
    );
  }
  const source = await canonicalize(sourceRaw);

  if (!opts.force) {
    const status = await readStatus(wsPath);
    if (status.dirty || status.ahead > 0) {
      throw new DirtyWorktreeError(status);
    }
  }

  // Capture the branch name BEFORE worktreeRemove — once the worktree dir is
  // gone, `getCurrentBranch(wsPath)` can't read HEAD. Best-effort: detached
  // HEAD or any other read failure just skips the branch cleanup below.
  let branchToDelete: string | null = null;
  if (opts.deleteBranch === true) {
    try {
      branchToDelete = await getCurrentBranch(wsPath);
    } catch {
      branchToDelete = null;
    }
  }

  const config = await loadWorkspaceConfig({ source, workspacePath: wsPath });

  await runArchiveScriptIfPresent({
    archiveScript: config.scripts?.archive,
    workspacePath: wsPath,
    source,
  });

  await worktreeRemove({ cwd: source, path: wsPath, force: opts.force === true });
  await worktreePrune(source);

  // `git worktree remove` leaves the branch ref behind. If the consumer asked
  // for full cleanup, drop it now — but only if it still exists (it may have
  // been deleted out-of-band, e.g. by the archive script or a prior partial
  // run). The deletion respects `force`: without it, `git branch -d` refuses
  // to delete a branch with unmerged/unpushed commits and that error
  // propagates, rather than silently discarding work.
  if (branchToDelete !== null && (await branchExists(source, branchToDelete))) {
    await branchDelete(source, branchToDelete, { force: opts.force === true });
  }
}

/* -------------------------------------------------------------------------- */
/*                                  helpers                                   */
/* -------------------------------------------------------------------------- */

function assertSparseIncludeValid(patterns: readonly string[]): void {
  if (!Array.isArray(patterns) || patterns.length === 0) {
    throw new Error("sparseInclude must be a non-empty array of patterns when provided");
  }
  for (const p of patterns) {
    if (typeof p !== "string" || p.length === 0) {
      throw new Error(`sparseInclude entries must be non-empty strings (got: ${JSON.stringify(p)})`);
    }
  }
}

async function detectKind(absolutePath: string): Promise<WorkspaceKind> {
  assertAbsolutePath(absolutePath, "path");
  return detectKindFromDisk(absolutePath);
}

async function detectDefaultBranch(
  absolutePath: string,
  remote: string = "origin",
): Promise<string> {
  assertAbsolutePath(absolutePath, "path");
  if (!(await pathExists(absolutePath))) {
    throw new Error(`detectDefaultBranch: path does not exist (${absolutePath})`);
  }
  return detectDefaultBranchFromDisk(absolutePath, remote);
}

export const workspace = {
  create,
  open,
  archive,
  detectKind,
  detectDefaultBranch,
} as const;
