import type { SessionCodec } from "../../types.js";

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function readSessionId(obj: Record<string, unknown>): string | null {
  return readNonEmptyString(obj["sessionId"])
    ?? readNonEmptyString(obj["session_id"])
    ?? readNonEmptyString(obj["conversationId"]);
}

function normalize(raw: unknown): Record<string, unknown> | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  const sessionId = readSessionId(obj);
  if (!sessionId) return null;
  const cwd = readNonEmptyString(obj["cwd"]);
  return { sessionId, ...(cwd ? { cwd } : {}) };
}

/** Antigravity session params: the conversation id plus the directory it is scoped to. */
export const antigravitySessionCodec: SessionCodec = {
  deserialize: normalize,
  serialize: (params) => normalize(params),
  getDisplayId(params) {
    return params ? readSessionId(params) : null;
  },
};
