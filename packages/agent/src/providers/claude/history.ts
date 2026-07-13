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
  UUID_JSONL_RE,
  asRecord,
  asString,
  cleanTitle,
  isDirectory,
  isoDate,
  meaningfulHumanText,
  readJsonlRecords,
  recentEligible,
  sourceFingerprint,
  textFromContent,
} from "../../history/fs.js";
import { parseStreamLine } from "./parse.js";
import { resolveClaudeHome } from "./transcript.js";

const TITLE_SCAN_BYTES = 64 * 1024;
const MAX_DISCOVERY_SCAN_BYTES = 4 * 1024 * 1024;
const DEFAULT_PROBE_LIMIT = 100;
const DISCOVERY_CONCURRENCY = 16;
const DROP_EVENT_TYPES = new Set([
  "assistant_delta",
  "thinking_delta",
  "permission_mode",
  "rate_limit",
  "unknown",
]);

function claudeHome(options?: { env?: Record<string, string> }): string {
  return resolveClaudeHome(options?.env?.["CLAUDE_CONFIG_DIR"]);
}

async function listClaudeSessionFiles(
  home: string,
  options: { limit?: number; includeSubagents?: boolean } = {},
): Promise<string[]> {
  const projectsRoot = path.join(home, "projects");
  let projects;
  try {
    projects = await readdir(projectsRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  projects.sort((a, b) => a.name.localeCompare(b.name));
  const files: string[] = [];
  const cap = Math.max(1, options.limit ?? Number.MAX_SAFE_INTEGER);
  for (const project of projects) {
    if (files.length >= cap) break;
    if (!project.isDirectory()) continue;
    let entries;
    try {
      entries = await readdir(path.join(projectsRoot, project.name), { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (files.length >= cap) break;
      // Top-level UUID files are main sessions. Nested subagent directories and
      // symlinks are deliberately ignored.
      if (entry.isFile() && UUID_JSONL_RE.test(entry.name)) {
        files.push(path.join(projectsRoot, project.name, entry.name));
      }
      if (options.includeSubagents && entry.isDirectory() && UUID_JSONL_RE.test(`${entry.name}.jsonl`)) {
        const subagentsDir = path.join(projectsRoot, project.name, entry.name, "subagents");
        let subagents;
        try {
          subagents = await readdir(subagentsDir, { withFileTypes: true });
        } catch {
          continue;
        }
        subagents.sort((a, b) => a.name.localeCompare(b.name));
        for (const subagent of subagents) {
          if (files.length >= cap) break;
          if (subagent.isFile() && /^agent-[a-z0-9]+\.jsonl$/i.test(subagent.name)) {
            files.push(path.join(subagentsDir, subagent.name));
          }
        }
      }
    }
  }
  return files;
}

function subagentParentId(transcriptPath: string): string | null {
  if (path.basename(path.dirname(transcriptPath)) !== "subagents") return null;
  return path.basename(path.dirname(path.dirname(transcriptPath))) || null;
}

async function parentSessionMetadata(
  transcriptPath: string,
): Promise<{ cwd: string | null; branch: string | null }> {
  const parentId = subagentParentId(transcriptPath);
  if (!parentId) return { cwd: null, branch: null };
  const projectDir = path.dirname(path.dirname(path.dirname(transcriptPath)));
  const parentTranscript = path.join(projectDir, `${parentId}.jsonl`);
  for await (const line of readJsonlRecords(parentTranscript)) {
    const cwd = absoluteCwd(asString(line.raw["cwd"]));
    const branch = asString(line.raw["gitBranch"]);
    if (cwd) return { cwd, branch };
    if (line.nextOffset >= TITLE_SCAN_BYTES) break;
  }
  return { cwd: null, branch: null };
}

function claudeUserText(record: Record<string, unknown>): string | null {
  if (record["type"] !== "user") return null;
  const message = asRecord(record["message"]);
  if (!message || message["role"] !== "user") return null;
  return meaningfulHumanText(textFromContent(
    message["content"],
    new Set(["text", "input_text"]),
  ));
}

function absoluteCwd(value: string | null): string | null {
  return value && path.isAbsolute(value) ? value : null;
}

async function inspectClaudeSession(
  transcriptPath: string,
  options: LocalHistoryDiscoverOptions,
): Promise<LocalHistorySession | null> {
  const fileIdentity = path.basename(transcriptPath, ".jsonl");
  const parentId = subagentParentId(transcriptPath);
  const externalSessionId = parentId
    ? `subagent:${parentId}:${fileIdentity}`
    : fileIdentity;
  let cwd: string | null = null;
  let title: string | null = null;
  let firstPrompt: string | null = null;
  let startedAt: string | null = null;
  let branch: string | null = null;
  let sidechain = false;

  for await (const line of readJsonlRecords(transcriptPath)) {
    const record = line.raw;
    if (record["isSidechain"] === true) sidechain = true;
    cwd ??= absoluteCwd(asString(record["cwd"]));
    startedAt ??= isoDate(record["timestamp"]);
    branch ??= asString(record["gitBranch"]);
    if (record["type"] === "ai-title") title ??= cleanTitle(asString(record["aiTitle"]));
    firstPrompt ??= claudeUserText(record);
    if (cwd && firstPrompt && (title || line.nextOffset >= TITLE_SCAN_BYTES)) break;
    if (line.nextOffset >= MAX_DISCOVERY_SCAN_BYTES) break;
  }

  if (!cwd && parentId) {
    const parent = await parentSessionMetadata(transcriptPath);
    cwd = parent.cwd;
    branch ??= parent.branch;
  }

  if ((options.mainSessionsOnly ?? true) && sidechain) return null;
  const hasUserMessage = firstPrompt !== null;
  if ((options.requireUserMessage ?? true) && !hasUserMessage) return null;
  if ((options.mainSessionsOnly ?? true) && !cwd) return null;
  if (options.cwd && (!cwd || path.normalize(cwd) !== path.normalize(options.cwd))) return null;

  const source = await sourceFingerprint(transcriptPath);
  return {
    version: 1,
    providerType: "claude",
    externalSessionId,
    transcriptPath,
    cwd,
    title: title ?? cleanTitle(firstPrompt),
    startedAt,
    updatedAt: new Date(Number(BigInt(source.modifiedAtNs) / 1_000_000n)).toISOString(),
    branch,
    gitOriginUrl: null,
    archiveState: "unknown",
    hasUserMessage,
    source,
  };
}

function baseFields(
  session: LocalHistorySession,
  raw: Record<string, unknown>,
  eventId: string,
): BaseStreamEventFields & { eventId: string } {
  const message = asRecord(raw["message"]);
  return {
    timestamp: isoDate(raw["timestamp"], session.startedAt ?? new Date(0).toISOString())!,
    providerType: "claude",
    sessionId: session.externalSessionId,
    messageId: asString(message?.["id"]),
    eventId,
    turnId: null,
    parentToolCallId: asString(raw["parent_tool_use_id"]),
    raw,
  };
}

function normalizedClaudeEvents(
  session: LocalHistorySession,
  raw: Record<string, unknown>,
  text: string,
  eventId: string,
): Array<StreamEvent & { eventId: string }> {
  return parseStreamLine(text)
    .filter((event) => !DROP_EVENT_TYPES.has(event.type))
    .map((event) => ({
      ...event,
      timestamp: isoDate(raw["timestamp"], event.timestamp)!,
      providerType: "claude",
      sessionId: session.externalSessionId,
      eventId,
      raw,
    } as StreamEvent & { eventId: string }));
}

export const claudeLocalHistory: LocalHistoryOps = {
  async probe(options?: LocalHistoryProbeOptions) {
    const home = claudeHome(options);
    const homeAvailable = await isDirectory(home);
    const files = homeAvailable
      ? await listClaudeSessionFiles(home, { limit: options?.limit ?? DEFAULT_PROBE_LIMIT })
      : [];
    return {
      providerType: "claude",
      homeAvailable,
      historyAvailable: files.length > 0,
      approximateCount: files.length,
    };
  },

  async *discover(options: LocalHistoryDiscoverOptions = {}) {
    const files = await listClaudeSessionFiles(claudeHome(options), {
      includeSubagents: options.mainSessionsOnly === false,
    });
    const sessions = await recentEligible(
      files,
      { limit: options.limit, concurrency: DISCOVERY_CONCURRENCY },
      async (filePath) => {
        try {
          return await inspectClaudeSession(filePath, options);
        } catch {
          return null;
        }
      },
    );
    for (const session of sessions) yield session;
  },

  async *read(session, options = {}): AsyncIterable<LocalHistoryYield> {
    if (session.providerType !== "claude" || !path.isAbsolute(session.transcriptPath)) {
      throw new Error("Invalid Claude local history session");
    }
    for await (const line of readJsonlRecords(
      session.transcriptPath,
      options.fromOffset ?? 0,
      { rejectChanges: true },
    )) {
      const eventId = asString(line.raw["uuid"])
        ?? `claude:${session.externalSessionId}:${line.lineStartOffset}`;
      const events: LocalHistoryYield["event"][] = [];
      const userText = claudeUserText(line.raw);
      if (userText) {
        events.push({ type: "user", text: userText, ...baseFields(session, line.raw, eventId) });
      }
      events.push(...normalizedClaudeEvents(session, line.raw, line.text, eventId));
      for (let partIndex = 0; partIndex < events.length; partIndex++) {
        yield {
          event: events[partIndex]!,
          lineStartOffset: line.lineStartOffset,
          nextOffset: line.nextOffset,
          partIndex,
        };
      }
    }
  },

  fingerprint(session, options) {
    if (session.providerType !== "claude") throw new Error("Invalid Claude local history session");
    return sourceFingerprint(session.transcriptPath, options?.sha256 ?? false);
  },
};
