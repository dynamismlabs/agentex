import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { SessionEntry } from "../types.js";

export class SessionStore {
  private readonly filePath: string;
  private entries: Map<string, SessionEntry> = new Map();

  constructor(stateDir: string) {
    this.filePath = path.join(stateDir, "sessions.json");
  }

  get(key: string): SessionEntry | undefined {
    return this.entries.get(key);
  }

  set(key: string, entry: SessionEntry): void {
    this.entries.set(key, entry);
  }

  getAll(): SessionEntry[] {
    return Array.from(this.entries.values());
  }

  delete(key: string): void {
    this.entries.delete(key);
  }

  async load(): Promise<void> {
    try {
      const raw = await fs.readFile(this.filePath, "utf-8");
      const parsed: Record<string, SessionEntry> = JSON.parse(raw);
      this.entries = new Map(Object.entries(parsed));
    } catch (err: unknown) {
      if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") {
        this.entries = new Map();
        return;
      }
      throw err;
    }
  }

  async persist(): Promise<void> {
    const dir = path.dirname(this.filePath);
    await fs.mkdir(dir, { recursive: true });

    const obj: Record<string, SessionEntry> = Object.fromEntries(this.entries);
    const data = JSON.stringify(obj, null, 2);
    const tmpPath = this.filePath + ".tmp";

    await fs.writeFile(tmpPath, data, "utf-8");
    await fs.rename(tmpPath, this.filePath);
  }
}
