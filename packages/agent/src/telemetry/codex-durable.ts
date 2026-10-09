import { getCodexTranscriptPath, readCodexTranscript } from "../providers/codex/transcript.js";
import { codexLineToStreamEvents } from "../providers/codex/transcript-normalize.js";
import type { StreamEvent } from "../types.js";
import { getRuntimeHomeEnvVar } from "../utils/runtime-homes.js";

/** Read only this session's native durable observations; never scan other sessions' accounting. */
export async function readLatestCodexTelemetry(sessionId: string, env?: Record<string, string>): Promise<StreamEvent[]> {
  const homeVar = getRuntimeHomeEnvVar("codex");
  const codexHome = homeVar ? env?.[homeVar] ?? process.env[homeVar] : undefined;
  const found = await getCodexTranscriptPath({ sessionId, ...(codexHome ? { codexHome } : {}) });
  if (!found) return [];
  // Context and pool updates can occur on different rows. Retain the latest
  // context and all partial rate observations rather than just the last row.
  const events: StreamEvent[] = [];
  let context: StreamEvent | undefined;
  for await (const { event: line } of readCodexTranscript({ filePath: found.filePath })) {
    for (const event of codexLineToStreamEvents(line, { sessionId })) {
      if (event.type === "context_usage") context = event;
      else if (event.type === "rate_limits") events.push(event);
    }
  }
  if (context) events.push(context);
  return events;
}
