import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  LinkDestinationConflictError,
  SourceFileMissingError,
} from "./errors.js";
import { globMatchFiles } from "./internal/glob-walk.js";
import { isInsideSparse, readSparsePatterns } from "./internal/sparse.js";
import { ensureDir, pathExists } from "./util/fs.js";
import { assertRelativePosixPath } from "./util/assertions.js";
import type { FromSourceWarnings } from "./types.js";

/**
 * Copy each file matching the glob `patterns` from `source` into the same
 * relative path inside `workspacePath`. Honors `cp -f` semantics: existing
 * destinations are overwritten. If the workspace is sparse-restricted and a
 * matched path's destination directory is excluded, the entry is skipped and
 * recorded on `warnings.skippedOutsideSparse`.
 */
export async function copyFilesFromSource(args: {
  source: string;
  workspacePath: string;
  patterns: readonly string[];
  warnings: FromSourceWarnings;
}): Promise<void> {
  for (const p of args.patterns) assertRelativePosixPath(p, "copyFromSource pattern");

  if (args.patterns.length === 0) return;

  const sparse = await readSparsePatterns(args.workspacePath);
  const matched = await globMatchFiles(args.source, args.patterns);

  for (const rel of matched) {
    if (sparse && !isInsideSparse(rel, sparse)) {
      args.warnings.skippedOutsideSparse.push(rel);
      continue;
    }
    const sourceFile = path.join(args.source, rel);
    const destFile = path.join(args.workspacePath, rel);

    if (!(await pathExists(sourceFile))) {
      // The walker found it but it disappeared between scan and copy.
      throw new SourceFileMissingError(sourceFile);
    }

    await ensureDir(path.dirname(destFile));

    // Remove an existing dest first so cp -f semantics hold even when the
    // dest is a symlink (fs.copyFile follows the link to write the *target*;
    // that's not what `cp -f` does for the dest).
    await removeFileLikeIfExists(destFile);
    await fs.copyFile(sourceFile, destFile);
  }
}

/**
 * Symlink each `paths` entry from `source` into the same relative location
 * inside `workspacePath`. Replaces an existing **symlink or file** at the
 * destination (`ln -sf` semantics). Refuses to silently delete an existing
 * **real directory** — those throw `LinkDestinationConflictError` so the
 * consumer can decide whether to remove them first.
 *
 * Sparse-restricted workspaces skip entries whose destination dirs are
 * excluded and record them on `warnings.skippedOutsideSparse`. Missing source
 * paths throw `SourceFileMissingError` (no silent broken symlinks).
 */
export async function linkPathsFromSource(args: {
  source: string;
  workspacePath: string;
  paths: readonly string[];
  warnings: FromSourceWarnings;
}): Promise<void> {
  for (const p of args.paths) assertRelativePosixPath(p, "linkFromSource path");

  if (args.paths.length === 0) return;

  const sparse = await readSparsePatterns(args.workspacePath);

  for (const rel of args.paths) {
    if (sparse && !isInsideSparse(rel, sparse)) {
      args.warnings.skippedOutsideSparse.push(rel);
      continue;
    }

    const sourcePath = path.join(args.source, rel);
    const destPath = path.join(args.workspacePath, rel);

    if (!(await pathExists(sourcePath))) {
      throw new SourceFileMissingError(sourcePath);
    }

    await ensureDir(path.dirname(destPath));

    const existing = await lstatOrNull(destPath);
    if (existing !== null) {
      if (existing.isSymbolicLink()) {
        await fs.unlink(destPath);
      } else if (existing.isDirectory()) {
        // Real directory — refuse to recursively delete user data.
        throw new LinkDestinationConflictError(destPath);
      } else {
        // File or other non-dir non-symlink — overwrite (ln -sf for files).
        await fs.unlink(destPath);
      }
    }

    await fs.symlink(sourcePath, destPath);
  }
}

async function removeFileLikeIfExists(p: string): Promise<void> {
  const stat = await lstatOrNull(p);
  if (stat === null) return;
  if (stat.isDirectory() && !stat.isSymbolicLink()) {
    // copyFromSource's contract is "copy a file" — refusing to delete a real
    // directory at the dest is the same safety as linkFromSource. The caller
    // is the auto-walker, so this should never happen in practice (a glob
    // can't match a directory entry), but guard anyway.
    throw new LinkDestinationConflictError(p);
  }
  await fs.unlink(p);
}

async function lstatOrNull(p: string): Promise<import("node:fs").Stats | null> {
  try {
    return await fs.lstat(p);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}
