import type { SessionCodec } from "../../types.js";

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function parseAsObject(raw: unknown): Record<string, unknown> | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  return raw as Record<string, unknown>;
}

export const openclawSessionCodec: SessionCodec = {
  deserialize(raw: unknown): Record<string, unknown> | null {
    const obj = parseAsObject(raw);
    if (!obj) return null;
    const sessionKey = readNonEmptyString(obj["sessionKey"]) ?? readNonEmptyString(obj["session_key"]);
    if (!sessionKey) return null;
    const gatewayUrl = readNonEmptyString(obj["gatewayUrl"]) ?? readNonEmptyString(obj["gateway_url"]);
    return {
      sessionKey,
      ...(gatewayUrl ? { gatewayUrl } : {}),
    };
  },

  serialize(params: Record<string, unknown> | null): Record<string, unknown> | null {
    if (!params) return null;
    const sessionKey = readNonEmptyString(params["sessionKey"]) ?? readNonEmptyString(params["session_key"]);
    if (!sessionKey) return null;
    const gatewayUrl = readNonEmptyString(params["gatewayUrl"]);
    return {
      sessionKey,
      ...(gatewayUrl ? { gatewayUrl } : {}),
    };
  },

  getDisplayId(params: Record<string, unknown> | null): string | null {
    if (!params) return null;
    return readNonEmptyString(params["sessionKey"]) ?? readNonEmptyString(params["session_key"]);
  },
};
