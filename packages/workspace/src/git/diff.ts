import * as fs from "node:fs/promises";
import * as path from "node:path";
import { diffPatch, listUntracked } from "./commands.js";
import type {
  StructuredDiff,
  StructuredDiffFile,
  StructuredDiffHunk,
  StructuredDiffLine,
} from "../types.js";

const HEADER_RE_PLAIN = /^diff --git a\/(.+) b\/(.+)$/;
const HEADER_RE_QUOTED = /^diff --git "a\/(.+)" "b\/(.+)"$/;
const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

interface MutableDiffFile {
  path: string;
  status: "added" | "modified" | "deleted" | "renamed";
  oldPath?: string;
  hunks: StructuredDiffHunk[];
}

interface ParsedHeader {
  oldPath: string;
  newPath: string;
}

/**
 * Git wraps a path in double quotes and backslash-escapes special characters
 * when the path contains spaces, double quotes, or other shell-significant
 * characters. The most common cases are spaces (no escape, just the quotes)
 * and the few `\\`, `\"`, `\n`, `\t` sequences. Octal escapes for non-ASCII
 * are disabled in our caller via `-c core.quotePath=false` so we don't need
 * to handle them here.
 */
function unescapeGitQuotedPath(s: string): string {
  return s.replace(/\\(["\\nt])/g, (_, ch) => {
    if (ch === "n") return "\n";
    if (ch === "t") return "\t";
    return ch;
  });
}

function parseHeader(line: string): ParsedHeader | null {
  const plain = line.match(HEADER_RE_PLAIN);
  if (plain) return { oldPath: plain[1] ?? "", newPath: plain[2] ?? "" };
  const quoted = line.match(HEADER_RE_QUOTED);
  if (quoted) {
    return {
      oldPath: unescapeGitQuotedPath(quoted[1] ?? ""),
      newPath: unescapeGitQuotedPath(quoted[2] ?? ""),
    };
  }
  return null;
}

function unquoteIfNeeded(value: string): string {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return unescapeGitQuotedPath(value.slice(1, -1));
  }
  return value;
}

export function parseUnifiedDiff(raw: string): StructuredDiff {
  const lines = raw.split("\n");
  const files: StructuredDiffFile[] = [];

  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    if (!line.startsWith("diff --git ")) {
      i += 1;
      continue;
    }
    const result = parseFileEntry(lines, i);
    if (result === null) {
      i += 1;
      continue;
    }
    files.push(result.file);
    i = result.nextIdx;
  }

  return { files };
}

function parseFileEntry(
  lines: string[],
  start: number,
): { file: StructuredDiffFile; nextIdx: number } | null {
  const header = lines[start] ?? "";
  const parsed = parseHeader(header);
  if (parsed === null) return null;

  let oldPath = parsed.oldPath;
  let newPath = parsed.newPath;

  const file: MutableDiffFile = {
    path: newPath,
    status: "modified",
    hunks: [],
  };

  let i = start + 1;
  let isBinary = false;

  // Walk extended headers until we hit a hunk, the next file, or EOF.
  while (i < lines.length) {
    const l = lines[i] ?? "";
    if (l.startsWith("@@")) break;
    if (l.startsWith("diff --git ")) break;

    if (l.startsWith("new file")) {
      file.status = "added";
    } else if (l.startsWith("deleted file")) {
      file.status = "deleted";
    } else if (l.startsWith("rename from ")) {
      file.status = "renamed";
      oldPath = unquoteIfNeeded(l.slice("rename from ".length));
    } else if (l.startsWith("rename to ")) {
      newPath = unquoteIfNeeded(l.slice("rename to ".length));
    } else if (l.startsWith("copy from ")) {
      file.status = "renamed";
      oldPath = unquoteIfNeeded(l.slice("copy from ".length));
    } else if (l.startsWith("copy to ")) {
      newPath = unquoteIfNeeded(l.slice("copy to ".length));
    } else if (l.startsWith("Binary files ")) {
      isBinary = true;
    } else if (l === "--- /dev/null") {
      file.status = "added";
    } else if (l === "+++ /dev/null") {
      file.status = "deleted";
    }
    i += 1;
  }

  // Final path resolution.
  if (file.status === "deleted") {
    file.path = oldPath;
  } else if (file.status === "renamed") {
    file.path = newPath;
    file.oldPath = oldPath;
  } else {
    file.path = newPath;
  }

  if (isBinary) {
    return {
      file: { ...file, hunks: [] } as StructuredDiffFile,
      nextIdx: i,
    };
  }

  // Parse hunks.
  while (i < lines.length) {
    const l = lines[i] ?? "";
    if (!l.startsWith("@@")) break;
    const hunkResult = parseHunk(lines, i);
    if (hunkResult === null) {
      i += 1;
      continue;
    }
    file.hunks.push(hunkResult.hunk);
    i = hunkResult.nextIdx;
  }

  return { file: file as StructuredDiffFile, nextIdx: i };
}

function parseHunk(
  lines: string[],
  start: number,
): { hunk: StructuredDiffHunk; nextIdx: number } | null {
  const headerLine = lines[start] ?? "";
  const m = headerLine.match(HUNK_RE);
  if (!m) return null;

  const oldStart = parseInt(m[1] ?? "0", 10);
  const oldLines = m[2] !== undefined ? parseInt(m[2], 10) : 1;
  const newStart = parseInt(m[3] ?? "0", 10);
  const newLines = m[4] !== undefined ? parseInt(m[4], 10) : 1;

  const lineEntries: StructuredDiffLine[] = [];
  let i = start + 1;
  let oldRemaining = oldLines;
  let newRemaining = newLines;

  while (i < lines.length && (oldRemaining > 0 || newRemaining > 0)) {
    const l = lines[i] ?? "";
    if (l.startsWith("\\")) {
      // "\ No newline at end of file" — does not consume an old/new line.
      i += 1;
      continue;
    }
    if (l.startsWith("+")) {
      lineEntries.push({ kind: "add", text: l.slice(1) });
      newRemaining -= 1;
    } else if (l.startsWith("-")) {
      lineEntries.push({ kind: "del", text: l.slice(1) });
      oldRemaining -= 1;
    } else if (l.startsWith(" ")) {
      lineEntries.push({ kind: "ctx", text: l.slice(1) });
      oldRemaining -= 1;
      newRemaining -= 1;
    } else if (l === "") {
      // Empty line inside a hunk represents a context line that's literally
      // empty (git omits the leading space sometimes). Treat as ctx.
      lineEntries.push({ kind: "ctx", text: "" });
      if (oldRemaining > 0) oldRemaining -= 1;
      if (newRemaining > 0) newRemaining -= 1;
    } else {
      break;
    }
    i += 1;
  }

  return {
    hunk: { oldStart, oldLines, newStart, newLines, lines: lineEntries },
    nextIdx: i,
  };
}

/**
 * Build a synthetic `"added"` diff entry for an untracked file by reading its
 * contents. The hunk is `@@ -0,0 +1,N @@` with all lines as `"add"`.
 */
async function buildUntrackedFileEntry(
  workspacePath: string,
  rel: string,
): Promise<StructuredDiffFile | null> {
  const abs = path.join(workspacePath, rel);
  let raw: Buffer;
  try {
    raw = await fs.readFile(abs);
  } catch {
    return null;
  }

  // Heuristic: a NUL byte in the first 8KB → binary.
  const probe = raw.subarray(0, Math.min(raw.length, 8192));
  if (probe.includes(0)) {
    return { path: rel, status: "added", hunks: [] };
  }

  const text = raw.toString("utf-8");
  if (text.length === 0) {
    return {
      path: rel,
      status: "added",
      hunks: [
        { oldStart: 0, oldLines: 0, newStart: 0, newLines: 0, lines: [] },
      ],
    };
  }

  const split = text.split("\n");
  // If the text ends with a newline, split() leaves an empty string at the
  // end; drop it so the line count matches what users see.
  const fileLines = split[split.length - 1] === "" ? split.slice(0, -1) : split;
  const lineEntries: StructuredDiffLine[] = fileLines.map((line) => ({
    kind: "add" as const,
    text: line,
  }));

  return {
    path: rel,
    status: "added",
    hunks: [
      {
        oldStart: 0,
        oldLines: 0,
        newStart: 1,
        newLines: lineEntries.length,
        lines: lineEntries,
      },
    ],
  };
}

export async function readStructuredDiff(
  workspacePath: string,
  vs: string,
): Promise<StructuredDiff> {
  const tracked = parseUnifiedDiff(await diffPatch(workspacePath, vs));
  const untracked = await listUntracked(workspacePath);

  const untrackedFiles: StructuredDiffFile[] = [];
  for (const rel of untracked) {
    const entry = await buildUntrackedFileEntry(workspacePath, rel);
    if (entry !== null) untrackedFiles.push(entry);
  }

  return { files: [...tracked.files, ...untrackedFiles] };
}
