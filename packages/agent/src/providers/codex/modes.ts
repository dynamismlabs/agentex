import { spawn } from "node:child_process";
import type { AgentMode, ListModesOptions } from "../../types.js";
import { findBinary } from "../../utils/binary.js";
import { buildEnv, ensurePathInEnv } from "../../utils/env.js";

/**
 * A raw Codex "collaboration mode" entry as returned by the app-server's
 * `collaborationMode/list` RPC. Codex's collaboration modes (e.g. Auto, Plan,
 * Read Only) are the cross-provider equivalent of agentex `AgentMode`s.
 */
export interface CodexCollaborationMode {
  name: string;
  mode: string | null;
  model: string | null;
  reasoning_effort: string | null;
  developer_instructions: string | null;
}

/** Parse a `collaborationMode/list` response into raw entries (tolerant of
 *  missing fields; drops entries without a name). */
export function parseCollaborationModes(response: unknown): CodexCollaborationMode[] {
  const data =
    response && typeof response === "object" && Array.isArray((response as Record<string, unknown>)["data"])
      ? ((response as Record<string, unknown>)["data"] as unknown[])
      : [];
  const out: CodexCollaborationMode[] = [];
  for (const entry of data) {
    if (typeof entry !== "object" || entry === null) continue;
    const r = entry as Record<string, unknown>;
    const name = typeof r["name"] === "string" ? r["name"] : "";
    if (!name) continue;
    out.push({
      name,
      mode: typeof r["mode"] === "string" ? r["mode"] : null,
      model: typeof r["model"] === "string" ? r["model"] : null,
      reasoning_effort: typeof r["reasoning_effort"] === "string" ? r["reasoning_effort"] : null,
      developer_instructions:
        typeof r["developer_instructions"] === "string" ? r["developer_instructions"] : null,
    });
  }
  return out;
}

/** Convert raw collaboration modes into the cross-provider `AgentMode` shape.
 *  `id` is the mode string (the value passed back via `config.modeId`); falls
 *  back to the name when codex doesn't supply a distinct mode value. */
export function toAgentModes(modes: CodexCollaborationMode[]): AgentMode[] {
  return modes.map((m) => ({
    id: m.mode ?? m.name,
    name: m.name,
    ...(m.developer_instructions ? { description: m.developer_instructions } : {}),
  }));
}

/** Build the `thread/start` / `thread/resume` `collaborationMode` parameter for
 *  a chosen mode id, mirroring the shape codex's app-server expects. Returns
 *  null when the id doesn't match any known mode. */
export function resolveCollaborationModeParam(
  modes: CodexCollaborationMode[],
  modeId: string,
): { mode: string; settings: Record<string, unknown> } | null {
  const match = modes.find((m) => m.mode === modeId) ?? modes.find((m) => m.name === modeId);
  if (!match) return null;
  const settings: Record<string, unknown> = {};
  if (match.model) settings["model"] = match.model;
  if (match.reasoning_effort) settings["reasoning_effort"] = match.reasoning_effort;
  if (match.developer_instructions) settings["developer_instructions"] = match.developer_instructions;
  return { mode: match.mode ?? match.name, settings };
}

/**
 * Minimal one-shot JSON-RPC over a child's stdio: send `initialize`, then the
 * `target` method, resolve with the target's result, and tear the process down.
 * Used by `listCodexModes` so callers can discover modes without opening a full
 * session.
 */
function oneShotRpc(
  proc: ReturnType<typeof spawn>,
  target: string,
  timeoutMs: number,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    if (!proc.stdin || !proc.stdout) {
      reject(new Error("codex app-server stdio unavailable"));
      return;
    }
    let buffer = "";
    let settled = false;
    const initId = 1;
    const targetId = 2;

    const timer = setTimeout(() => finish(new Error(`codex ${target} timed out`)), timeoutMs);

    function finish(err: Error | null, value?: unknown): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { proc.kill(); } catch { /* ignore */ }
      if (err) reject(err);
      else resolve(value);
    }

    proc.stdout.setEncoding("utf-8");
    proc.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let msg: Record<string, unknown>;
        try { msg = JSON.parse(trimmed) as Record<string, unknown>; } catch { continue; }
        if (msg["id"] === initId && !("method" in msg)) {
          // initialize acknowledged → request the target.
          proc.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id: targetId, method: target, params: {} }) + "\n");
        } else if (msg["id"] === targetId && !("method" in msg)) {
          if (msg["error"]) {
            const e = msg["error"] as { message?: string };
            finish(new Error(`codex ${target} error: ${e.message ?? "unknown"}`));
          } else {
            finish(null, msg["result"] ?? {});
          }
        }
      }
    });
    proc.on("error", (err) => finish(err instanceof Error ? err : new Error(String(err))));
    proc.on("exit", (code) => {
      if (!settled) finish(new Error(`codex app-server exited (code=${code}) before responding`));
    });

    proc.stdin.write(
      JSON.stringify({ jsonrpc: "2.0", id: initId, method: "initialize", params: { clientInfo: { name: "agentex", version: "1.0.0" }, capabilities: {} } }) + "\n",
    );
  });
}

/**
 * Discover Codex's collaboration modes by spawning a throwaway `codex
 * app-server`, running the initialize handshake, requesting
 * `collaborationMode/list`, and closing. Returns [] on any failure (modes are
 * advisory — a discovery failure shouldn't surface as a hard error).
 */
export async function listCodexModes(options?: ListModesOptions): Promise<AgentMode[]> {
  const config = options?.config ?? {};
  const resolved = await findBinary("codex", config.command);
  const env = buildEnv(options?.env);
  ensurePathInEnv(env);
  const proc = spawn(resolved.bin, [...resolved.prefixArgs, "app-server"], {
    cwd: options?.cwd ?? process.cwd(),
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  try {
    const response = await oneShotRpc(proc, "collaborationMode/list", config.timeoutSec ? config.timeoutSec * 1000 : 15_000);
    return toAgentModes(parseCollaborationModes(response));
  } catch {
    return [];
  }
}
