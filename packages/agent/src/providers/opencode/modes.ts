import type { AgentMode, ListModesOptions } from "../../types.js";
import { acquireOpenCodeRuntime } from "./runtime.js";
import { fetchV2Agents, rec, serverApiVersion } from "./v2.js";

export async function listOpenCodeModes(options: ListModesOptions = {}): Promise<AgentMode[]> {
  const runtime = await acquireOpenCodeRuntime(options);
  try {
    const isV2 = serverApiVersion(runtime.server) === 2;
    const items = isV2
      ? await fetchV2Agents(runtime.server.client)
      : await (async () => {
          const payload = await runtime.server.client.json<unknown>("/agent");
          return Array.isArray(payload) ? payload : [];
        })();
    return items.map((raw) => {
      const agent = rec(raw);
      const id = isV2
        ? (typeof agent["id"] === "string"
            ? agent["id"]
            : typeof agent["name"] === "string" ? agent["name"] : "")
        : (typeof agent["name"] === "string"
            ? agent["name"]
            : typeof agent["id"] === "string" ? agent["id"] : "");
      const mode = typeof agent["mode"] === "string" ? agent["mode"] : "primary";
      const hidden = agent["hidden"] === true;
      return {
        id,
        name: isV2
          ? (typeof agent["name"] === "string" ? agent["name"] : id)
          : (typeof agent["label"] === "string" ? agent["label"] : id),
        description: typeof agent["description"] === "string" ? agent["description"] : undefined,
        mode,
        hidden,
      };
    }).filter((agent) => agent.id && (!isV2 || !agent.hidden) && agent.mode !== "subagent")
      .map(({ mode: _mode, hidden: _hidden, ...agent }) => agent);
  } finally {
    runtime.server.release();
  }
}
