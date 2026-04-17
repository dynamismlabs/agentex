import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import * as readline from "node:readline";
import { createReadStream } from "node:fs";
import type { TokenUsage } from "../../types.js";

// ---------------------------------------------------------------------------
// Log path resolution
// ---------------------------------------------------------------------------

function getCodexHome(): string {
  return process.env["CODEX_HOME"] || path.join(os.homedir(), ".codex");
}

/**
 * Find session log files that may contain usage data for a given time range.
 * Codex stores logs at: `CODEX_HOME/sessions/YYYY/MM/DD/*.jsonl`
 */
async function findLogFiles(startedAfter: Date): Promise<string[]> {
  const sessionsDir = path.join(getCodexHome(), "sessions");
  const files: string[] = [];

  // Walk date-partitioned directories starting from the startedAfter date
  const startDate = new Date(startedAfter);
  const now = new Date();

  for (let d = new Date(startDate); d <= now; d.setDate(d.getDate() + 1)) {
    const year = String(d.getFullYear());
    const month = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    const dayDir = path.join(sessionsDir, year, month, day);

    try {
      const entries = await fs.readdir(dayDir);
      for (const entry of entries) {
        if (entry.endsWith(".jsonl")) {
          files.push(path.join(dayDir, entry));
        }
      }
    } catch {
      // Directory doesn't exist — skip
    }
  }

  return files;
}

// ---------------------------------------------------------------------------
// JSONL scanning
// ---------------------------------------------------------------------------

interface ScanOptions {
  /** Only include events after this timestamp */
  startedAfter: Date;
  /** Optional thread ID to filter by */
  threadId?: string;
}

/**
 * Scan Codex session log files for token usage events and aggregate them.
 *
 * Codex logs `token_count` events in session JSONL files with fields like
 * `InputTokens`, `OutputTokens`, `CachedInputTokens`, `CacheReadInputTokens`.
 *
 * Returns aggregated usage keyed by model name, or null if no usage found.
 */
export async function scanCodexSessionUsage(
  options: ScanOptions,
): Promise<Record<string, TokenUsage> | undefined> {
  const logFiles = await findLogFiles(options.startedAfter);
  if (logFiles.length === 0) return undefined;

  const usageByModel = new Map<string, {
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens: number;
    cacheCreationInputTokens: number;
  }>();

  for (const file of logFiles) {
    await scanFile(file, options, usageByModel);
  }

  if (usageByModel.size === 0) return undefined;

  const result: Record<string, TokenUsage> = {};
  for (const [model, usage] of usageByModel) {
    const entry: TokenUsage = {
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
    };
    if (usage.cachedInputTokens > 0) entry.cachedInputTokens = usage.cachedInputTokens;
    if (usage.cacheCreationInputTokens > 0) entry.cacheCreationInputTokens = usage.cacheCreationInputTokens;
    result[model] = entry;
  }
  return result;
}

async function scanFile(
  filePath: string,
  options: ScanOptions,
  usageByModel: Map<string, { inputTokens: number; outputTokens: number; cachedInputTokens: number; cacheCreationInputTokens: number }>,
): Promise<void> {
  let stream: ReturnType<typeof createReadStream>;
  try {
    stream = createReadStream(filePath, { encoding: "utf-8" });
  } catch {
    return;
  }

  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  try {
    for await (const line of rl) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(trimmed);
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) continue;
      } catch {
        continue;
      }

      const type = typeof parsed["type"] === "string" ? parsed["type"] : "";
      if (type !== "token_count") continue;

      // Check timestamp
      const ts = typeof parsed["timestamp"] === "string" ? parsed["timestamp"]
        : typeof parsed["created_at"] === "string" ? parsed["created_at"]
        : null;
      if (ts) {
        const eventTime = new Date(ts);
        if (eventTime < options.startedAfter) continue;
      }

      // Check thread ID filter
      if (options.threadId) {
        const eventThreadId = typeof parsed["thread_id"] === "string" ? parsed["thread_id"]
          : typeof parsed["threadId"] === "string" ? parsed["threadId"]
          : null;
        if (eventThreadId && eventThreadId !== options.threadId) continue;
      }

      // Extract usage
      const model = typeof parsed["model"] === "string" ? parsed["model"] : "unknown";
      const inputTokens = typeof parsed["InputTokens"] === "number" ? parsed["InputTokens"]
        : typeof parsed["input_tokens"] === "number" ? parsed["input_tokens"]
        : 0;
      const outputTokens = typeof parsed["OutputTokens"] === "number" ? parsed["OutputTokens"]
        : typeof parsed["output_tokens"] === "number" ? parsed["output_tokens"]
        : 0;
      const cachedInputTokens = typeof parsed["CacheReadInputTokens"] === "number" ? parsed["CacheReadInputTokens"]
        : typeof parsed["cached_input_tokens"] === "number" ? parsed["cached_input_tokens"]
        : 0;
      const cacheCreationInputTokens = typeof parsed["CachedInputTokens"] === "number" ? parsed["CachedInputTokens"]
        : typeof parsed["cache_creation_input_tokens"] === "number" ? parsed["cache_creation_input_tokens"]
        : 0;

      const existing = usageByModel.get(model) ?? {
        inputTokens: 0,
        outputTokens: 0,
        cachedInputTokens: 0,
        cacheCreationInputTokens: 0,
      };
      existing.inputTokens += inputTokens;
      existing.outputTokens += outputTokens;
      existing.cachedInputTokens += cachedInputTokens;
      existing.cacheCreationInputTokens += cacheCreationInputTokens;
      usageByModel.set(model, existing);
    }
  } finally {
    rl.close();
    stream.destroy();
  }
}
