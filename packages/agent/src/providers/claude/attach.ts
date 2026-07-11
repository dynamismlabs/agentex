import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import * as readline from "node:readline";
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
import { claudeSessionCodec } from "./codec.js";
import {
  findClaudeTranscriptBySessionId,
  getClaudeTranscriptPath,
  readClaudeTranscript,
} from "./transcript.js";
// Heavy-on-heavy is fine: this whole module loads lazily via
// `claudeProvider.attachSession`, behind the same dynamic-import boundary as
// `session.ts` itself (spec §5.3 / §9.6).
import { createClaudeSession } from "./session.js";

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

/** Home-dir override derived from `opts.env` (same var the transcript helpers honor). */
function homeOverride(opts?: AttachOptions): string | undefined {
  const key = getRuntimeHomeEnvVar("claude");
  return key ? opts?.env?.[key] : undefined;
}

/**
 * Locate a Claude transcript with an optional home override — mirrors
 * `claudeTranscriptOps.find` (cwd fast-path, then session-id scan) but threads
 * `claudeHome` through so `AttachOptions.env` is honored without mutating
 * `process.env`.
 */
async function locate(
  sessionId: string,
  cwd: string | null,
  claudeHome: string | undefined,
): Promise<FoundTranscript | null> {
  if (cwd) {
    const loc = await getClaudeTranscriptPath({
      sessionId,
      cwd,
      ...(claudeHome ? { claudeHome } : {}),
    });
    if (await pathExists(loc.filePath)) {
      return { filePath: loc.filePath, cwd: loc.canonicalCwd };
    }
    // cwd was wrong (session launched in a different worktree) → fall through.
  }
  const found = await findClaudeTranscriptBySessionId({
    sessionId,
    ...(claudeHome ? { claudeHome } : {}),
  });
  return found ? { filePath: found.filePath, cwd: found.cwd } : null;
}

const EMPTY: AsyncIterable<CatchUpYield> = {
  async *[Symbol.asyncIterator]() {
    /* no transcript → nothing to replay */
  },
};

/**
 * Classify lifecycle boundaries from the raw transcript rather than replay's
 * normalized events. Ordinary Claude `user` prompt records intentionally
 * normalize to no StreamEvent, but still start a new turn. Looking only at
 * normalized output can therefore mistake an interrupted new turn for the
 * preceding completed one.
 */
async function classifyLastTurn(filePath: string): Promise<LastTurnStatus> {
  const stream = createReadStream(filePath, { encoding: "utf8" });
  stream.on("error", () => {});
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let lastTurn: LastTurnStatus = "unknown";

  try {
    for await (const line of lines) {
      let raw: unknown;
      try {
        raw = JSON.parse(line);
      } catch {
        continue;
      }
      if (typeof raw !== "object" || raw === null || Array.isArray(raw)) continue;
      const type = (raw as Record<string, unknown>)["type"];
      if (type === "result") lastTurn = "completed";
      else if (type === "user" || type === "assistant") lastTurn = "interrupted";
    }
  } catch (error) {
    const fsError = error as NodeJS.ErrnoException;
    if (fsError?.code !== "ENOENT") throw error;
    return "unknown";
  } finally {
    lines.close();
    stream.destroy();
  }

  return lastTurn;
}

/**
 * Read-only reattachment to a durable Claude session. Composition of existing
 * primitives (codec + transcript ops + `createClaudeSession` resume) — spawns
 * nothing; `resume` is the one and only live-continuation path.
 */
export async function attachClaudeSession(
  record: SessionRecord,
  opts?: AttachOptions,
): Promise<SessionAttachment> {
  assertSessionRecord(record);
  if (record.providerType !== "claude") {
    throw new MalformedSessionRecordError(
      `claude attach requires providerType "claude"; got ${JSON.stringify(record.providerType)}`,
      "providerType",
    );
  }

  // 1. Normalize params through the codec.
  const params = claudeSessionCodec.deserialize(record.params);
  if (!params) {
    throw new MalformedSessionRecordError(
      "claude session record params carry no usable sessionId",
      "params",
    );
  }
  const sessionId = params["sessionId"] as string;
  const cwd =
    (typeof params["cwd"] === "string" ? (params["cwd"] as string) : null) ?? record.cwd ?? null;

  const normalized = createSessionRecord({
    providerType: "claude",
    params,
    cwd,
    displayId: claudeSessionCodec.getDisplayId?.(params) ?? null,
  });

  // 2. Locate the transcript (honoring opts.env home override).
  const transcript = await locate(sessionId, cwd, homeOverride(opts));

  // 3. Classify how the last persisted turn ended.
  let lastTurn: LastTurnStatus = "unknown";
  if (transcript) {
    lastTurn = await classifyLastTurn(transcript.filePath);
  }

  return {
    record: normalized,
    transcript,
    lastTurn,
    // 4. Replay normalized events with checkpointable offsets.
    catchUp(catchOpts?: CatchUpOptions): AsyncIterable<CatchUpYield> {
      if (!transcript) return EMPTY;
      const filePath = transcript.filePath;
      return {
        async *[Symbol.asyncIterator]() {
          for await (const { event, offset } of readClaudeTranscript({
            filePath,
            ...(catchOpts?.fromOffset !== undefined ? { fromOffset: catchOpts.fromOffset } : {}),
            ...(catchOpts?.sinceEventId !== undefined ? { sinceEventId: catchOpts.sinceEventId } : {}),
          })) {
            yield { event, offset, eventId: event.eventId };
          }
        },
      };
    },
    // 5. Continue live — exactly `createSession` with the record's params.
    resume(ctx?: SessionContext) {
      return createClaudeSession({ ...ctx, cwd: ctx?.cwd ?? cwd ?? undefined, sessionParams: params });
    },
  };
}
