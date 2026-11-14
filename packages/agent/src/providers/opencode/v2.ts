import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type OpenCodeApiVersion = 1 | 2;

export function rec(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function serverApiVersion(server: { apiVersion?: OpenCodeApiVersion } | null | undefined): OpenCodeApiVersion {
  return server?.apiVersion === 2 ? 2 : 1;
}

export function v2DataArray(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  const data = rec(payload)["data"];
  return Array.isArray(data) ? data : [];
}

export function v2DataRecord(payload: unknown): Record<string, unknown> {
  const root = rec(payload);
  const data = root["data"];
  return data && typeof data === "object" && !Array.isArray(data)
    ? (data as Record<string, unknown>)
    : root;
}

export function v2ErrorMessage(raw: unknown): string {
  if (typeof raw === "string") return raw;
  const obj = rec(raw);
  if (typeof obj["message"] === "string") return obj["message"];
  if (typeof obj["error"] === "string") return obj["error"];
  return "";
}

export function v2ToolContentText(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  const parts: string[] = [];
  for (const item of content) {
    const entry = rec(item);
    if (entry["type"] === "text" && typeof entry["text"] === "string") {
      parts.push(entry["text"]);
    } else if (entry["type"] === "file") {
      const label = typeof entry["name"] === "string" && entry["name"]
        ? entry["name"]
        : typeof entry["uri"] === "string"
          ? entry["uri"]
          : "";
      if (label) parts.push(label);
    }
  }
  return parts.length > 0 ? parts.join("\n") : undefined;
}

export function normalizeV2ToolState(state: unknown): Record<string, unknown> {
  const raw = rec(state);
  const status = typeof raw["status"] === "string" ? raw["status"] : "running";
  const normalized: Record<string, unknown> = {
    status: status === "streaming" ? "running" : status,
  };
  if (raw["input"] !== undefined) {
    normalized["input"] = typeof raw["input"] === "string" ? { raw: raw["input"] } : raw["input"];
  }
  if (raw["metadata"] !== undefined) {
    normalized["metadata"] = raw["metadata"];
  }
  const output = v2ToolContentText(raw["content"]);
  if (output !== undefined) {
    normalized["output"] = output;
  }
  const errText = v2ErrorMessage(raw["error"]);
  if (errText) {
    normalized["error"] = errText;
  }
  return normalized;
}

export function normalizeV2MessageToEnvelope(
  raw: unknown,
): { info: Record<string, unknown>; parts: Record<string, unknown>[] } | null {
  const msg = rec(raw);
  const msgType = typeof msg["type"] === "string" ? msg["type"] : undefined;

  // Allow already-enveloped v1 payloads to pass through untouched.
  if (!msgType && msg["info"] && Array.isArray(msg["parts"])) {
    return {
      info: rec(msg["info"]),
      parts: (msg["parts"] as unknown[]).map((p) => rec(p)),
    };
  }

  if (msgType === "user") {
    const msgId = typeof msg["id"] === "string" ? msg["id"] : "user";
    const text = typeof msg["text"] === "string" ? msg["text"] : "";
    return {
      info: {
        id: msg["id"],
        role: "user",
        time: msg["time"],
      },
      parts: text ? [{ id: `${msgId}:part:0`, messageID: msgId, type: "text", text }] : [],
    };
  }

  if (msgType !== "assistant") {
    return null;
  }

  const rawModel = rec(msg["model"]);
  const rawTokens = rec(msg["tokens"]);
  const rawCache = rec(rawTokens["cache"]);
  const info: Record<string, unknown> = {
    id: msg["id"],
    role: "assistant",
    time: msg["time"],
    agent: msg["agent"],
    ...(typeof rawModel["id"] === "string" ? { modelID: rawModel["id"] } : {}),
    ...(typeof rawModel["providerID"] === "string" ? { providerID: rawModel["providerID"] } : {}),
    ...(typeof msg["finish"] === "string" ? { finish: msg["finish"] } : {}),
    ...(typeof msg["cost"] === "number" ? { cost: msg["cost"] } : {}),
    ...(Object.keys(rawTokens).length > 0
      ? {
          tokens: {
            input: typeof rawTokens["input"] === "number" ? rawTokens["input"] : 0,
            output: typeof rawTokens["output"] === "number" ? rawTokens["output"] : 0,
            reasoning: typeof rawTokens["reasoning"] === "number" ? rawTokens["reasoning"] : 0,
            cache: {
              read: typeof rawCache["read"] === "number" ? rawCache["read"] : 0,
              write: typeof rawCache["write"] === "number" ? rawCache["write"] : 0,
            },
          },
        }
      : {}),
    ...(msg["error"] !== undefined ? { error: msg["error"] } : {}),
  };

  const msgId = typeof msg["id"] === "string" ? msg["id"] : "assistant";
  const parts: Record<string, unknown>[] = [];
  const content = Array.isArray(msg["content"]) ? msg["content"] : [];
  for (let i = 0; i < content.length; i += 1) {
    const entry = rec(content[i]);
    const kind = entry["type"];
    const fallbackPartId = `${msgId}:part:${i}`;
    if (kind === "text" && typeof entry["text"] === "string") {
      parts.push({ id: fallbackPartId, messageID: msgId, type: "text", text: entry["text"] });
    } else if (kind === "reasoning" && typeof entry["text"] === "string") {
      parts.push({ id: fallbackPartId, messageID: msgId, type: "reasoning", text: entry["text"] });
    } else if (kind === "tool") {
      const id = typeof entry["id"] === "string" && entry["id"] ? entry["id"] : fallbackPartId;
      const name = typeof entry["name"] === "string" ? entry["name"] : "tool";
      parts.push({
        type: "tool",
        id,
        callID: id,
        messageID: msgId,
        tool: name,
        state: normalizeV2ToolState(entry["state"]),
      });
    }
  }

  return { info, parts };
}

export function isV2AbortedError(rawError: unknown): boolean {
  const err = rec(rawError);
  const name = err["name"];
  const type = err["type"];
  return name === "MessageAbortedError" || type === "aborted" || type === "interrupted";
}

const DEFAULT_AGENT_WARMUP_DELAYS_MS = [50, 100, 150, 250, 400, 500, 500, 500];

/**
 * Fetch registered v2 agents, retrying briefly when a newly booted server
 * still returns an empty list before built-in plugins finish registering.
 */
export async function fetchV2Agents(
  client: { json<T>(path: string): Promise<T> },
  delaysMs: readonly number[] = DEFAULT_AGENT_WARMUP_DELAYS_MS,
): Promise<unknown[]> {
  let items = v2DataArray(await client.json<unknown>("/api/agent"));
  for (const delay of delaysMs) {
    if (items.length > 0) break;
    await new Promise((resolve) => setTimeout(resolve, delay));
    items = v2DataArray(await client.json<unknown>("/api/agent"));
  }
  return items;
}

const v2BinaryCache = new Map<string, { fingerprint: string; promise: Promise<boolean> }>();

export function parseMajorVersion(output: string): number | null {
  const match = output.match(/\bv?(\d+)\.\d+\.\d+\b/) ?? output.match(/\bv?(\d+)\.\d+\b/);
  if (!match) return null;
  const major = Number.parseInt(match[1] ?? "", 10);
  return Number.isFinite(major) ? major : null;
}

async function probeBinaryVersion(command: string, prefixArgs: string[]): Promise<boolean | null> {
  try {
    const { stdout, stderr } = await execFileAsync(command, [...prefixArgs, "--version"], { timeout: 3000 });
    const major = parseMajorVersion(`${stdout}\n${stderr}`);
    return major === null ? null : major >= 2;
  } catch {
    return null;
  }
}

export async function isOpenCodeV2Binary(command: string, prefixArgs: string[] = []): Promise<boolean> {
  const cacheKey = `${command}\0${prefixArgs.join("\0")}`;
  let fingerprint: string | null = null;
  try {
    const st = await stat(command);
    fingerprint = `${st.mtimeMs}:${st.size}`;
  } catch {
    // Non-path commands (resolved via PATH) cannot be fingerprinted reliably.
    v2BinaryCache.delete(cacheKey);
    return (await probeBinaryVersion(command, prefixArgs)) ?? false;
  }

  const cached = v2BinaryCache.get(cacheKey);
  if (cached && cached.fingerprint === fingerprint) return cached.promise;

  const entry: { fingerprint: string; promise: Promise<boolean> } = {
    fingerprint,
    promise: Promise.resolve(false),
  };
  entry.promise = (async () => {
    const result = await probeBinaryVersion(command, prefixArgs);
    if (result === null) {
      if (v2BinaryCache.get(cacheKey) === entry) v2BinaryCache.delete(cacheKey);
      return false;
    }
    return result;
  })();

  v2BinaryCache.set(cacheKey, entry);
  return entry.promise;
}
