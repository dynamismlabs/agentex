import * as path from "node:path";
import { readdir } from "node:fs/promises";

import type { BaseStreamEventFields, StreamEvent } from "../../types.js";
import type {
  LocalHistoryDiscoverOptions,
  LocalHistoryOps,
  LocalHistoryProbeOptions,
  LocalHistorySession,
  LocalHistoryYield,
} from "../../history/types.js";
import {
  ROLLOUT_UUID_RE,
  asRecord,
  asString,
  cleanTitle,
  isDirectory,
  isoDate,
  listJsonlFiles,
  meaningfulHumanText,
  readJsonlRecords,
  recentEligible,
  sourceFingerprint,
  textFromContent,
} from "../../history/fs.js";
import { codexLineToStreamEvents } from "./transcript-normalize.js";
import { parseCodexLine, resolveCodexHome, type CodexTranscriptLine } from "./transcript.js";

const MAX_DISCOVERY_SCAN_BYTES = 4 * 1024 * 1024;
const DEFAULT_PROBE_LIMIT = 100;
const DISCOVERY_CONCURRENCY = 16;

function codexHome(options?: { env?: Record<string, string> }): string {
  return resolveCodexHome(options?.env?.["CODEX_HOME"]);
}

async function listCodexSessionFiles(
  home: string,
  options: { includeArchived: boolean; limit?: number },
): Promise<string[]> {
  const cap = Math.max(1, options.limit ?? Number.MAX_SAFE_INTEGER);
  const active = await listJsonlFiles(path.join(home, "sessions"), {
    maxDepth: 5,
    limit: cap,
    accept: (name) => ROLLOUT_UUID_RE.test(name),
  });
  if (!options.includeArchived || active.length >= cap) return active;
  const archived = await listJsonlFiles(path.join(home, "archived_sessions"), {
    maxDepth: 2,
    limit: cap - active.length,
    accept: (name) => ROLLOUT_UUID_RE.test(name),
  });
  return [...active, ...archived];
}

function codexUserText(line: CodexTranscriptLine): string | null {
  if (line.type === "event_msg" && line.payload?.["type"] === "user_message") {
    return meaningfulHumanText(asString(line.payload["message"]));
  }
  // Older unwrapped rollouts have no event_msg mirror.
  if (line.type === "message" && line.raw["role"] === "user") {
    return meaningfulHumanText(textFromContent(
      line.raw["content"],
      new Set(["text", "input_text"]),
    ));
  }
  return null;
}

function isSubagentMeta(payload: Record<string, unknown>): boolean {
  if (asString(payload["parent_thread_id"])) return true;
  if (payload["thread_source"] === "subagent") return true;
  const source = asRecord(payload["source"]);
  return !!source && source["subagent"] !== undefined;
}

function legacyCwd(record: Record<string, unknown>): string | null {
  if (record["type"] !== "message" || record["role"] !== "user") return null;
  const text = textFromContent(record["content"], new Set(["text", "input_text"]));
  const xml = text?.match(/<cwd>([^<]+)<\/cwd>/)?.[1];
  const plain = text?.match(/Current working directory:\s*([^\n\r]+)/)?.[1];
  const candidate = (xml ?? plain)?.trim();
  return candidate && path.isAbsolute(candidate) ? candidate : null;
}

async function loadSessionIndexTitles(home: string): Promise<Map<string, string>> {
  const titles = new Map<string, string>();
  try {
    for await (const line of readJsonlRecords(path.join(home, "session_index.jsonl"))) {
      const id = asString(line.raw["id"]);
      const title = cleanTitle(asString(line.raw["thread_name"]));
      if (id && title) titles.set(id, title);
    }
  } catch {
    // The index is optional and absent on older Codex versions.
  }
  return titles;
}

interface SqliteDatabase {
  prepare(sql: string): { all(): unknown[] };
  close(): void;
}

async function stateDatabasePaths(home: string): Promise<string[]> {
  const paths: string[] = [];
  for (const dir of [home, path.join(home, "sqlite")]) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isFile() && /^state_\d+\.sqlite$/.test(entry.name)) paths.push(path.join(dir, entry.name));
    }
  }
  return paths.sort().reverse();
}

async function loadSqliteTitles(home: string): Promise<Map<string, string>> {
  const titles = new Map<string, string>();
  try {
    // Keep Node 20 compatibility. node:sqlite is used opportunistically on
    // runtimes that provide it and is always opened read-only.
    const moduleName = "node:sqlite";
    const sqlite = await import(moduleName) as unknown as {
      DatabaseSync: new (filePath: string, options: { readOnly: boolean }) => SqliteDatabase;
    };
    for (const filePath of await stateDatabasePaths(home)) {
      let database: SqliteDatabase | null = null;
      try {
        database = new sqlite.DatabaseSync(filePath, { readOnly: true });
        for (const value of database.prepare("SELECT id, title FROM threads WHERE title <> ''").all()) {
          const row = asRecord(value);
          const id = asString(row?.["id"]);
          const title = cleanTitle(asString(row?.["title"]));
          if (id && title && !titles.has(id)) titles.set(id, title);
        }
        if (titles.size > 0) break;
      } catch {
        // Missing, locked, or schema-incompatible indexes are non-fatal.
      } finally {
        database?.close();
      }
    }
  } catch {
    // node:sqlite is unavailable on Node 20.
  }
  return titles;
}

async function loadCodexTitles(home: string): Promise<Map<string, string>> {
  const index = await loadSessionIndexTitles(home);
  // session_index is the least invasive and most portable source. SQLite is
  // a fallback for installations that do not maintain the JSONL index.
  return index.size > 0 ? index : loadSqliteTitles(home);
}

async function inspectCodexSession(
  transcriptPath: string,
  titles: ReadonlyMap<string, string>,
  options: LocalHistoryDiscoverOptions,
): Promise<LocalHistorySession | null> {
  let meta: Record<string, unknown> | null = null;
  let legacyMeta: Record<string, unknown> | null = null;
  let metaTimestamp: string | null = null;
  let firstPrompt: string | null = null;
  let fallbackCwd: string | null = null;

  for await (const record of readJsonlRecords(transcriptPath)) {
    const line = parseCodexLine(record.text);
    if (!line) continue;
    if (line.type === "session_meta" && line.payload) {
      meta ??= line.payload;
      metaTimestamp ??= line.timestamp;
    }
    if (line.type === null && asString(line.raw["id"])) legacyMeta ??= line.raw;
    firstPrompt ??= codexUserText(line);
    fallbackCwd ??= legacyCwd(line.raw);
    if (meta && firstPrompt) break;
    if (record.nextOffset >= MAX_DISCOVERY_SCAN_BYTES) break;
  }

  const fileId = path.basename(transcriptPath).match(ROLLOUT_UUID_RE)?.[1] ?? null;
  const externalSessionId = asString(meta?.["id"])
    ?? asString(meta?.["session_id"])
    ?? asString(legacyMeta?.["id"])
    ?? fileId;
  if (!externalSessionId) return null;
  if ((options.mainSessionsOnly ?? true) && meta && isSubagentMeta(meta)) return null;

  const metaCwd = asString(meta?.["cwd"]);
  const cwd = metaCwd && path.isAbsolute(metaCwd) ? metaCwd : fallbackCwd;
  if (!cwd || (options.cwd && path.normalize(cwd) !== path.normalize(options.cwd))) return null;
  const hasUserMessage = firstPrompt !== null;
  if ((options.requireUserMessage ?? true) && !hasUserMessage) return null;

  const git = asRecord(meta?.["git"]);
  const source = await sourceFingerprint(transcriptPath);
  const archiveState = transcriptPath.split(path.sep).includes("archived_sessions")
    ? "archived" as const
    : "active" as const;
  return {
    version: 1,
    providerType: "codex",
    externalSessionId,
    transcriptPath,
    cwd,
    title: titles.get(externalSessionId) ?? cleanTitle(firstPrompt),
    startedAt: isoDate(meta?.["timestamp"] ?? metaTimestamp ?? legacyMeta?.["timestamp"]),
    updatedAt: new Date(Number(BigInt(source.modifiedAtNs) / 1_000_000n)).toISOString(),
    branch: asString(git?.["branch"]) ?? asString(meta?.["git_branch"]),
    gitOriginUrl: asString(git?.["repository_url"])
      ?? asString(git?.["origin_url"])
      ?? asString(meta?.["git_origin_url"]),
    archiveState,
    hasUserMessage,
    source,
  };
}

function baseFields(
  session: LocalHistorySession,
  line: CodexTranscriptLine,
  eventId: string,
): BaseStreamEventFields & { eventId: string } {
  return {
    timestamp: isoDate(line.timestamp, session.startedAt ?? new Date(0).toISOString())!,
    providerType: "codex",
    sessionId: session.externalSessionId,
    messageId: null,
    eventId,
    turnId: null,
    parentToolCallId: null,
    raw: line.raw,
  };
}

function legacyCodexEvents(
  session: LocalHistorySession,
  line: CodexTranscriptLine,
  eventId: string,
): Array<StreamEvent & { eventId: string }> {
  if (line.payload) return [];
  const base = baseFields(session, line, eventId);
  if (line.type === "message" && line.raw["role"] === "assistant") {
    const text = textFromContent(line.raw["content"], new Set(["text", "output_text"]));
    return text ? [{ type: "assistant", text, ...base }] : [];
  }
  if (line.type === "reasoning") {
    const text = textFromContent(line.raw["summary"] ?? line.raw["content"], new Set(["text", "summary_text"]));
    return text ? [{ type: "thinking", text, ...base }] : [];
  }
  if (line.type === "function_call") {
    const toolCallId = asString(line.raw["call_id"]) ?? asString(line.raw["id"]);
    const name = asString(line.raw["name"]) ?? "function_call";
    const rawArguments = line.raw["arguments"];
    let input: Record<string, unknown> | string | null = asString(rawArguments);
    if (typeof rawArguments === "string") {
      try {
        const parsed = JSON.parse(rawArguments);
        if (asRecord(parsed)) input = parsed as Record<string, unknown>;
      } catch {
        // Preserve malformed arguments as their original string.
      }
    } else if (asRecord(rawArguments)) {
      input = rawArguments as Record<string, unknown>;
    }
    return [{ type: "tool_call", toolCallId, name, input, ...base }];
  }
  if (line.type === "function_call_output") {
    const output = line.raw["output"];
    let content = typeof output === "string" ? output : "";
    if (!content && output !== undefined) {
      try {
        content = JSON.stringify(output);
      } catch {
        content = "";
      }
    }
    return [{
      type: "tool_result",
      toolCallId: asString(line.raw["call_id"]),
      toolName: null,
      content,
      isError: line.raw["is_error"] === true,
      exitCode: typeof line.raw["exit_code"] === "number" ? line.raw["exit_code"] : null,
      ...base,
    }];
  }
  return [];
}

function dedupeCodexSessionFiles(filePaths: readonly string[]): string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  // listCodexSessionFiles returns active files first, so an active copy wins
  // over a briefly duplicated archive copy before transcript inspection.
  for (const filePath of filePaths) {
    const id = path.basename(filePath).match(ROLLOUT_UUID_RE)?.[1] ?? filePath;
    if (seen.has(id)) continue;
    seen.add(id);
    output.push(filePath);
  }
  return output;
}

function normalizedCodexEvents(
  session: LocalHistorySession,
  line: CodexTranscriptLine,
  eventId: string,
): Array<StreamEvent & { eventId: string }> {
  const events = line.payload
    ? codexLineToStreamEvents(line, { sessionId: session.externalSessionId })
    : legacyCodexEvents(session, line, eventId);
  return events
    .filter((event) => !((event.type === "assistant" || event.type === "thinking") && !event.text.trim()))
    .map((event) => ({
      ...event,
      timestamp: isoDate(line.timestamp, event.timestamp)!,
      providerType: "codex",
      sessionId: session.externalSessionId,
      eventId,
      raw: line.raw,
    } as StreamEvent & { eventId: string }));
}

export const codexLocalHistory: LocalHistoryOps = {
  async probe(options?: LocalHistoryProbeOptions) {
    const home = codexHome(options);
    const homeAvailable = await isDirectory(home);
    const files = homeAvailable
      ? await listCodexSessionFiles(home, {
        includeArchived: true,
        limit: options?.limit ?? DEFAULT_PROBE_LIMIT,
      })
      : [];
    return {
      providerType: "codex",
      homeAvailable,
      historyAvailable: files.length > 0,
      approximateCount: files.length,
    };
  },

  async *discover(options: LocalHistoryDiscoverOptions = {}) {
    const home = codexHome(options);
    const [files, titles] = await Promise.all([
      listCodexSessionFiles(home, { includeArchived: options.includeArchived ?? true }),
      loadCodexTitles(home),
    ]);
    const sessions = await recentEligible(
      dedupeCodexSessionFiles(files),
      { limit: options.limit, concurrency: DISCOVERY_CONCURRENCY },
      async (filePath) => {
        try {
          return await inspectCodexSession(filePath, titles, options);
        } catch {
          return null;
        }
      },
    );
    for (const session of sessions) yield session;
  },

  async *read(session, options = {}): AsyncIterable<LocalHistoryYield> {
    if (session.providerType !== "codex" || !path.isAbsolute(session.transcriptPath)) {
      throw new Error("Invalid Codex local history session");
    }
    for await (const record of readJsonlRecords(
      session.transcriptPath,
      options.fromOffset ?? 0,
      { rejectChanges: true },
    )) {
      const line = parseCodexLine(record.text);
      if (!line) continue;
      const eventId = `codex:${session.externalSessionId}:${record.lineStartOffset}`;
      line.eventId = eventId;
      const events: LocalHistoryYield["event"][] = [];
      const userText = codexUserText(line);
      if (userText) events.push({ type: "user", text: userText, ...baseFields(session, line, eventId) });
      events.push(...normalizedCodexEvents(session, line, eventId));
      for (let partIndex = 0; partIndex < events.length; partIndex++) {
        yield {
          event: events[partIndex]!,
          lineStartOffset: record.lineStartOffset,
          nextOffset: record.nextOffset,
          partIndex,
        };
      }
    }
  },

  fingerprint(session, options) {
    if (session.providerType !== "codex") throw new Error("Invalid Codex local history session");
    return sourceFingerprint(session.transcriptPath, options?.sha256 ?? false);
  },
};
