import { diffShortstat, statusPorcelainV2 } from "./commands.js";
import type { ShortStat, WorkspaceStatus } from "../types.js";

/**
 * Parse `git status --porcelain=v2 --branch -z` into a typed `WorkspaceStatus`.
 * Handles ordinary changes (`1 …`), renames (`2 …` followed by an origPath
 * entry), unmerged (`u …`), and untracked (`? …`). Branch ahead/behind are
 * sourced from `# branch.ab +N -M`.
 */
export function parseStatus(raw: string): WorkspaceStatus {
  const entries = raw.split("\0").filter((s) => s.length > 0);
  const untracked: string[] = [];
  const modified = new Set<string>();
  const staged = new Set<string>();
  let ahead = 0;
  let behind = 0;

  let i = 0;
  while (i < entries.length) {
    const entry = entries[i] ?? "";
    if (entry.startsWith("# branch.ab ")) {
      const m = entry.match(/# branch\.ab \+(\d+) -(\d+)/);
      if (m) {
        ahead = parseInt(m[1] ?? "0", 10);
        behind = parseInt(m[2] ?? "0", 10);
      }
      i += 1;
    } else if (entry.startsWith("# ")) {
      i += 1;
    } else if (entry.startsWith("1 ")) {
      const parts = entry.split(" ");
      const xy = parts[1] ?? "..";
      const path = parts.slice(8).join(" ");
      classify(xy, path, staged, modified);
      i += 1;
    } else if (entry.startsWith("2 ")) {
      // Type 2 (rename): `2 XY sub mH mI mW hH hI X<score> <newPath>` followed
      // by a separate NUL-terminated `<origPath>` entry.
      const parts = entry.split(" ");
      const xy = parts[1] ?? "..";
      const newPath = parts.slice(9).join(" ");
      classify(xy, newPath, staged, modified);
      // Skip the origPath entry that follows.
      i += 2;
    } else if (entry.startsWith("u ")) {
      const parts = entry.split(" ");
      const path = parts.slice(10).join(" ");
      // Unmerged is both staged and worktree-changed in our model.
      staged.add(path);
      modified.add(path);
      i += 1;
    } else if (entry.startsWith("? ")) {
      untracked.push(entry.slice(2));
      i += 1;
    } else {
      // Ignored (`! `) or anything we don't classify — skip.
      i += 1;
    }
  }

  return {
    dirty: untracked.length + modified.size + staged.size > 0,
    untracked: untracked.sort(),
    modified: Array.from(modified).sort(),
    staged: Array.from(staged).sort(),
    ahead,
    behind,
  };
}

function classify(xy: string, path: string, staged: Set<string>, modified: Set<string>): void {
  const x = xy[0] ?? ".";
  const y = xy[1] ?? ".";
  if (x !== ".") staged.add(path);
  if (y !== ".") modified.add(path);
}

export async function readStatus(workspacePath: string): Promise<WorkspaceStatus> {
  const raw = await statusPorcelainV2(workspacePath);
  return parseStatus(raw);
}

const SHORTSTAT_RE = /(\d+) files? changed(?:, (\d+) insertions?\(\+\))?(?:, (\d+) deletions?\(-\))?/;

export function parseShortstat(raw: string): ShortStat {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return { files: 0, additions: 0, deletions: 0 };
  const m = trimmed.match(SHORTSTAT_RE);
  if (!m) return { files: 0, additions: 0, deletions: 0 };
  return {
    files: parseInt(m[1] ?? "0", 10),
    additions: parseInt(m[2] ?? "0", 10),
    deletions: parseInt(m[3] ?? "0", 10),
  };
}

export async function readShortstat(workspacePath: string, vs: string): Promise<ShortStat> {
  const raw = await diffShortstat(workspacePath, vs);
  return parseShortstat(raw);
}
