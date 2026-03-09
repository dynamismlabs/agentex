import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { TranscriptEntry } from "../types.js";

function escapeKey(sessionKey: string): string {
  return sessionKey.replace(/:/g, "--");
}

export class TranscriptWriter {
  private readonly sessionsDir: string;

  constructor(stateDir: string) {
    this.sessionsDir = path.join(stateDir, "sessions");
  }

  async append(sessionKey: string, entry: TranscriptEntry): Promise<void> {
    await fs.mkdir(this.sessionsDir, { recursive: true });
    const filePath = path.join(this.sessionsDir, `${escapeKey(sessionKey)}.jsonl`);
    const line = JSON.stringify(entry) + "\n";
    await fs.appendFile(filePath, line, "utf-8");
  }

  async read(sessionKey: string): Promise<TranscriptEntry[]> {
    const filePath = path.join(this.sessionsDir, `${escapeKey(sessionKey)}.jsonl`);
    try {
      const raw = await fs.readFile(filePath, "utf-8");
      return raw
        .split("\n")
        .filter((line) => line.trim() !== "")
        .map((line) => JSON.parse(line) as TranscriptEntry);
    } catch (err: unknown) {
      if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }
      throw err;
    }
  }
}
