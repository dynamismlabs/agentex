import type {
  SavedHistoryDiscoverOptions,
  SavedHistoryOps,
  SavedHistoryProbeOptions,
  SavedHistoryReadOptions,
  SavedHistorySession,
  SavedHistoryYield,
} from "../../history/types.js";
import { cleanTitle } from "../../history/fs.js";
import type { OpenCodeClient } from "./client.js";
import { collectHistory, historicalEvents, type MessageEnvelope } from "./history.js";
import { acquireOpenCodeRuntime } from "./runtime.js";

const SESSION_PAGE_SIZE = 100;
const MAX_SESSION_PAGES = 100;
const MAX_SESSIONS = 10_000;
const MAX_SESSION_LIST_BYTES = 25 * 1024 * 1024;
const MESSAGE_SCAN_PAGE_SIZE = 100;
const MAX_MESSAGE_SCAN_PAGES = 100;
const MAX_MESSAGE_SCAN_BYTES = 25 * 1024 * 1024;
const MAX_DISCOVERY_INSPECTION_BYTES = 25 * 1024 * 1024;
const MAX_DISCOVERY_INSPECTION_MESSAGES = 10_000;
const INSPECTION_CONCURRENCY = 8;

type SessionListEndpoint = "experimental" | "legacy";

interface OpenCodeSessionEnvelope extends Record<string, unknown> {
  id?: unknown;
  directory?: unknown;
  title?: unknown;
  parentID?: unknown;
  time?: unknown;
}

interface SessionPage {
  endpoint: SessionListEndpoint;
  sessions: OpenCodeSessionEnvelope[];
  nextCursor: string | null;
  bytes: number;
}

interface InspectionBudget {
  bytes: number;
  messages: number;
}

export class OpenCodeSavedHistoryDiscoveryLimitError extends Error {
  readonly code = "history_discovery_limit";

  constructor() {
    super("OpenCode saved-session discovery exceeded the bounded import limit");
    this.name = "OpenCodeSavedHistoryDiscoveryLimitError";
  }
}

export class OpenCodeSavedHistoryInvalidSessionError extends Error {
  readonly code = "invalid_session";

  constructor(message = "Invalid OpenCode saved-history session") {
    super(message);
    this.name = "OpenCodeSavedHistoryInvalidSessionError";
  }
}

export class OpenCodeSavedHistoryProtocolError extends Error {
  readonly code = "history_protocol_error";

  constructor(message: string) {
    super(message);
    this.name = "OpenCodeSavedHistoryProtocolError";
  }
}

function rec(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function string(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function millis(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function isoMillis(value: unknown): string | null {
  const timestamp = millis(value);
  if (timestamp === null) return null;
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function normalizedLimit(limit: number | undefined): number | null {
  if (limit === undefined) return null;
  if (!Number.isFinite(limit)) return null;
  return Math.max(0, Math.floor(limit));
}

function parseResponseArray(text: string, description: string): unknown[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new OpenCodeSavedHistoryProtocolError(
      `OpenCode ${description} response is not valid JSON`,
    );
  }
  if (!Array.isArray(parsed)) {
    throw new OpenCodeSavedHistoryProtocolError(
      `OpenCode ${description} response is not an array`,
    );
  }
  return parsed;
}

function sessionQuery(
  options: SavedHistoryDiscoverOptions | SavedHistoryProbeOptions,
  limit: number,
  endpoint: SessionListEndpoint,
  cursor?: string,
  discovery = false,
): URLSearchParams {
  const query = new URLSearchParams({ limit: String(limit) });
  const discover = options as SavedHistoryDiscoverOptions;
  if (discovery && (discover.mainSessionsOnly ?? true)) {
    query.set("roots", "true");
  }
  if (discovery && discover.directory) query.set("directory", discover.directory);
  if (discovery && endpoint === "experimental" && (discover.includeArchived ?? true)) {
    query.set("archived", "true");
  }
  if (endpoint === "experimental" && cursor) query.set("cursor", cursor);
  return query;
}

async function parseSessionPage(
  response: Response,
  endpoint: SessionListEndpoint,
): Promise<SessionPage> {
  if (!response.ok) {
    throw new Error(`OpenCode saved-session request failed (${response.status})`);
  }
  const text = await response.text();
  const parsed = parseResponseArray(text, "saved-session");
  return {
    endpoint,
    sessions: parsed.map((value) => rec(value)).filter((value): value is OpenCodeSessionEnvelope => !!value),
    nextCursor: endpoint === "experimental" ? response.headers.get("x-next-cursor") : null,
    bytes: Buffer.byteLength(text),
  };
}

async function firstSessionPage(
  client: OpenCodeClient,
  options: SavedHistoryDiscoverOptions | SavedHistoryProbeOptions,
  limit: number,
  discovery = false,
): Promise<SessionPage> {
  const experimentalQuery = sessionQuery(options, limit, "experimental", undefined, discovery);
  const experimental = await client.request(`/experimental/session?${experimentalQuery}`);
  if (experimental.status !== 404) return parseSessionPage(experimental, "experimental");

  // OpenCode versions before the global endpoint exposed GET /session as a
  // global list. It has no cursor or archived-session switch, but remains a
  // useful compatibility path for active sessions.
  const legacyQuery = sessionQuery(
    options,
    discovery ? MAX_SESSIONS : limit,
    "legacy",
    undefined,
    discovery,
  );
  return parseSessionPage(await client.request(`/session?${legacyQuery}`), "legacy");
}

async function nextSessionPage(
  client: OpenCodeClient,
  options: SavedHistoryDiscoverOptions,
  endpoint: SessionListEndpoint,
  cursor: string,
): Promise<SessionPage> {
  const query = sessionQuery(options, SESSION_PAGE_SIZE, endpoint, cursor, true);
  return parseSessionPage(
    await client.request(`/${endpoint === "experimental" ? "experimental/" : ""}session?${query}`),
    endpoint,
  );
}

async function findUserText(
  client: OpenCodeClient,
  sessionId: string,
  budget: InspectionBudget,
): Promise<string | null> {
  let before: string | null = null;
  let sessionBytes = 0;
  for (let pageIndex = 0; pageIndex < MAX_MESSAGE_SCAN_PAGES; pageIndex += 1) {
    const query = new URLSearchParams({ limit: String(MESSAGE_SCAN_PAGE_SIZE) });
    if (before) query.set("before", before);
    const response = await client.request(
      `/session/${encodeURIComponent(sessionId)}/message?${query}`,
    );
    if (response.status === 404) return null;
    if (!response.ok) {
      throw new Error(`OpenCode saved-session message request failed (${response.status})`);
    }
    const read = await readInspectionText(response, sessionBytes, budget);
    const text = read.text;
    sessionBytes = read.sessionBytes;
    const parsed = parseResponseArray(text, "saved-session message");
    const messages = parsed
      .map((value) => rec(value) as MessageEnvelope)
      .filter(Boolean);
    budget.messages += messages.length;
    if (budget.messages > MAX_DISCOVERY_INSPECTION_MESSAGES) {
      throw new OpenCodeSavedHistoryDiscoveryLimitError();
    }
    for (const message of messages) {
      const user = historicalEvents(message, sessionId, { includeUserMessages: true })
        .find((item) => item.event.type === "user");
      if (user?.event.type === "user") return user.event.text;
    }
    if (messages.length < MESSAGE_SCAN_PAGE_SIZE) return null;
    const next = response.headers.get("x-next-cursor");
    if (!next || next === before) return null;
    before = next;
  }
  throw new OpenCodeSavedHistoryDiscoveryLimitError();
}

async function readInspectionText(
  response: Response,
  priorSessionBytes: number,
  budget: InspectionBudget,
): Promise<{ text: string; sessionBytes: number }> {
  const reader = response.body?.getReader();
  if (!reader) {
    const text = await response.text();
    const size = Buffer.byteLength(text);
    const sessionBytes = priorSessionBytes + size;
    budget.bytes += size;
    if (
      sessionBytes > MAX_MESSAGE_SCAN_BYTES
      || budget.bytes > MAX_DISCOVERY_INSPECTION_BYTES
    ) {
      throw new OpenCodeSavedHistoryDiscoveryLimitError();
    }
    return { text, sessionBytes };
  }

  const chunks: Uint8Array[] = [];
  let total = 0;
  let sessionBytes = priorSessionBytes;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const size = value.byteLength;
    total += size;
    sessionBytes += size;
    budget.bytes += size;
    if (
      sessionBytes > MAX_MESSAGE_SCAN_BYTES
      || budget.bytes > MAX_DISCOVERY_INSPECTION_BYTES
    ) {
      await reader.cancel().catch(() => undefined);
      throw new OpenCodeSavedHistoryDiscoveryLimitError();
    }
    chunks.push(value);
  }
  return {
    text: Buffer.concat(chunks, total).toString("utf8"),
    sessionBytes,
  };
}

async function inspectSession(
  client: OpenCodeClient,
  raw: OpenCodeSessionEnvelope,
  options: SavedHistoryDiscoverOptions,
  budget: InspectionBudget,
): Promise<SavedHistorySession | null> {
  const externalSessionId = string(raw.id);
  const time = rec(raw.time);
  const updatedAt = isoMillis(time?.["updated"]);
  if (!externalSessionId || !updatedAt) return null;
  if ((options.mainSessionsOnly ?? true) && string(raw.parentID)) return null;

  const userText = await findUserText(client, externalSessionId, budget);
  const hasUserMessage = userText !== null;
  if ((options.requireUserMessage ?? true) && !hasUserMessage) return null;
  const archived = millis(time?.["archived"]);
  return {
    version: 1,
    providerType: "opencode",
    externalSessionId,
    cwd: string(raw.directory),
    title: cleanTitle(string(raw.title)) ?? cleanTitle(userText),
    startedAt: isoMillis(time?.["created"]),
    updatedAt,
    branch: null,
    gitOriginUrl: null,
    archiveState: archived === null ? "active" : "archived",
    hasUserMessage,
  };
}

async function inspectBatch(
  client: OpenCodeClient,
  sessions: OpenCodeSessionEnvelope[],
  options: SavedHistoryDiscoverOptions,
  budget: InspectionBudget,
): Promise<Array<SavedHistorySession | null>> {
  const output = new Array<SavedHistorySession | null>(sessions.length).fill(null);
  const failures: unknown[] = [];
  let next = 0;
  const workers = Array.from(
    { length: Math.min(INSPECTION_CONCURRENCY, sessions.length) },
    async () => {
      while (true) {
        if (failures.length > 0) return;
        const index = next;
        next += 1;
        if (index >= sessions.length) return;
        const session = sessions[index];
        if (!session) continue;
        try {
          output[index] = await inspectSession(client, session, options, budget);
        } catch (error) {
          // A 404 is converted to null inside findUserText because that one
          // candidate disappeared. Any thrown error is systemic or makes the
          // scan incomplete, so discovery must not report a partial catalog
          // as authoritative to a synchronizing host.
          failures.push(error);
          return;
        }
      }
    },
  );
  await Promise.all(workers);
  if (failures.length > 0) throw failures[0];
  return output;
}

/** @internal Exported for deterministic provider contract tests. */
export async function* discoverOpenCodeSavedSessions(
  client: OpenCodeClient,
  options: SavedHistoryDiscoverOptions = {},
): AsyncIterable<SavedHistorySession> {
  const requestedLimit = normalizedLimit(options.limit);
  if (requestedLimit === 0) return;

  let page = await firstSessionPage(client, options, SESSION_PAGE_SIZE, true);
  let totalSessions = 0;
  let totalBytes = 0;
  let yielded = 0;
  let pageCount = 0;
  let previousCursor: string | null = null;
  const inspectionBudget: InspectionBudget = { bytes: 0, messages: 0 };
  while (true) {
    pageCount += 1;
    totalSessions += page.sessions.length;
    totalBytes += page.bytes;
    if (
      totalSessions > MAX_SESSIONS
      || totalBytes > MAX_SESSION_LIST_BYTES
      || pageCount > MAX_SESSION_PAGES
    ) {
      throw new OpenCodeSavedHistoryDiscoveryLimitError();
    }

    const inspected = await inspectBatch(client, page.sessions, options, inspectionBudget);
    for (const session of inspected) {
      if (!session) continue;
      yield session;
      yielded += 1;
      if (requestedLimit !== null && yielded >= requestedLimit) return;
    }

    if (page.endpoint === "legacy") {
      if (
        page.sessions.length >= MAX_SESSIONS
        && (requestedLimit === null || yielded < requestedLimit)
      ) {
        throw new OpenCodeSavedHistoryDiscoveryLimitError();
      }
      return;
    }
    if (!page.nextCursor) return;
    if (page.nextCursor === previousCursor) throw new OpenCodeSavedHistoryDiscoveryLimitError();
    previousCursor = page.nextCursor;
    page = await nextSessionPage(client, options, page.endpoint, page.nextCursor);
  }
}

/** @internal Exported for deterministic provider contract tests. */
export async function* readOpenCodeSavedSession(
  client: OpenCodeClient,
  session: SavedHistorySession,
  options: SavedHistoryReadOptions = {},
): AsyncIterable<SavedHistoryYield> {
  if (session.providerType !== "opencode" || !session.externalSessionId) {
    throw new OpenCodeSavedHistoryInvalidSessionError();
  }
  const collected = await collectHistory(
    client,
    session.externalSessionId,
    { after: options.after, mode: options.mode },
    { includeUserMessages: true, missingSession: "error" },
  );
  for (const item of collected) {
    const eventId = item.eventId;
    if (!eventId) throw new OpenCodeSavedHistoryInvalidSessionError("OpenCode history event has no stable id");
    yield {
      event: { ...item.event, eventId },
      checkpoint: item.checkpoint,
      eventId,
      partIndex: item.partIndex,
    };
  }
}

export const openCodeSavedHistory: SavedHistoryOps = {
  async probe(options: SavedHistoryProbeOptions = {}) {
    let runtime: Awaited<ReturnType<typeof acquireOpenCodeRuntime>> | null = null;
    try {
      runtime = await acquireOpenCodeRuntime(options);
      const limit = Math.max(1, normalizedLimit(options.limit) ?? SESSION_PAGE_SIZE);
      const page = await firstSessionPage(runtime.server.client, options, limit);
      return {
        providerType: "opencode",
        sourceAvailable: true,
        historyAvailable: page.sessions.length > 0,
        approximateCount: page.sessions.length,
      };
    } catch {
      return {
        providerType: "opencode",
        sourceAvailable: false,
        historyAvailable: false,
      };
    } finally {
      runtime?.server.release();
    }
  },

  async *discover(options: SavedHistoryDiscoverOptions = {}) {
    const runtime = await acquireOpenCodeRuntime(options);
    try {
      yield* discoverOpenCodeSavedSessions(runtime.server.client, options);
    } finally {
      runtime.server.release();
    }
  },

  async *read(session, options: SavedHistoryReadOptions = {}) {
    const runtime = await acquireOpenCodeRuntime({
      ...options,
      cwd: session.cwd ?? options.cwd,
    });
    try {
      yield* readOpenCodeSavedSession(runtime.server.client, session, options);
    } finally {
      runtime.server.release();
    }
  },
};
