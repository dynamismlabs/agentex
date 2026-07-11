import type {
  AttachOptions,
  CatchUpOptions,
  CatchUpYield,
  FoundTranscript,
  LastTurnStatus,
  SessionAttachment,
  SessionContext,
  SessionRecord,
} from "../../types.js";
import {
  assertSessionRecord,
  createSessionRecord,
  MalformedSessionRecordError,
} from "../../sessions/record.js";
import { getRuntimeHomeEnvVar } from "../../utils/runtime-homes.js";
import { codexSessionCodec } from "./codec.js";
import {
  type CodexTranscriptLine,
  getCodexTranscriptPath,
  peekCodexTranscript,
  readCodexCwd,
  readCodexTranscript,
} from "./transcript.js";
import { codexLineToStreamEvents } from "./transcript-normalize.js";
// Heavy-on-heavy behind the lazy `attachSession` boundary (spec §5.3 / §9.6).
import { createCodexSession } from "./session.js";

/** Home-dir override derived from `opts.env` (same var the transcript helpers honor). */
function homeOverride(opts?: AttachOptions): string | undefined {
  const key = getRuntimeHomeEnvVar("codex");
  return key ? opts?.env?.[key] : undefined;
}

const EMPTY: AsyncIterable<CatchUpYield> = {
  async *[Symbol.asyncIterator]() {
    /* no transcript → nothing to replay */
  },
};

function isTurnBoundary(line: CodexTranscriptLine, sessionId: string): boolean {
  const payloadType = typeof line.payload?.["type"] === "string" ? line.payload["type"] : null;

  // These raw records start a turn but intentionally normalize to no replay
  // event. They must still supersede an earlier task_complete when deciding
  // whether the latest persisted turn was interrupted.
  if (line.type === "event_msg" && (payloadType === "task_started" || payloadType === "user_message")) {
    return true;
  }
  if (line.type === "response_item" && payloadType === "message" && line.payload?.["role"] === "user") {
    return true;
  }
  if (line.type === "message" && line.raw["role"] === "user") return true;

  return codexLineToStreamEvents(line, { sessionId }).some((event) => ![
    "system",
    "permission_mode",
    "rate_limit",
    "goal_status",
    "unknown",
  ].includes(event.type));
}

async function latestTurnBoundary(
  filePath: string,
  sessionId: string,
): Promise<CodexTranscriptLine | null> {
  const { lastEvent } = await peekCodexTranscript(filePath, {
    accept: (line) => isTurnBoundary(line, sessionId),
  });
  if (lastEvent) return lastEvent;
  let latest: CodexTranscriptLine | null = null;
  for await (const { event } of readCodexTranscript({ filePath })) {
    if (isTurnBoundary(event, sessionId)) latest = event;
  }
  return latest;
}

/**
 * Read-only reattachment to a durable Codex session. Same skeleton as Claude,
 * with two deltas: classify via the rollout's last line, and replay through
 * `codexLineToStreamEvents` (Codex has no wire ids, so `eventId` is always null
 * — hosts gate replay dedup on their own running flag, per spec §9.7).
 */
export async function attachCodexSession(
  record: SessionRecord,
  opts?: AttachOptions,
): Promise<SessionAttachment> {
  assertSessionRecord(record);
  if (record.providerType !== "codex") {
    throw new MalformedSessionRecordError(
      `codex attach requires providerType "codex"; got ${JSON.stringify(record.providerType)}`,
      "providerType",
    );
  }

  // 1. Normalize params through the codec.
  const params = codexSessionCodec.deserialize(record.params);
  if (!params) {
    throw new MalformedSessionRecordError(
      "codex session record params carry no usable sessionId",
      "params",
    );
  }
  const sessionId = params["sessionId"] as string;
  const cwd =
    (typeof params["cwd"] === "string" ? (params["cwd"] as string) : null) ?? record.cwd ?? null;

  // 2. Locate the rollout (honoring opts.env home override). Codex indexes by
  //    date, not cwd, so cwd is not a lookup key here.
  const codexHome = homeOverride(opts);
  const loc = await getCodexTranscriptPath({
    sessionId,
    ...(codexHome ? { codexHome } : {}),
  });
  let transcript: FoundTranscript | null = null;
  if (loc) {
    transcript = { filePath: loc.filePath, cwd: await readCodexCwd(loc.filePath) };
  }

  // Preserve the codec/record cwd on the normalized record (the transcript's
  // own recovered cwd is exposed separately on `.transcript.cwd`).
  const normalized = createSessionRecord({
    providerType: "codex",
    params,
    cwd,
    displayId: codexSessionCodec.getDisplayId?.(params) ?? null,
  });

  // 3. Classify how the last persisted turn ended.
  let lastTurn: LastTurnStatus = "unknown";
  if (transcript) {
    const lastEvent = await latestTurnBoundary(transcript.filePath, sessionId);
    if (lastEvent === null) lastTurn = "unknown";
    else if (codexLineToStreamEvents(lastEvent, { sessionId }).some((event) => event.type === "result"))
      lastTurn = "completed";
    else lastTurn = "interrupted";
  }

  return {
    record: normalized,
    transcript,
    lastTurn,
    // 4. Replay: map each rollout line through the normalizer; one yield per
    //    produced event, all sharing the line's offset, eventId always null.
    catchUp(catchOpts?: CatchUpOptions): AsyncIterable<CatchUpYield> {
      if (!transcript) return EMPTY;
      const filePath = transcript.filePath;
      const sid = sessionId;
      return {
        async *[Symbol.asyncIterator]() {
          for await (const { event: line, offset } of readCodexTranscript({
            filePath,
            ...(catchOpts?.fromOffset !== undefined ? { fromOffset: catchOpts.fromOffset } : {}),
          })) {
            for (const event of codexLineToStreamEvents(line, { sessionId: sid })) {
              yield { event, offset, eventId: null };
            }
          }
        },
      };
    },
    // 5. Continue live — exactly `createSession` with the record's params.
    resume(ctx?: SessionContext) {
      return createCodexSession({ ...ctx, cwd: ctx?.cwd ?? cwd ?? undefined, sessionParams: params });
    },
  };
}
