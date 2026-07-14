import { createHash } from "node:crypto";

import type {
  AttachOptions,
  HistoryAttachment,
  HistoryCatchUpOptions,
  HistoryCatchUpYield,
  HistoryCheckpoint,
  LastTurnStatus,
  SessionRecord,
} from "../../types.js";
import type { SavedHistoryEvent, SavedHistoryUserEvent } from "../../history/types.js";
import { meaningfulHumanText } from "../../history/fs.js";
import { assertSessionRecord, createSessionRecord, MalformedSessionRecordError } from "../../sessions/record.js";
import { acquireOpenCodeRuntime } from "./runtime.js";
import { opencodeSessionCodec } from "./codec.js";
import { createOpenCodeSession } from "./http-session.js";
import { mapOpenCodePart, mapOpenCodeToolCall, type OcBaseInfo } from "./event-parse.js";

const PAGE_SIZE = 100;
const MAX_PAGES = 100;
const MAX_MESSAGES = 10_000;
const MAX_BYTES = 25 * 1024 * 1024;
const CHECKPOINT_KIND = "opencode:message-part:v2";

export class OpenCodeHistoryCheckpointNotFoundError extends Error {
  readonly code = "history_checkpoint_not_found";
  constructor() {
    super("The OpenCode history checkpoint is no longer present");
    this.name = "OpenCodeHistoryCheckpointNotFoundError";
  }
}

export class OpenCodeHistoryResyncLimitError extends Error {
  readonly code = "history_resync_limit";
  constructor() {
    super("OpenCode history exceeded the bounded resync limit");
    this.name = "OpenCodeHistoryResyncLimitError";
  }
}

export class OpenCodeHistorySourceMissingError extends Error {
  readonly code = "source_missing";

  constructor(sessionId: string) {
    super(`OpenCode saved session ${JSON.stringify(sessionId)} no longer exists`);
    this.name = "OpenCodeHistorySourceMissingError";
  }
}

interface DecodedCheckpoint {
  messageId: string;
  partId: string;
  ordinal: number | null;
  messageRevision: string;
}

export interface MessageEnvelope extends Record<string, unknown> {
  info?: Record<string, unknown>;
  parts?: unknown[];
}

interface HistoricalEvent {
  event: SavedHistoryEvent;
  partId: string;
}

export interface CollectedHistoryEvent {
  event: SavedHistoryEvent;
  checkpoint: HistoryCheckpoint;
  eventId: string | null;
  partIndex: number;
}

function rec(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function string(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function historicalTimestamp(info: Record<string, unknown>): string {
  const created = rec(info["time"])?.["created"];
  if (typeof created === "number" && Number.isFinite(created)) {
    const timestamp = new Date(created);
    if (!Number.isNaN(timestamp.getTime())) return timestamp.toISOString();
  }
  return new Date(0).toISOString();
}

function decodeCheckpoint(checkpoint: HistoryCheckpoint | undefined): DecodedCheckpoint | null {
  if (!checkpoint) return null;
  if (checkpoint.kind !== CHECKPOINT_KIND) throw new OpenCodeHistoryCheckpointNotFoundError();
  const value = rec(checkpoint.value);
  const messageId = string(value?.["messageId"]);
  const partId = string(value?.["partId"]);
  const messageRevision = string(value?.["messageRevision"]);
  if (!messageId || !partId || !messageRevision) throw new OpenCodeHistoryCheckpointNotFoundError();
  const ordinal = typeof value?.["ordinal"] === "number" && Number.isInteger(value["ordinal"])
    ? value["ordinal"] as number
    : null;
  return { messageId, partId, ordinal, messageRevision };
}

function checkpoint(
  messageId: string,
  partId: string,
  ordinal: number,
  messageRevision: string,
): HistoryCheckpoint {
  return {
    kind: CHECKPOINT_KIND,
    value: { messageId, partId, ordinal, messageRevision },
  };
}

function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJson);
  const record = rec(value);
  if (record) {
    return Object.fromEntries(
      Object.keys(record).sort().map((key) => [key, canonicalJson(record[key])]),
    );
  }
  return value;
}

function messageRevision(message: MessageEnvelope): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalJson(message)))
    .digest("hex");
}

function userTextPart(part: Record<string, unknown>): string | null {
  if (part["synthetic"] === true || part["ignored"] === true) return null;
  if (part["type"] === "text") return string(part["text"]);
  if (part["type"] === "subtask") return string(part["prompt"]);
  return null;
}

function historicalUserEvent(
  message: MessageEnvelope,
  sessionId: string,
  timestamp: string,
): HistoricalEvent | null {
  const info = message.info ?? {};
  const messageId = string(info["id"]);
  const texts: string[] = [];
  let partId: string | null = null;
  for (const rawPart of Array.isArray(message.parts) ? message.parts : []) {
    const part = rec(rawPart);
    const text = part ? userTextPart(part) : null;
    if (!part || !text) continue;
    const candidatePartId = string(part["id"]);
    if (!candidatePartId) continue;
    texts.push(text);
    partId = candidatePartId;
  }
  const text = meaningfulHumanText(texts.join("\n\n"));
  if (!text || !partId) return null;
  const eventId = messageId ?? partId;
  const event: SavedHistoryUserEvent = {
    type: "user",
    text,
    timestamp,
    providerType: "opencode",
    sessionId,
    messageId,
    eventId,
    turnId: null,
    parentToolCallId: null,
    raw: message,
  };
  return { event, partId };
}

export function historicalEvents(
  message: MessageEnvelope,
  sessionId: string,
  options: { includeUserMessages?: boolean } = {},
): HistoricalEvent[] {
  const info = rec(message.info) ?? {};
  const messageId = string(info["id"]);
  const timestamp = historicalTimestamp(info);
  if (info["role"] === "user") {
    if (!options.includeUserMessages) return [];
    const user = historicalUserEvent(message, sessionId, timestamp);
    return user ? [user] : [];
  }
  if (info["role"] !== "assistant") return [];
  const base: OcBaseInfo = { provider: "opencode", sessionId, timestamp };
  const events: HistoricalEvent[] = [];
  for (const rawPart of Array.isArray(message.parts) ? message.parts : []) {
    const part = rec(rawPart);
    const partId = string(part?.["id"]);
    if (!part || !partId) continue;
    if (part["type"] === "tool") {
      events.push({ event: mapOpenCodeToolCall(part, base), partId });
      const result = mapOpenCodePart(part, base);
      if (result?.type === "tool_result") events.push({ event: result, partId });
      continue;
    }
    const event = mapOpenCodePart(part, base);
    if (event) events.push({ event, partId });
  }
  const lastPartId = events.at(-1)?.partId;
  const finished = string(info["finish"]) !== null || info["error"] != null;
  if (messageId && lastPartId && finished) {
    const error = info["error"] != null;
    events.push({
      partId: lastPartId,
      event: {
        type: "result",
        text: "",
        costUsd: typeof info["cost"] === "number" ? info["cost"] : null,
        isError: error,
        stopReason: null,
        terminalReason: error ? "failed" : "completed",
        numTurns: 1,
        durationMs: null,
        timestamp,
        providerType: "opencode",
        sessionId,
        messageId,
        eventId: `${messageId}:result`,
        turnId: null,
        parentToolCallId: null,
        raw: info,
      },
    });
  }
  return events;
}

export async function collectHistory(
  client: import("./client.js").OpenCodeClient,
  sessionId: string,
  options: HistoryCatchUpOptions | undefined,
  mapping: {
    includeUserMessages?: boolean;
    missingSession?: "empty" | "error";
  } = {},
): Promise<CollectedHistoryEvent[]> {
  const after = options?.mode === "bounded_full_resync" ? null : decodeCheckpoint(options?.after);
  const pages: MessageEnvelope[][] = [];
  let before: string | null = null;
  let foundMessage = after === null;
  let collectedMessages = 0;
  let collectedBytes = 0;

  for (let pageIndex = 0; pageIndex < MAX_PAGES; pageIndex += 1) {
    const query = new URLSearchParams({ limit: String(PAGE_SIZE) });
    if (before) query.set("before", before);
    const response = await client.request(`/session/${encodeURIComponent(sessionId)}/message?${query}`);
    if (response.status === 404) {
      if (mapping.missingSession === "error") {
        throw new OpenCodeHistorySourceMissingError(sessionId);
      }
      return [];
    }
    if (!response.ok) throw new Error(`OpenCode history request failed (${response.status})`);
    const text = await response.text();
    collectedBytes += Buffer.byteLength(text);
    const parsed = JSON.parse(text) as unknown;
    const page = Array.isArray(parsed)
      ? parsed.map((value) => rec(value) as MessageEnvelope).filter(Boolean)
      : [];
    collectedMessages += page.length;
    if (collectedBytes > MAX_BYTES || collectedMessages > MAX_MESSAGES) {
      throw new OpenCodeHistoryResyncLimitError();
    }
    pages.push(page);
    if (after && page.some((message) => string(message.info?.["id"]) === after.messageId)) {
      foundMessage = true;
      break;
    }
    if (page.length < PAGE_SIZE) break;
    const next = response.headers.get("x-next-cursor");
    if (!next || next === before) break;
    before = next;
  }

  if (!foundMessage) throw new OpenCodeHistoryCheckpointNotFoundError();
  if (pages.length === MAX_PAGES && pages.at(-1)?.length === PAGE_SIZE) {
    throw new OpenCodeHistoryResyncLimitError();
  }

  const messages = pages.reverse().flat();
  const output: CollectedHistoryEvent[] = [];
  let passedCheckpoint = after === null;
  let foundPart = after === null;
  for (const message of messages) {
    const messageId = string(message.info?.["id"]);
    if (!messageId) continue;
    const revision = messageRevision(message);
    if (
      after
      && messageId === after.messageId
      && revision !== after.messageRevision
    ) {
      throw new OpenCodeHistoryCheckpointNotFoundError();
    }
    const events = historicalEvents(message, sessionId, mapping);
    const partOrdinals = new Map<string, number>();
    for (const item of events) {
      const ordinal = partOrdinals.get(item.partId) ?? 0;
      partOrdinals.set(item.partId, ordinal + 1);
      if (!passedCheckpoint) {
        if (
          foundPart
          && after!.ordinal === null
          && messageId === after!.messageId
          && item.partId === after!.partId
        ) {
          continue;
        }
        if (
          messageId === after!.messageId
          && item.partId === after!.partId
          && (after!.ordinal === null || ordinal === after!.ordinal)
        ) {
          foundPart = true;
          continue;
        }
        if (foundPart) passedCheckpoint = true;
        else continue;
      }
      output.push({
        event: item.event,
        checkpoint: checkpoint(messageId, item.partId, ordinal, revision),
        eventId: item.event.eventId,
        partIndex: ordinal,
      });
    }
    if (foundPart && messageId === after?.messageId) passedCheckpoint = true;
  }
  if (!foundPart) throw new OpenCodeHistoryCheckpointNotFoundError();
  return output;
}

export async function attachOpenCodeHistory(
  record: SessionRecord,
  opts?: AttachOptions,
): Promise<HistoryAttachment> {
  assertSessionRecord(record);
  if (record.providerType !== "opencode") {
    throw new MalformedSessionRecordError(
      `opencode history attach requires providerType "opencode"; got ${JSON.stringify(record.providerType)}`,
      "providerType",
    );
  }
  const params = opencodeSessionCodec.deserialize(record.params);
  if (!params) throw new MalformedSessionRecordError("opencode history record has no session id", "params");
  const sessionId = params["sessionId"] as string;
  const cwd = typeof params["cwd"] === "string" ? params["cwd"] : record.cwd ?? process.cwd();
  const runtime = await acquireOpenCodeRuntime({ cwd, env: opts?.env, config: opts?.config });
  let lastTurn: LastTurnStatus = "unknown";
  try {
    const response = await runtime.server.client.request(`/session/${encodeURIComponent(sessionId)}/message?limit=1`);
    if (response.ok) {
      const messages = await response.json() as MessageEnvelope[];
      const info = messages.at(-1)?.info;
      lastTurn = info
        ? (info["finish"] && !info["error"] ? "completed" : "interrupted")
        : "unknown";
    }
  } catch {
    lastTurn = "unknown";
  }
  const normalized = createSessionRecord({
    providerType: "opencode",
    params: { sessionId, cwd },
    cwd,
    displayId: sessionId,
  });
  return {
    record: normalized,
    historySource: { kind: "service", description: "OpenCode authenticated session message history" },
    lastTurn,
    catchUp(options) {
      return {
        async *[Symbol.asyncIterator](): AsyncIterator<HistoryCatchUpYield> {
          for (const yielded of await collectHistory(runtime.server.client, sessionId, options)) {
            // Known-session catch-up deliberately excludes user prompts. The
            // host already owns them. `savedHistory.read()` opts in to users
            // when importing a conversation the host did not create.
            const event = yielded.event;
            if (event.type !== "user") yield { ...yielded, event };
          }
        },
      };
    },
    resume(ctx) {
      return createOpenCodeSession({ ...ctx, cwd: ctx?.cwd ?? cwd, sessionParams: params });
    },
    async close() {
      runtime.server.release();
    },
  };
}
