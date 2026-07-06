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
    const { lastEvent } = await peekCodexTranscript(transcript.filePath);
    if (lastEvent === null) lastTurn = "unknown";
    else if (lastEvent.type === "event_msg" && lastEvent.payload?.["type"] === "task_complete")
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
      return createCodexSession({ ...ctx, sessionParams: params });
    },
  };
}
