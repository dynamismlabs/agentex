/**
 * Codex writes a durable JSONL rollout for every session under
 * `<codexHome>/sessions/YYYY/MM/DD/rollout-<TIMESTAMP>-<sessionId>.jsonl`.
 *
 * Unlike Claude's project-keyed layout, Codex organizes rollouts by start
 * date. The session ID is encoded at the end of the filename, after the
 * launch timestamp. Locating a rollout by sessionId therefore requires a
 * filename scan; there is no deterministic single-path-from-sessionId
 * computation.
 *
 * On-disk format diverges from Codex's stream wire format. The wire format
 * (handled by {@link parseCodexStreamLine}) emits either JSON-RPC
 * notifications (`{method, params}`) or NDJSON events (`{type: "thread.started", ...}`).
 * The on-disk format uses one of two shapes depending on Codex version:
 *
 *   1. Newer (≥0.10): `{timestamp, type: "session_meta"|"event_msg"|"response_item", payload: {...}}`
 *   2. Older (pre-0.10): unwrapped — first line is `{id, timestamp, instructions}`,
 *      subsequent lines are `{type: "message"|"reasoning"|..., ...}` directly
 *
 * These helpers expose path discovery + raw-line streaming. Translating the
 * on-disk types into `StreamEvent`s requires knowing the full Codex internal
 * event vocabulary (which differs across versions and is not externally
 * documented), so that work is left to consumers — they read structured raw
 * lines and interpret payloads against the version they care about.
 */

import { createReadStream } from "node:fs";
import { readdir, stat, open as fsOpen } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline";

import { getDefaultRuntimeHome, getRuntimeHomeEnvVar } from "../../utils/runtime-homes.js";
import type { FoundTranscript, TranscriptOps } from "../../types.js";

/** Bytes scanned from the tail of the file in {@link peekCodexTranscript}. */
const PEEK_TAIL_BYTES = 16 * 1024;

/**
 * Resolve Codex's config home directory. Honors `$CODEX_HOME` first, falls
 * back to `~/.codex`.
 */
export function resolveCodexHome(override?: string): string {
  if (override) return override;
  const envVar = getRuntimeHomeEnvVar("codex");
  const fromEnv = envVar ? process.env[envVar] : undefined;
  return fromEnv ?? getDefaultRuntimeHome("codex") ?? path.join(os.homedir(), ".codex");
}

// ---------------------------------------------------------------------------
// Path discovery
// ---------------------------------------------------------------------------

export interface GetCodexTranscriptPathOptions {
  /** Codex session ID (UUID). Matches the `id` field in the session_meta line. */
  sessionId: string;
  /** Override the Codex home. Defaults to `$CODEX_HOME` or `~/.codex`. */
  codexHome?: string;
  /**
   * Also search `<codexHome>/archived_sessions/`. Default `true`. Codex moves
   * old rollouts here during cleanup; without this fallback, recovery of
   * older sessions would fail.
   */
  searchArchived?: boolean;
}

export interface CodexTranscriptLocation {
  /** Absolute path to the rollout JSONL. */
  filePath: string;
  /** Which subtree it was found in. */
  source: "active" | "archived";
  /** The codex home that was searched. */
  codexHome: string;
}

/**
 * Read the literal cwd Codex was launched with, recovered from the first
 * `session_meta` line in a rollout (or the legacy unwrapped first line for
 * pre-0.10 transcripts).
 *
 * Returns `null` if the file has no recoverable cwd (truncated transcript,
 * unrecognized format, etc.). Stops scanning after the first ~50 lines —
 * `session_meta` is always the first line, but the older format may need a
 * few lines to find the `environment_context` user_message with the cwd.
 */
export async function readCodexCwd(filePath: string): Promise<string | null> {
  let count = 0;
  for await (const { event } of readCodexTranscript({ filePath })) {
    count++;

    // Wrapped (≥0.10): first line is `{type: "session_meta", payload: {cwd}}`.
    if (event.type === "session_meta" && event.payload) {
      const cwd = event.payload["cwd"];
      if (typeof cwd === "string" && cwd) return cwd;
    }

    // Legacy unwrapped: cwd is buried inside a user `message` with an
    // `environment_context` block. Two phrasings have shipped:
    //   1. XML-style: `<environment_context><cwd>/path</cwd>...`
    //   2. Plaintext: `<environment_context>\nCurrent working directory: /path\n...`
    if (event.type === "message") {
      const role = event.raw["role"];
      const content = event.raw["content"];
      if (role === "user" && Array.isArray(content)) {
        for (const block of content) {
          if (typeof block !== "object" || block === null) continue;
          const b = block as Record<string, unknown>;
          if (b["type"] !== "input_text") continue;
          const text = typeof b["text"] === "string" ? b["text"] : "";
          const xml = text.match(/<cwd>([^<]+)<\/cwd>/);
          if (xml && xml[1]) return xml[1];
          const plain = text.match(/Current working directory:\s*([^\n\r]+)/);
          if (plain && plain[1]) return plain[1].trim();
        }
      }
    }

    if (count >= 50) break;
  }
  return null;
}

/**
 * Locate a Codex rollout file by session ID. Scans the date-organized tree
 * under `<codexHome>/sessions/` in reverse-chronological order (newest first,
 * since recent sessions are the common lookup target), then optionally
 * `<codexHome>/archived_sessions/`.
 *
 * Returns `null` if no matching rollout is found. The session ID must be
 * the exact UUID Codex assigned — partial matches are not accepted.
 */
export async function getCodexTranscriptPath(
  opts: GetCodexTranscriptPathOptions,
): Promise<CodexTranscriptLocation | null> {
  if (!opts.sessionId) throw new Error("getCodexTranscriptPath: sessionId is required");

  const codexHome = resolveCodexHome(opts.codexHome);
  const fileSuffix = `-${opts.sessionId}.jsonl`;

  // Active sessions: newest-first walk.
  const active = path.join(codexHome, "sessions");
  const activeMatch = await findRolloutBySuffix(active, fileSuffix, /*reverseChrono*/ true);
  if (activeMatch) return { filePath: activeMatch, source: "active", codexHome };

  if (opts.searchArchived !== false) {
    const archived = path.join(codexHome, "archived_sessions");
    const archivedMatch = await findRolloutBySuffix(archived, fileSuffix, /*reverseChrono*/ false);
    if (archivedMatch) return { filePath: archivedMatch, source: "archived", codexHome };
  }

  return null;
}

/**
 * Walk a sessions root looking for a file whose name ends in `suffix`.
 *
 * Codex's `sessions/` is `YYYY/MM/DD/` — three layers of numeric directories.
 * We probe top-down so we can short-circuit. `reverseChrono` flips each
 * layer's traversal order to prioritize recent dates first. `archived_sessions/`
 * is flat (no date layout), so we just scan its direct contents.
 */
async function findRolloutBySuffix(
  root: string,
  suffix: string,
  reverseChrono: boolean,
): Promise<string | null> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return null;
  }

  // Flat case (archived_sessions): files live directly in `root`.
  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith(suffix)) {
      return path.join(root, entry.name);
    }
  }

  // Date-tree case: scan YYYY/MM/DD/ ordered for fast recent-first lookup.
  const dateDirs = entries.filter((e) => e.isDirectory() && /^\d{4}$/.test(e.name));
  sortDirNamesChrono(dateDirs, reverseChrono);

  for (const yearDir of dateDirs) {
    const yearPath = path.join(root, yearDir.name);
    let monthEntries;
    try {
      monthEntries = await readdir(yearPath, { withFileTypes: true });
    } catch {
      continue;
    }
    const months = monthEntries.filter((e) => e.isDirectory() && /^\d{2}$/.test(e.name));
    sortDirNamesChrono(months, reverseChrono);

    for (const monthDir of months) {
      const monthPath = path.join(yearPath, monthDir.name);
      let dayEntries;
      try {
        dayEntries = await readdir(monthPath, { withFileTypes: true });
      } catch {
        continue;
      }
      const days = dayEntries.filter((e) => e.isDirectory() && /^\d{2}$/.test(e.name));
      sortDirNamesChrono(days, reverseChrono);

      for (const dayDir of days) {
        const dayPath = path.join(monthPath, dayDir.name);
        let files;
        try {
          files = await readdir(dayPath, { withFileTypes: true });
        } catch {
          continue;
        }
        for (const f of files) {
          if (f.isFile() && f.name.endsWith(suffix)) {
            return path.join(dayPath, f.name);
          }
        }
      }
    }
  }

  return null;
}

function sortDirNamesChrono(entries: { name: string }[], reverse: boolean): void {
  entries.sort((a, b) => (reverse ? b.name.localeCompare(a.name) : a.name.localeCompare(b.name)));
}

// ---------------------------------------------------------------------------
// Streaming raw-line reader
// ---------------------------------------------------------------------------

/**
 * Best-effort parsed view of a single Codex transcript line, normalized
 * across the wrapped (≥0.10) and unwrapped (pre-0.10) on-disk formats.
 */
export interface CodexTranscriptLine {
  /** Raw JSON-parsed object verbatim from the file. */
  raw: Record<string, unknown>;
  /**
   * Outer wrapper type when present:
   *   - "session_meta", "event_msg", "response_item" — wrapped (≥0.10) lines
   *   - For unwrapped lines, falls back to the line's own `type` field
   *     (e.g., "message", "reasoning", "function_call_output").
   *   - `null` for lines with no `type` field (e.g., the older
   *     `{record_type: "state"}` markers or the bare-meta first line).
   */
  type: string | null;
  /** ISO timestamp from the line's `timestamp` field, or null if absent. */
  timestamp: string | null;
  /**
   * Inner payload as a parsed object, when the wrapped format is used.
   * `null` for unwrapped lines — in that case the meaningful fields are on
   * {@link raw} directly.
   */
  payload: Record<string, unknown> | null;
  /**
   * Replay-stable synthetic identity, set by {@link readCodexTranscript}:
   * `codex:<rolloutSessionId>:<lineStartByteOffset>`. Codex emits no native
   * per-event uuid, so this is the idempotency key hosts use to dedup
   * transcript replays — deterministic across reads of the same file.
   *
   * `null` when a line is parsed standalone via {@link parseCodexLine} (no
   * file/offset context). NOTE: live app-server events use a different
   * synthetic scheme (`codex:<threadId>:<turnId>:<itemId>:<eventType>`) over a
   * different wire vocabulary (`command_execution` vs `exec_command`), so ids
   * do NOT match across the live and on-disk readers — cross-shape dedup
   * remains a host concern.
   */
  eventId: string | null;
}

export interface ReadCodexTranscriptOptions {
  /** Absolute path to the rollout JSONL. */
  filePath: string;
  /**
   * Byte offset to resume from. Must be line-aligned. Use an offset previously
   * yielded by this function. Defaults to 0 (start of file).
   */
  fromOffset?: number;
}

export interface CodexTranscriptYield {
  /**
   * Parsed line, normalized for the consumer. Named `event` for symmetry
   * with Claude's `readClaudeTranscript` and the polymorphic
   * `provider.transcript.read` interface — both yield `{event, offset}`.
   * The underlying type is provider-specific (`CodexTranscriptLine` here,
   * `StreamEvent` for Claude).
   */
  event: CodexTranscriptLine;
  /**
   * Byte offset immediately AFTER the trailing `\n` of this line. Pass back
   * as {@link ReadCodexTranscriptOptions.fromOffset} to resume on the next line.
   */
  offset: number;
}

/**
 * Stream-read a Codex rollout JSONL, yielding parsed lines.
 *
 * Behavior:
 * - Empty async iterable if the file doesn't exist (no throw).
 * - Silently skips lines that fail to JSON.parse.
 * - Does not interpret payloads — that's the consumer's responsibility,
 *   since the on-disk event vocabulary is version-specific.
 */
export async function* readCodexTranscript(
  opts: ReadCodexTranscriptOptions,
): AsyncIterable<CodexTranscriptYield> {
  const { filePath, fromOffset = 0 } = opts;

  if (!(await pathExists(filePath))) return;

  const stream = createReadStream(filePath, { start: fromOffset, encoding: undefined });
  stream.on("error", () => {});
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  const fileIdentity = rolloutIdentityFromPath(filePath);
  let pos = fromOffset;
  try {
    for await (const line of rl) {
      const lineStart = pos;
      pos += Buffer.byteLength(line, "utf8") + 1;

      const trimmed = line.trim();
      if (!trimmed) continue;

      const parsed = parseCodexLine(trimmed);
      if (!parsed) continue;

      // Replay-stable synthetic identity: (rollout identity, line start offset).
      // Codex emits no native per-event uuid, so this is the idempotency key
      // hosts use to dedup transcript replays. Deterministic across reads.
      parsed.eventId = `codex:${fileIdentity}:${lineStart}`;

      yield { event: parsed, offset: pos };
    }
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e?.code !== "ENOENT") throw err;
  } finally {
    rl.close();
    stream.destroy();
  }
}

/**
 * Parse a single Codex transcript line into a normalized view. Returns
 * `null` for lines that don't parse as JSON objects.
 *
 * Exported because consumers reading the file by other means (e.g. tailing
 * a write stream) can use it to get the same shape this module yields.
 */
export function parseCodexLine(line: string): CodexTranscriptLine | null {
  let obj: unknown;
  try {
    obj = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof obj !== "object" || obj === null || Array.isArray(obj)) return null;

  const raw = obj as Record<string, unknown>;
  const type = typeof raw["type"] === "string" ? (raw["type"] as string) : null;
  const timestamp = typeof raw["timestamp"] === "string" ? (raw["timestamp"] as string) : null;

  let payload: Record<string, unknown> | null = null;
  const rawPayload = raw["payload"];
  if (typeof rawPayload === "object" && rawPayload !== null && !Array.isArray(rawPayload)) {
    payload = rawPayload as Record<string, unknown>;
  }

  return { raw, type, timestamp, payload, eventId: null };
}

// Rollout filenames are `rollout-<TIMESTAMP>-<sessionId>.jsonl`; the session id
// is the trailing UUID. Fall back to the bare basename when it doesn't match
// (still deterministic for the same file).
const ROLLOUT_UUID_RE =
  /-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

function rolloutIdentityFromPath(filePath: string): string {
  const m = path.basename(filePath).match(ROLLOUT_UUID_RE);
  return m ? m[1]! : path.basename(filePath, ".jsonl");
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
// Peek (last line + size)
// ---------------------------------------------------------------------------

export interface CodexPeekResult {
  /**
   * Last successfully parsed line, or null if the file is empty/missing/unparseable.
   * Named `lastEvent` for symmetry with Claude's `peekClaudeTranscript` and
   * the polymorphic `provider.transcript.peek` interface.
   */
  lastEvent: CodexTranscriptLine | null;
  /** Total size of the file in bytes, or null if missing. */
  size: number | null;
}

/**
 * Cheap drift-check: reads up to {@link PEEK_TAIL_BYTES} from the tail,
 * walks back to the last parseable line, returns it plus the file size.
 */
export async function peekCodexTranscript(
  filePath: string,
  options: { accept?: (event: CodexTranscriptLine) => boolean } = {},
): Promise<CodexPeekResult> {
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

    const lines = text.split("\n");
    if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();

    const minIdx = startedMidFile ? 1 : 0;
    for (let i = lines.length - 1; i >= minIdx; i--) {
      const raw = lines[i];
      if (raw === undefined) continue;
      const trimmed = raw.trim();
      if (!trimmed) continue;
      const parsed = parseCodexLine(trimmed);
      if (!parsed) continue;
      if (options.accept && !options.accept(parsed)) continue;
      return { lastEvent: parsed, size };
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
 * Polymorphic transcript ops for Codex. Delegates to the named functions
 * above; mounted as `codexProvider.transcript`. The `cwd` hint to `find` is
 * accepted for interface symmetry with Claude but is ignored — Codex
 * rollouts are organized by date, not by cwd.
 */
export const codexTranscriptOps: TranscriptOps<CodexTranscriptLine> = {
  async find(opts): Promise<FoundTranscript | null> {
    const loc = await getCodexTranscriptPath({ sessionId: opts.sessionId });
    if (!loc) return null;
    const cwd = await readCodexCwd(loc.filePath);
    return { filePath: loc.filePath, cwd };
  },
  read(opts) {
    return readCodexTranscript(opts);
  },
  peek(filePath) {
    return peekCodexTranscript(filePath);
  },
};
