/**
 * Claude Code writes a durable JSONL transcript for every session under
 * `<claudeHome>/projects/<sanitized-cwd>/<sessionId>.jsonl`. The on-disk lines
 * use the same JSON shape Claude streams over stdout, so {@link parseStreamLine}
 * handles them unchanged. These helpers cover the two parts the consuming
 * host can't easily derive itself: where the file lives, and how to stream
 * it back as `StreamEvent`s.
 *
 * Encoding rules are verified against Claude Code's open-source source
 * (`sessionStoragePortable.ts:sanitizePath`):
 *   1. Replace EVERY non-alphanumeric character with `-`
 *      (not just `/` and `.` — also `_`, space, `:`, etc.)
 *   2. If the sanitized name exceeds {@link MAX_SANITIZED_LENGTH} (200),
 *      truncate and append a hash suffix
 *   3. Canonicalize the cwd via `realpath` + NFC first so symlinks
 *      (e.g. macOS `/tmp` → `/private/tmp`) resolve to the same project dir
 *
 * The CLI does not expose a flag for the transcript path; the only source of
 * truth is the open-source `sessionStoragePortable.ts`.
 */

import { createReadStream } from "node:fs";
import { readdir, realpath, stat, open as fsOpen } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline";

import { getDefaultRuntimeHome, getRuntimeHomeEnvVar } from "../../utils/runtime-homes.js";
import type { FoundTranscript, StreamEvent, TranscriptOps } from "../../types.js";
import { parseStreamLine } from "./parse.js";

/**
 * Maximum length of a sanitized project-directory name before truncation +
 * hash suffix kicks in. Mirrors Claude Code's `MAX_SANITIZED_LENGTH`. Most
 * filesystems cap individual filename segments at 255 bytes; the gap leaves
 * room for the hash suffix.
 */
export const MAX_SANITIZED_LENGTH = 200;

/** Bytes scanned from the tail of the file in {@link peekClaudeTranscript}. */
const PEEK_TAIL_BYTES = 16 * 1024;

/** Filter rule: skip these Claude wrapper-event types when streaming a transcript. */
const SKIP_ON_DISK_TYPES = new Set([
  // Internal enqueue/dequeue bookkeeping that Claude writes for its own
  // scheduler; the on-disk file is the only place these surface. They carry
  // no user-visible content and shouldn't be replayed.
  "queue-operation",
]);

/**
 * djb2 string hash returning an unsigned base-36 string. Deterministic across
 * runtimes — Claude Code's source uses `Bun.hash` under Bun (a different
 * algorithm), so for cwd paths longer than {@link MAX_SANITIZED_LENGTH} the
 * exact directory name will differ between Bun and Node. {@link getClaudeTranscriptPath}
 * compensates with a prefix-match fallback when the exact path is missing.
 */
function djb2Base36(input: string): string {
  let hash = 0;
  for (let i = 0; i < input.length; i++) {
    hash = ((hash << 5) - hash + input.charCodeAt(i)) | 0;
  }
  return Math.abs(hash).toString(36);
}

/**
 * Encode an absolute path into Claude's project-directory name. Mirrors
 * `sanitizePath` in Claude Code's open-source `sessionStoragePortable.ts`.
 *
 * @example
 * sanitizeProjectPath("/Users/foo/bar")     // → "-Users-foo-bar"
 * sanitizeProjectPath("/Users/foo/.config") // → "-Users-foo--config"
 * sanitizeProjectPath("/Users/foo/my_app")  // → "-Users-foo-my-app"
 *                                           //   (underscore is non-alphanumeric)
 */
export function sanitizeProjectPath(name: string): string {
  const sanitized = name.replace(/[^a-zA-Z0-9]/g, "-");
  if (sanitized.length <= MAX_SANITIZED_LENGTH) return sanitized;
  return `${sanitized.slice(0, MAX_SANITIZED_LENGTH)}-${djb2Base36(name)}`;
}

/**
 * Resolve Claude's config home directory. Mirrors `getClaudeConfigHomeDir` in
 * Claude Code, including the NFC normalization needed to keep paths consistent
 * with macOS HFS+/APFS Unicode handling.
 */
export function resolveClaudeHome(override?: string): string {
  if (override) return override.normalize("NFC");
  const envVar = getRuntimeHomeEnvVar("claude");
  const fromEnv = envVar ? process.env[envVar] : undefined;
  const base = fromEnv ?? getDefaultRuntimeHome("claude") ?? path.join(os.homedir(), ".claude");
  return base.normalize("NFC");
}

/**
 * Canonicalize a cwd path to match what Claude Code stores. `realpath`
 * resolves symlinks (`/tmp` → `/private/tmp` on macOS) and NFC unifies the
 * two Unicode normalizations macOS accepts for filenames with accents.
 *
 * Returns the NFC-normalized input on `realpath` failure (e.g., directory
 * was deleted after the session ran), since the directory name on disk was
 * computed against whatever the cwd was at session start.
 */
export async function canonicalizeCwd(cwd: string): Promise<string> {
  try {
    return (await realpath(cwd)).normalize("NFC");
  } catch {
    return cwd.normalize("NFC");
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface GetClaudeTranscriptPathOptions {
  /** Claude's session id (UUID). Same value as the `session_id` field on stream events. */
  sessionId: string;
  /**
   * The working directory Claude was launched in. Canonicalized via `realpath`
   * + NFC before encoding, matching Claude's own behavior.
   */
  cwd: string;
  /**
   * Override the Claude config home. Defaults to `$CLAUDE_CONFIG_DIR` or
   * `~/.claude`. Useful in tests and for hosts pointing Claude at a
   * non-standard home.
   */
  claudeHome?: string;
}

export interface ClaudeTranscriptLocation {
  /** Absolute path to the JSONL file. May not exist on disk yet. */
  filePath: string;
  /** The project-directory name (sanitized cwd) under `<claudeHome>/projects/`. */
  projectDir: string;
  /** The canonicalized cwd that was used to compute {@link projectDir}. */
  canonicalCwd: string;
  /** The Claude config home that was used. */
  claudeHome: string;
}

/**
 * Compute the on-disk JSONL path for a Claude session. Performs `realpath`
 * canonicalization on the cwd and applies the same encoding rules Claude
 * Code uses internally.
 *
 * For cwd paths sanitized longer than {@link MAX_SANITIZED_LENGTH}, the
 * deterministic djb2 hash suffix may not match what Claude wrote (Claude Code
 * uses `Bun.hash` under Bun). If the exact path doesn't exist and the
 * sanitized name was truncated, this function falls back to a prefix scan
 * under `<claudeHome>/projects/` and returns the first matching directory.
 */
export async function getClaudeTranscriptPath(
  opts: GetClaudeTranscriptPathOptions,
): Promise<ClaudeTranscriptLocation> {
  if (!opts.sessionId) throw new Error("getClaudeTranscriptPath: sessionId is required");
  if (!opts.cwd) throw new Error("getClaudeTranscriptPath: cwd is required");

  const claudeHome = resolveClaudeHome(opts.claudeHome);
  const canonicalCwd = await canonicalizeCwd(opts.cwd);
  const sanitized = sanitizeProjectPath(canonicalCwd);
  const fileName = `${opts.sessionId}.jsonl`;
  const projectsRoot = path.join(claudeHome, "projects");

  // Primary: exact match. Covers the common case (short paths, same hash algorithm).
  const exactPath = path.join(projectsRoot, sanitized, fileName);
  if (await pathExists(exactPath)) {
    return { filePath: exactPath, projectDir: sanitized, canonicalCwd, claudeHome };
  }

  // Long-path fallback: Claude under Bun uses `Bun.hash` for the suffix;
  // we use djb2. The truncated prefix is identical, so prefix-scan to find
  // the actual on-disk directory. Mirrors open-source `findProjectDir`.
  if (sanitized.length > MAX_SANITIZED_LENGTH) {
    const prefix = sanitized.slice(0, MAX_SANITIZED_LENGTH);
    try {
      const entries = await readdir(projectsRoot, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (!entry.name.startsWith(`${prefix}-`)) continue;
        const candidate = path.join(projectsRoot, entry.name, fileName);
        if (await pathExists(candidate)) {
          return { filePath: candidate, projectDir: entry.name, canonicalCwd, claudeHome };
        }
      }
    } catch {
      // projectsRoot missing or unreadable — fall through to deterministic path.
    }
  }

  return { filePath: exactPath, projectDir: sanitized, canonicalCwd, claudeHome };
}

// ---------------------------------------------------------------------------
// Find-by-id (resume case: cwd unknown)
// ---------------------------------------------------------------------------

export interface FindClaudeTranscriptOptions {
  /** Claude's session id (UUID). */
  sessionId: string;
  /** Override the Claude config home. */
  claudeHome?: string;
}

export interface FoundClaudeTranscript {
  /** Absolute path to the JSONL file. */
  filePath: string;
  /** The project-directory name (sanitized cwd) under `<claudeHome>/projects/`. */
  projectDir: string;
  /**
   * The literal cwd Claude was launched with, recovered from the first
   * `system.init` event in the transcript. `null` if the file has no init
   * event (e.g., truncated transcript) or it never recorded a cwd.
   *
   * This is the only way to recover the original cwd — `projectDir` is the
   * sanitized form, which is one-way (multiple cwds can collide on the same
   * sanitized name, though it's rare).
   */
  cwd: string | null;
}

/**
 * Scan `<claudeHome>/projects/*` looking for `<sessionId>.jsonl`. Use this
 * when you have a session ID but don't know which cwd Claude was launched
 * in — typical for resume-by-id flows.
 *
 * Session IDs are unique across project directories, so the first match is
 * authoritative. The original cwd is recovered from the transcript's first
 * `system.init` event (Claude writes one at session start carrying `cwd`).
 *
 * Returns `null` if no project directory contains the session file.
 */
export async function findClaudeTranscriptBySessionId(
  opts: FindClaudeTranscriptOptions,
): Promise<FoundClaudeTranscript | null> {
  if (!opts.sessionId) {
    throw new Error("findClaudeTranscriptBySessionId: sessionId is required");
  }
  const claudeHome = resolveClaudeHome(opts.claudeHome);
  const projectsRoot = path.join(claudeHome, "projects");
  const fileName = `${opts.sessionId}.jsonl`;

  let entries;
  try {
    entries = await readdir(projectsRoot, { withFileTypes: true });
  } catch {
    return null;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const candidate = path.join(projectsRoot, entry.name, fileName);
    if (!(await pathExists(candidate))) continue;
    const cwd = await readCwdFromTranscript(candidate);
    return { filePath: candidate, projectDir: entry.name, cwd };
  }
  return null;
}

/**
 * Read the cwd field from the first transcript line that carries one.
 *
 * Claude's on-disk format does NOT emit a `system.init` event the way the
 * stream wire format does. Instead, every event line (`user`, `assistant`,
 * etc.) carries its own `cwd`, `sessionId`, `gitBranch`, `version` envelope.
 * Read the first few lines raw, extract the first `cwd` we find.
 *
 * Returns `null` if no line in the first ~50 carries a `cwd` field.
 */
async function readCwdFromTranscript(filePath: string): Promise<string | null> {
  const fh = await fsOpen(filePath, "r").catch(() => null);
  if (!fh) return null;

  try {
    const stream = fh.createReadStream({ encoding: "utf8", autoClose: false });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    let count = 0;
    try {
      for await (const raw of rl) {
        if (++count > 50) break;
        const trimmed = raw.trim();
        if (!trimmed) continue;
        try {
          const obj = JSON.parse(trimmed) as Record<string, unknown>;
          // Outer envelope: every Claude line carries `cwd` at the top level.
          if (typeof obj["cwd"] === "string" && obj["cwd"]) {
            return obj["cwd"] as string;
          }
          // Forward-compat: streaming-style init events also have cwd.
          if (
            obj["type"] === "system" &&
            obj["subtype"] === "init" &&
            typeof obj["cwd"] === "string"
          ) {
            return obj["cwd"] as string;
          }
        } catch {
          // skip malformed
        }
      }
    } finally {
      rl.close();
      stream.destroy();
    }
  } finally {
    await fh.close();
  }
  return null;
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Streaming read
// ---------------------------------------------------------------------------

export interface ReadClaudeTranscriptOptions {
  /** Absolute path to the JSONL file. */
  filePath: string;
  /**
   * Byte offset to resume from. Must be line-aligned (the position immediately
   * after a `\n`). Use an offset previously yielded by this function.
   * Defaults to 0 (read from the start).
   */
  fromOffset?: number;
  /**
   * Defensive dedup: if set, skip events whose {@link StreamEvent.eventId}
   * matches and any events from the same line. Useful when `fromOffset` is
   * missing or stale; the consumer's unique-index on `eventId` makes
   * duplicates safe anyway, but this saves a round trip.
   *
   * Behavior: drop events up to and including the first one whose eventId
   * matches; resume yielding from the next line.
   */
  sinceEventId?: string;
}

export interface ClaudeTranscriptYield {
  /** A parsed `StreamEvent` from the transcript. */
  event: StreamEvent;
  /**
   * Byte offset immediately AFTER the trailing `\n` of the line this event
   * came from. Pass this back as {@link ReadClaudeTranscriptOptions.fromOffset}
   * to resume on the next line. Events sharing a line share an offset.
   */
  offset: number;
}

/**
 * Stream-read a Claude transcript JSONL, yielding parsed `StreamEvent`s.
 *
 * Behavior:
 * - Returns an empty async iterable if the file doesn't exist (no throw).
 * - Skips wrapper types in {@link SKIP_ON_DISK_TYPES} (currently `queue-operation`).
 * - Skips lines that fail to parse as JSON (`parseStreamLine` returns []).
 * - Seeks into the file with `createReadStream` so multi-megabyte transcripts
 *   don't load fully into memory.
 *
 * The yielded `offset` lets the caller checkpoint after each event and
 * resume from that offset on the next call.
 */
export async function* readClaudeTranscript(
  opts: ReadClaudeTranscriptOptions,
): AsyncIterable<ClaudeTranscriptYield> {
  const { filePath, fromOffset = 0, sinceEventId } = opts;

  // Fast-path: file missing → empty iterable, no throw.
  if (!(await pathExists(filePath))) return;

  const stream = createReadStream(filePath, { start: fromOffset, encoding: undefined });

  // Suppress stray ENOENT (file deleted between stat and open) — readline
  // raises the same condition through its own iterator, which we catch below.
  stream.on("error", () => {});

  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  let pos = fromOffset;
  let stillSkippingPastSince = !!sinceEventId;

  try {
    for await (const line of rl) {
      // readline strips the trailing `\n` (and the `\r` from `\r\n`). Claude
      // writes Unix line endings, so we account for `\n` only. A `\r\n` file
      // would yield offsets 1 byte short per line — accepted as a corner
      // case; resume from such an offset would skip one stray `\r`.
      const lineByteLen = Buffer.byteLength(line, "utf8");
      pos += lineByteLen + 1;

      if (!line) continue;
      const trimmed = line.trim();
      if (!trimmed) continue;

      if (looksLikeSkippedType(trimmed)) continue;

      const events = parseStreamLine(trimmed);
      if (events.length === 0) continue;

      if (stillSkippingPastSince) {
        if (events.some((e) => e.eventId === sinceEventId)) {
          // Found the boundary line — skip ALL events on it and resume from the next.
          stillSkippingPastSince = false;
        }
        continue;
      }

      for (const event of events) {
        yield { event, offset: pos };
      }
    }
  } catch (err) {
    // Swallow ENOENT (race: file deleted after the existence check); rethrow others.
    const e = err as NodeJS.ErrnoException;
    if (e?.code !== "ENOENT") throw err;
  } finally {
    rl.close();
    stream.destroy();
  }
}

/**
 * Quick pre-parse check for wrapper types we want to skip. Cheaper than a
 * full `JSON.parse`; falls through to the parser if uncertain.
 */
function looksLikeSkippedType(line: string): boolean {
  for (const t of SKIP_ON_DISK_TYPES) {
    if (line.includes(`"type":"${t}"`) || line.includes(`"type": "${t}"`)) {
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Peek (cheap last-event read)
// ---------------------------------------------------------------------------

export interface ClaudePeekResult {
  /** Last successfully parsed event, or null if the file is empty/missing/unparseable. */
  lastEvent: StreamEvent | null;
  /** Total size of the file in bytes, or null if the file is missing. */
  size: number | null;
}

/**
 * Drift-check primitive. Reads up to {@link PEEK_TAIL_BYTES} from the end of
 * the file, parses the last complete line, and returns the last event plus
 * total file size.
 *
 * Does NOT stream the whole file — designed to be called frequently as a
 * cheap "has this changed since I last checked?" probe. Walks back through
 * the buffer if the last line is a skipped wrapper type or fails to parse.
 *
 * Returns `{ lastEvent: null, size }` if the tail buffer holds no parseable
 * line — caller should fall back to a full read if it needs guaranteed data.
 */
export async function peekClaudeTranscript(filePath: string): Promise<ClaudePeekResult> {
  let size: number;
  try {
    const s = await stat(filePath);
    size = s.size;
  } catch {
    return { lastEvent: null, size: null };
  }
  if (size === 0) return { lastEvent: null, size: 0 };

  const readBytes = Math.min(PEEK_TAIL_BYTES, size);
  const start = size - readBytes;
  const startedMidFile = start > 0;

  let handle;
  try {
    handle = await fsOpen(filePath, "r");
  } catch {
    return { lastEvent: null, size };
  }

  try {
    const buf = Buffer.alloc(readBytes);
    await handle.read(buf, 0, readBytes, start);
    const text = buf.toString("utf8");

    // Split on `\n`, drop the trailing empty entry from a final newline.
    const lines = text.split("\n");
    if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();

    // If we started mid-file, line[0] is partial — never trust it.
    const minIdx = startedMidFile ? 1 : 0;

    for (let i = lines.length - 1; i >= minIdx; i--) {
      const raw = lines[i];
      if (raw === undefined) continue;
      const trimmed = raw.trim();
      if (!trimmed) continue;
      if (looksLikeSkippedType(trimmed)) continue;
      const events = parseStreamLine(trimmed);
      const last = events[events.length - 1];
      if (!last) continue;
      return { lastEvent: last, size };
    }

    return { lastEvent: null, size };
  } finally {
    await handle.close();
  }
}

// ---------------------------------------------------------------------------
// Polymorphic facade
// ---------------------------------------------------------------------------

/**
 * Polymorphic transcript ops for Claude. Delegates to the named functions
 * above; mounted as `claudeProvider.transcript` so apps doing runtime-
 * dispatched recovery can call `getProvider(name).transcript.find(...)`
 * without a switch statement.
 *
 * Apps that know they're on Claude at compile time should prefer the named
 * helpers (`getClaudeTranscriptPath`, `findClaudeTranscriptBySessionId`) —
 * they return richer types (`canonicalCwd`, `projectDir`, `claudeHome`) that
 * the polymorphic interface flattens away.
 */
export const claudeTranscriptOps: TranscriptOps<StreamEvent> = {
  async find(opts): Promise<FoundTranscript | null> {
    // Fast path: cwd hint provided → direct O(1) lookup.
    if (opts.cwd) {
      const loc = await getClaudeTranscriptPath({
        sessionId: opts.sessionId,
        cwd: opts.cwd,
      });
      if (await pathExists(loc.filePath)) {
        return { filePath: loc.filePath, cwd: loc.canonicalCwd };
      }
      // cwd was wrong (e.g. session was launched in a different worktree);
      // fall through to scan.
    }
    const found = await findClaudeTranscriptBySessionId({ sessionId: opts.sessionId });
    if (!found) return null;
    return { filePath: found.filePath, cwd: found.cwd };
  },
  read(opts) {
    return readClaudeTranscript(opts);
  },
  peek(filePath) {
    return peekClaudeTranscript(filePath);
  },
};
