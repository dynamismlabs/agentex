import type { SessionCodec } from "../../types.js";

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function parseAsObject(raw: unknown): Record<string, unknown> | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  return raw as Record<string, unknown>;
}

export const geminiSessionCodec: SessionCodec = {
  deserialize(raw: unknown): Record<string, unknown> | null {
    const obj = parseAsObject(raw);
    if (!obj) return null;
    const sessionId =
      readNonEmptyString(obj["sessionId"]) ??
      readNonEmptyString(obj["session_id"]) ??
      readNonEmptyString(obj["checkpoint_id"]);
    if (!sessionId) return null;
    const cwd = readNonEmptyString(obj["cwd"]);
    return {
      sessionId,
      ...(cwd ? { cwd } : {}),
    };
  },

  serialize(params: Record<string, unknown> | null): Record<string, unknown> | null {
    if (!params) return null;
    const sessionId =
      readNonEmptyString(params["sessionId"]) ??
      readNonEmptyString(params["session_id"]) ??
      readNonEmptyString(params["checkpoint_id"]);
    if (!sessionId) return null;
    const cwd = readNonEmptyString(params["cwd"]);
    return {
      sessionId,
      ...(cwd ? { cwd } : {}),
    };
  },

  getDisplayId(params: Record<string, unknown> | null): string | null {
    if (!params) return null;
    return (
      readNonEmptyString(params["sessionId"]) ??
      readNonEmptyString(params["session_id"]) ??
      readNonEmptyString(params["checkpoint_id"])
    );
  },
};
