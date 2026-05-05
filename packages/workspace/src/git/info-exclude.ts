import * as fs from "node:fs/promises";
import { revParseGitPath } from "./commands.js";

const EXCLUDE_REL = "info/exclude";
const CONTEXT_PATTERN = ".context/";

/**
 * Append `.context/` to the worktree's per-worktree `.git/info/exclude` so the
 * agent's freeform notes don't show up as untracked changes and don't leak into
 * checkpoints. Idempotent: skips the write if the pattern is already present.
 *
 * Per-worktree exclude lives at `<gitdir-of-worktree>/info/exclude`; we resolve
 * it via `git rev-parse --git-path` so we don't have to reimplement git's
 * `.git`-pointer-file dereferencing.
 */
export async function ensureContextExcluded(worktreePath: string): Promise<void> {
  const target = await revParseGitPath(worktreePath, EXCLUDE_REL);

  let existing = "";
  try {
    existing = await fs.readFile(target, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }

  const lines = existing.split("\n").map((l) => l.trim());
  if (lines.includes(CONTEXT_PATTERN)) return;

  const trailingNewline = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
  const append = `${trailingNewline}${CONTEXT_PATTERN}\n`;
  await fs.writeFile(target, existing + append, "utf-8");
}
