import type { AgentMode, ListModesOptions } from "../../types.js";
import { acquireOpenCodeRuntime } from "./runtime.js";

function rec(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export async function listOpenCodeModes(options: ListModesOptions = {}): Promise<AgentMode[]> {
  const runtime = await acquireOpenCodeRuntime(options);
  try {
    const payload = await runtime.server.client.json<unknown[]>("/agent");
    return (Array.isArray(payload) ? payload : []).map((raw) => {
      const agent = rec(raw);
      const id = typeof agent["name"] === "string"
        ? agent["name"]
        : typeof agent["id"] === "string" ? agent["id"] : "";
      const mode = typeof agent["mode"] === "string" ? agent["mode"] : "primary";
      return {
        id,
        name: typeof agent["label"] === "string" ? agent["label"] : id,
        description: typeof agent["description"] === "string" ? agent["description"] : undefined,
        mode,
      };
    }).filter((agent) => agent.id && agent.mode !== "subagent")
      .map(({ mode: _mode, ...agent }) => agent);
  } finally {
    runtime.server.release();
  }
}
