import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as os from "node:os";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { scanCodexSessionUsage } from "../../../src/providers/codex/usage-scanner.js";

describe("scanCodexSessionUsage", () => {
  let tmpDir: string;
  let originalCodexHome: string | undefined;

  /** Build the date-partitioned directory path for a given Date. */
  function sessionDir(date: Date): string {
    const year = String(date.getFullYear());
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return path.join(tmpDir, "sessions", year, month, day);
  }

  /** Write a JSONL file with the given lines into the session dir for the date. */
  async function writeLogFile(
    date: Date,
    filename: string,
    lines: string[],
  ): Promise<string> {
    const dir = sessionDir(date);
    await fs.mkdir(dir, { recursive: true });
    const filePath = path.join(dir, filename);
    await fs.writeFile(filePath, lines.join("\n") + "\n", "utf-8");
    return filePath;
  }

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-usage-test-"));
    originalCodexHome = process.env["CODEX_HOME"];
    process.env["CODEX_HOME"] = tmpDir;
  });

  afterEach(async () => {
    if (originalCodexHome === undefined) {
      delete process.env["CODEX_HOME"];
    } else {
      process.env["CODEX_HOME"] = originalCodexHome;
    }
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("returns aggregated usage for matching token_count events", async () => {
    const now = new Date();

    await writeLogFile(now, "session1.jsonl", [
      JSON.stringify({
        type: "token_count",
        timestamp: now.toISOString(),
        model: "gpt-4o",
        InputTokens: 100,
        OutputTokens: 50,
        CacheReadInputTokens: 10,
        CachedInputTokens: 5,
      }),
      JSON.stringify({
        type: "token_count",
        timestamp: now.toISOString(),
        model: "gpt-4o",
        InputTokens: 200,
        OutputTokens: 80,
        CacheReadInputTokens: 20,
        CachedInputTokens: 15,
      }),
    ]);

    const result = await scanCodexSessionUsage({
      startedAfter: new Date(now.getTime() - 60_000),
    });

    expect(result).toBeDefined();
    expect(result!["gpt-4o"]).toBeDefined();
    expect(result!["gpt-4o"]!.inputTokens).toBe(300);
    expect(result!["gpt-4o"]!.outputTokens).toBe(130);
    expect(result!["gpt-4o"]!.cachedInputTokens).toBe(30);
    expect(result!["gpt-4o"]!.cacheCreationInputTokens).toBe(20);
  });

  it("filters by startedAfter timestamp correctly", async () => {
    const now = new Date();
    const oneHourAgo = new Date(now.getTime() - 3_600_000);
    const twoHoursAgo = new Date(now.getTime() - 7_200_000);

    await writeLogFile(now, "session2.jsonl", [
      // This event is older than the filter
      JSON.stringify({
        type: "token_count",
        timestamp: twoHoursAgo.toISOString(),
        model: "gpt-4o",
        InputTokens: 1000,
        OutputTokens: 500,
      }),
      // This event is newer than the filter
      JSON.stringify({
        type: "token_count",
        timestamp: now.toISOString(),
        model: "gpt-4o",
        InputTokens: 50,
        OutputTokens: 25,
      }),
    ]);

    const result = await scanCodexSessionUsage({
      startedAfter: oneHourAgo,
    });

    expect(result).toBeDefined();
    expect(result!["gpt-4o"]!.inputTokens).toBe(50);
    expect(result!["gpt-4o"]!.outputTokens).toBe(25);
  });

  it("filters by threadId correctly", async () => {
    const now = new Date();

    await writeLogFile(now, "session3.jsonl", [
      JSON.stringify({
        type: "token_count",
        timestamp: now.toISOString(),
        model: "gpt-4o",
        thread_id: "thread-A",
        InputTokens: 100,
        OutputTokens: 50,
      }),
      JSON.stringify({
        type: "token_count",
        timestamp: now.toISOString(),
        model: "gpt-4o",
        thread_id: "thread-B",
        InputTokens: 200,
        OutputTokens: 80,
      }),
    ]);

    const result = await scanCodexSessionUsage({
      startedAfter: new Date(now.getTime() - 60_000),
      threadId: "thread-A",
    });

    expect(result).toBeDefined();
    expect(result!["gpt-4o"]!.inputTokens).toBe(100);
    expect(result!["gpt-4o"]!.outputTokens).toBe(50);
  });

  it("returns undefined when no matching log files found", async () => {
    // No files written at all
    const result = await scanCodexSessionUsage({
      startedAfter: new Date(),
    });

    expect(result).toBeUndefined();
  });

  it("returns undefined for empty log files", async () => {
    const now = new Date();
    const dir = sessionDir(now);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "empty.jsonl"), "", "utf-8");

    const result = await scanCodexSessionUsage({
      startedAfter: new Date(now.getTime() - 60_000),
    });

    expect(result).toBeUndefined();
  });

  it("handles malformed JSONL lines gracefully", async () => {
    const now = new Date();

    await writeLogFile(now, "session4.jsonl", [
      "this is not json",
      "{bad json: true,,,}",
      "null",
      "[]",
      JSON.stringify({
        type: "token_count",
        timestamp: now.toISOString(),
        model: "gpt-4o",
        InputTokens: 42,
        OutputTokens: 13,
      }),
    ]);

    const result = await scanCodexSessionUsage({
      startedAfter: new Date(now.getTime() - 60_000),
    });

    // Should still pick up the valid event despite malformed lines
    expect(result).toBeDefined();
    expect(result!["gpt-4o"]!.inputTokens).toBe(42);
    expect(result!["gpt-4o"]!.outputTokens).toBe(13);
  });

  it("aggregates usage across multiple models", async () => {
    const now = new Date();

    await writeLogFile(now, "session5.jsonl", [
      JSON.stringify({
        type: "token_count",
        timestamp: now.toISOString(),
        model: "gpt-4o",
        InputTokens: 100,
        OutputTokens: 50,
      }),
      JSON.stringify({
        type: "token_count",
        timestamp: now.toISOString(),
        model: "o3-mini",
        InputTokens: 300,
        OutputTokens: 150,
      }),
    ]);

    const result = await scanCodexSessionUsage({
      startedAfter: new Date(now.getTime() - 60_000),
    });

    expect(result).toBeDefined();
    expect(result!["gpt-4o"]!.inputTokens).toBe(100);
    expect(result!["o3-mini"]!.inputTokens).toBe(300);
  });

  it("ignores non-token_count event types", async () => {
    const now = new Date();

    await writeLogFile(now, "session6.jsonl", [
      JSON.stringify({
        type: "message",
        timestamp: now.toISOString(),
        model: "gpt-4o",
        InputTokens: 9999,
        OutputTokens: 9999,
      }),
      JSON.stringify({
        type: "token_count",
        timestamp: now.toISOString(),
        model: "gpt-4o",
        InputTokens: 10,
        OutputTokens: 5,
      }),
    ]);

    const result = await scanCodexSessionUsage({
      startedAfter: new Date(now.getTime() - 60_000),
    });

    expect(result).toBeDefined();
    expect(result!["gpt-4o"]!.inputTokens).toBe(10);
    expect(result!["gpt-4o"]!.outputTokens).toBe(5);
  });
});
