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
  return timestamp === null ? null : new Date(timestamp).toISOString();
}

function normalizedLimit(limit: number | undefined): number | null {
  if (limit === undefined) return null;
  if (!Number.isFinite(limit)) return null;
  return Math.max(0, Math.floor(limit));
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
  const parsed = JSON.parse(text) as unknown;
  if (!Array.isArray(parsed)) throw new Error("OpenCode saved-session response is not an array");
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
): Promise<string | null> {
  let before: string | null = null;
  let totalBytes = 0;
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
    const text = await response.text();
    totalBytes += Buffer.byteLength(text);
    if (totalBytes > MAX_MESSAGE_SCAN_BYTES) {
      throw new OpenCodeSavedHistoryDiscoveryLimitError();
    }
    const parsed = JSON.parse(text) as unknown;
    const messages = Array.isArray(parsed)
      ? parsed.map((value) => rec(value) as MessageEnvelope).filter(Boolean)
      : [];
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

async function inspectSession(
  client: OpenCodeClient,
  raw: OpenCodeSessionEnvelope,
  options: SavedHistoryDiscoverOptions,
): Promise<SavedHistorySession | null> {
  const externalSessionId = string(raw.id);
  const time = rec(raw.time);
  const updatedAt = isoMillis(time?.["updated"]);
  if (!externalSessionId || !updatedAt) return null;
  if ((options.mainSessionsOnly ?? true) && string(raw.parentID)) return null;

  const userText = await findUserText(client, externalSessionId);
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
): Promise<Array<SavedHistorySession | null>> {
  const output = new Array<SavedHistorySession | null>(sessions.length).fill(null);
  let next = 0;
  let fatal: OpenCodeSavedHistoryDiscoveryLimitError | null = null;
  const workers = Array.from(
    { length: Math.min(INSPECTION_CONCURRENCY, sessions.length) },
    async () => {
      while (true) {
        if (fatal) return;
        const index = next;
        next += 1;
        if (index >= sessions.length) return;
        const session = sessions[index];
        if (!session) continue;
        try {
          output[index] = await inspectSession(client, session, options);
        } catch (error) {
          // A session can be deleted or damaged between global listing and
          // message inspection. Isolate that candidate so the remaining
          // import catalog is still usable, while preserving safety bounds.
          if (error instanceof OpenCodeSavedHistoryDiscoveryLimitError) {
            fatal = error;
            return;
          }
          output[index] = null;
        }
      }
    },
  );
  await Promise.all(workers);
  if (fatal) throw fatal;
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

    const inspected = await inspectBatch(client, page.sessions, options);
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
    { includeUserMessages: true },
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
