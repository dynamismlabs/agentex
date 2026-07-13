import { createHash } from "node:crypto";
import { readdir, stat, open as openFile, type FileHandle } from "node:fs/promises";
import * as path from "node:path";
import * as readline from "node:readline";

import {
  LocalHistoryError,
  type LocalHistorySourceFingerprint,
} from "./types.js";

export const UUID_JSONL_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/i;
export const ROLLOUT_UUID_RE = /-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

export interface JsonlRecord {
  raw: Record<string, unknown>;
  text: string;
  lineStartOffset: number;
  nextOffset: number;
}

interface StableReadOptions {
  /** Reject a completed read when the opened source changed while streaming. */
  rejectChanges?: boolean;
  /** Internal deterministic test hook. Not part of the public history API. */
  afterInitialStat?: () => void | Promise<void>;
}

interface FileIdentity {
  size: bigint;
  modifiedAtNs: bigint;
  device: bigint;
  inode: bigint;
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

export function isoDate(value: unknown, fallback: string | null = null): string | null {
  if (typeof value !== "string") return fallback;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? fallback : parsed.toISOString();
}

export function cleanTitle(value: string | null): string | null {
  const cleaned = value
    ?.replace(/<[^>]+>/g, " ")
    .replace(/\[\[[^\]]+\]\]/g, " ")
    .replace(/^[#>*_`\s-]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return null;
  return cleaned.length > 120 ? `${cleaned.slice(0, 117).trimEnd()}...` : cleaned;
}

export async function isDirectory(filePath: string): Promise<boolean> {
  try {
    return (await stat(filePath)).isDirectory();
  } catch {
    return false;
  }
}

export async function listJsonlFiles(
  root: string,
  options: { maxDepth: number; limit?: number; accept?: (name: string) => boolean },
): Promise<string[]> {
  const files: string[] = [];
  const limit = Math.max(1, options.limit ?? Number.MAX_SAFE_INTEGER);

  async function visit(dir: string, depth: number): Promise<void> {
    if (depth > options.maxDepth || files.length >= limit) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (files.length >= limit) break;
      const child = path.join(dir, entry.name);
      if (entry.isDirectory()) await visit(child, depth + 1);
      else if (entry.isFile() && entry.name.endsWith(".jsonl") && (options.accept?.(entry.name) ?? true)) {
        files.push(child);
      }
    }
  }

  await visit(root, 0);
  return files;
}

export async function mapLimited<T, U>(
  values: readonly T[],
  concurrency: number,
  mapper: (value: T) => Promise<U>,
): Promise<U[]> {
  const output = new Array<U>(values.length);
  let cursor = 0;
  async function worker(): Promise<void> {
    while (cursor < values.length) {
      const index = cursor++;
      output[index] = await mapper(values[index]!);
    }
  }
  await Promise.all(Array.from(
    { length: Math.min(Math.max(1, concurrency), values.length) },
    () => worker(),
  ));
  return output;
}

async function fileIdentity(handle: FileHandle): Promise<FileIdentity> {
  const info = await handle.stat({ bigint: true });
  if (!info.isFile()) throw new LocalHistoryError("invalid_session", "Local history source is not a file");
  return {
    size: info.size,
    modifiedAtNs: info.mtimeNs,
    device: info.dev,
    inode: info.ino,
  };
}

function sameFileIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.size === right.size
    && left.modifiedAtNs === right.modifiedAtNs
    && left.device === right.device
    && left.inode === right.inode;
}

function sourceChangedError(): LocalHistoryError {
  return new LocalHistoryError(
    "source_changed_during_read",
    "Local history source changed during the read",
  );
}

function wrapFileError(error: unknown, action: "inspect" | "read" | "hash"): LocalHistoryError {
  if (error instanceof LocalHistoryError) return error;
  const code = (error as NodeJS.ErrnoException).code;
  return new LocalHistoryError(
    code === "ENOENT" ? "source_missing" : code === "EACCES" ? "permission_denied" : "io_error",
    code === "ENOENT"
      ? "Local history source is missing"
      : `Unable to ${action} local history source`,
    { cause: error },
  );
}

export async function recentEligible<T>(
  filePaths: readonly string[],
  options: { limit?: number; concurrency?: number },
  inspect: (filePath: string) => Promise<T | null>,
): Promise<T[]> {
  const limit = options.limit === undefined
    ? Number.MAX_SAFE_INTEGER
    : Math.max(0, options.limit);
  if (limit === 0 || filePaths.length === 0) return [];

  const metadata = await mapLimited(filePaths, 32, async (filePath) => {
    try {
      const info = await stat(filePath, { bigint: true });
      return info.isFile() ? { filePath, modifiedAtNs: info.mtimeNs } : null;
    } catch {
      return null;
    }
  });
  const ordered = metadata
    .filter((value): value is { filePath: string; modifiedAtNs: bigint } => value !== null)
    .sort((a, b) => a.modifiedAtNs === b.modifiedAtNs
      ? a.filePath.localeCompare(b.filePath)
      : a.modifiedAtNs > b.modifiedAtNs ? -1 : 1);

  const output: T[] = [];
  const concurrency = Math.max(1, options.concurrency ?? 16);
  let cursor = 0;
  while (cursor < ordered.length && output.length < limit) {
    // Never inspect more files than the number of results still requested in
    // one batch. Excluded files cause another bounded batch to be pulled.
    const batchSize = Math.min(concurrency, limit - output.length, ordered.length - cursor);
    const batch = ordered.slice(cursor, cursor + batchSize);
    cursor += batch.length;
    const inspected = await mapLimited(batch, concurrency, ({ filePath }) => inspect(filePath));
    for (const value of inspected) {
      if (value !== null) output.push(value);
      if (output.length >= limit) break;
    }
  }
  return output;
}

export async function sourceFingerprint(
  filePath: string,
  includeSha256 = false,
  internalOptions: StableReadOptions = {},
): Promise<LocalHistorySourceFingerprint> {
  let handle: FileHandle | null = null;
  try {
    handle = await openFile(filePath, "r");
    const before = await fileIdentity(handle);
    const fingerprint: LocalHistorySourceFingerprint = {
      size: Number(before.size),
      modifiedAtNs: before.modifiedAtNs.toString(),
    };
    if (!includeSha256) return fingerprint;

    await internalOptions.afterInitialStat?.();
    const hash = createHash("sha256");
    const stream = handle.createReadStream({ autoClose: false });
    let after: FileIdentity;
    try {
      for await (const chunk of stream) hash.update(chunk as Buffer);
      after = await fileIdentity(handle);
    } finally {
      stream.destroy();
    }
    if (!sameFileIdentity(before, after)) throw sourceChangedError();
    fingerprint.sha256 = hash.digest("hex");
    return fingerprint;
  } catch (error) {
    throw wrapFileError(error, includeSha256 ? "hash" : "inspect");
  } finally {
    await handle?.close();
  }
}

export async function* readJsonlRecords(
  filePath: string,
  fromOffset = 0,
  options: StableReadOptions = {},
): AsyncIterable<JsonlRecord> {
  let handle: FileHandle | null = null;
  let stream: ReturnType<FileHandle["createReadStream"]> | null = null;
  let rl: readline.Interface | null = null;
  let offset = fromOffset;
  try {
    handle = await openFile(filePath, "r");
    const before = await fileIdentity(handle);
    await options.afterInitialStat?.();
    stream = handle.createReadStream({ start: fromOffset, encoding: "utf8", autoClose: false });
    stream.on("error", () => {});
    rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    for await (const line of rl) {
      const lineStartOffset = offset;
      offset += Buffer.byteLength(line, "utf8") + 1;
      if (!line.trim()) continue;
      try {
        const raw = asRecord(JSON.parse(line));
        if (raw) yield { raw, text: line, lineStartOffset, nextOffset: offset };
      } catch {
        // A damaged historical record must not hide later valid records.
      }
    }
    if (options.rejectChanges) {
      const after = await fileIdentity(handle);
      if (!sameFileIdentity(before, after)) throw sourceChangedError();
      let pathInfo;
      try {
        pathInfo = await stat(filePath, { bigint: true });
      } catch (error) {
        throw wrapFileError(error, "inspect");
      }
      if (pathInfo.dev !== after.device || pathInfo.ino !== after.inode) throw sourceChangedError();
    }
  } catch (error) {
    throw wrapFileError(error, "read");
  } finally {
    rl?.close();
    stream?.destroy();
    await handle?.close();
  }
}

export function textFromContent(content: unknown, acceptedTypes: ReadonlySet<string>): string | null {
  if (typeof content === "string") return content.trim() || null;
  if (!Array.isArray(content)) return null;
  const parts: string[] = [];
  for (const value of content) {
    const block = asRecord(value);
    if (!block) continue;
    const type = asString(block["type"]);
    if (type && !acceptedTypes.has(type)) continue;
    const text = asString(block["text"]) ?? asString(block["content"]);
    if (text) parts.push(text);
  }
  return parts.join("\n\n").trim() || null;
}

export function meaningfulHumanText(text: string | null): string | null {
  if (!text) return null;
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (/^<(?:environment_context|user_instructions|developer_instructions|system-reminder)[\s>]/i.test(trimmed)) {
    return null;
  }
  if (/^<(?:local-command-caveat|command-name|command-message|command-args)[\s>]/i.test(trimmed)) {
    return null;
  }
  return trimmed;
}
