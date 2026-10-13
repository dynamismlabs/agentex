import { open } from "node:fs/promises";
import { normalizeTitle, throwIfTitleAborted, type NativeTitleOptions } from "../../titles.js";
import { getClaudeTranscriptPath } from "./transcript.js";

/** Like the native SDK session metadata reader, bound reads to the head and tail. */
export async function readClaudeTitle(
  sessionId: string, cwd: string, claudeHome?: string, options: NativeTitleOptions = {},
): Promise<string | null> {
  throwIfTitleAborted(options.signal);
  const { filePath } = await getClaudeTranscriptPath({ sessionId, cwd, claudeHome });
  let file;
  try { file = await open(filePath, "r"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  try {
    const { size } = await file.stat();
    const limit = 64 * 1024;
    let custom: string | null = null;
    let generated: string | null = null;
    const positions = size <= limit ? [0] : [0, Math.max(limit, size - limit)];
    for (const position of positions) {
      const buffer = Buffer.alloc(Math.min(limit, size - position));
      const { bytesRead } = await file.read(buffer, 0, buffer.length, position);
      for (const line of buffer.subarray(0, bytesRead).toString("utf8").split("\n")) {
        let entry: Record<string, unknown>;
        try { entry = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
        if (entry.sessionId !== undefined && entry.sessionId !== sessionId) continue;
        if (entry.type === "custom-title") custom = normalizeTitle(entry.customTitle);
        if (entry.type === "ai-title") generated = normalizeTitle(entry.aiTitle);
      }
    }
    throwIfTitleAborted(options.signal);
    return custom ?? generated;
  } finally { await file.close(); }
}
