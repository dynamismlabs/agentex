import type {
  HistoryAttachment,
  HistoryCatchUpOptions,
  HistoryCheckpoint,
  SessionAttachment,
} from "../types.js";

interface FileCheckpointValue {
  offset: number;
  eventId?: string;
}

function decodeCheckpoint(
  checkpoint: HistoryCheckpoint | undefined,
  kind: string,
): FileCheckpointValue | undefined {
  if (!checkpoint) return undefined;
  if (checkpoint.kind !== kind) {
    throw new Error(`history checkpoint kind must be ${kind}`);
  }
  const value = checkpoint.value;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("history checkpoint value must be an object");
  }
  const offset = (value as Record<string, unknown>)["offset"];
  const eventId = (value as Record<string, unknown>)["eventId"];
  if (typeof offset !== "number" || !Number.isSafeInteger(offset) || offset < 0) {
    throw new Error("history checkpoint offset must be a non-negative safe integer");
  }
  if (eventId !== undefined && typeof eventId !== "string") {
    throw new Error("history checkpoint eventId must be a string");
  }
  return { offset, ...(eventId ? { eventId } : {}) };
}

/** Adapt the legacy byte-offset transcript contract to the additive history API. */
export function historyFromSessionAttachment(
  providerType: string,
  attachment: SessionAttachment,
): HistoryAttachment {
  const checkpointKind = `${providerType}:byte-offset:v1`;
  return {
    record: attachment.record,
    historySource: attachment.transcript
      ? { kind: "file", path: attachment.transcript.filePath }
      : null,
    lastTurn: attachment.lastTurn,
    catchUp(options?: HistoryCatchUpOptions) {
      if (options?.mode === "bounded_full_resync") {
        options = { ...options, after: undefined };
      }
      const decoded = decodeCheckpoint(options?.after, checkpointKind);
      return {
        async *[Symbol.asyncIterator]() {
          for await (const yielded of attachment.catchUp({
            ...(decoded ? { fromOffset: decoded.offset } : {}),
            ...(decoded?.eventId ? { sinceEventId: decoded.eventId } : {}),
          })) {
            yield {
              event: yielded.event,
              eventId: yielded.eventId,
              checkpoint: {
                kind: checkpointKind,
                value: {
                  offset: yielded.offset,
                  ...(yielded.eventId ? { eventId: yielded.eventId } : {}),
                },
              },
            };
          }
        },
      };
    },
    resume: (ctx) => attachment.resume(ctx),
  };
}
