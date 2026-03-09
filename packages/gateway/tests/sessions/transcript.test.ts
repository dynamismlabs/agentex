import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { TranscriptWriter } from "../../src/sessions/transcript.js";
import type { TranscriptEntry } from "../../src/types.js";

function makeTranscript(
  role: TranscriptEntry["role"],
  text: string,
): TranscriptEntry {
  return {
    role,
    text,
    channel: "test",
    senderId: "u1",
    ts: Date.now(),
  };
}

describe("TranscriptWriter", () => {
  let tmpDir: string;

  afterEach(async () => {
    if (tmpDir) {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  async function makeTmpDir(): Promise<string> {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "transcript-test-"));
    return tmpDir;
  }

  it("append and read roundtrip", async () => {
    const dir = await makeTmpDir();
    const writer = new TranscriptWriter(dir);

    const entry = makeTranscript("user", "Hello");
    await writer.append("sess1", entry);

    const entries = await writer.read("sess1");
    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual(entry);
  });

  it("appends multiple entries", async () => {
    const dir = await makeTmpDir();
    const writer = new TranscriptWriter(dir);

    const e1 = makeTranscript("user", "Hi");
    const e2 = makeTranscript("assistant", "Hello!");
    const e3 = makeTranscript("user", "How are you?");

    await writer.append("multi", e1);
    await writer.append("multi", e2);
    await writer.append("multi", e3);

    const entries = await writer.read("multi");
    expect(entries).toHaveLength(3);
    expect(entries[0]).toEqual(e1);
    expect(entries[1]).toEqual(e2);
    expect(entries[2]).toEqual(e3);
  });

  it("escapes colons in session key for filesystem safety", async () => {
    const dir = await makeTmpDir();
    const writer = new TranscriptWriter(dir);

    const entry = makeTranscript("system", "init");
    await writer.append("ch:user:123", entry);

    // Verify the file uses escaped name
    const files = await fs.readdir(path.join(dir, "sessions"));
    expect(files).toContain("ch--user--123.jsonl");

    // Verify we can read it back using the original key
    const entries = await writer.read("ch:user:123");
    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual(entry);
  });

  it("read returns empty array for missing file", async () => {
    const dir = await makeTmpDir();
    const writer = new TranscriptWriter(dir);

    const entries = await writer.read("nonexistent");
    expect(entries).toEqual([]);
  });

  it("creates sessions subdirectory automatically", async () => {
    const dir = await makeTmpDir();
    const writer = new TranscriptWriter(dir);

    await writer.append("auto-dir", makeTranscript("user", "test"));

    const stat = await fs.stat(path.join(dir, "sessions"));
    expect(stat.isDirectory()).toBe(true);
  });

  it("keeps separate files for different session keys", async () => {
    const dir = await makeTmpDir();
    const writer = new TranscriptWriter(dir);

    await writer.append("sessA", makeTranscript("user", "A"));
    await writer.append("sessB", makeTranscript("user", "B"));

    const a = await writer.read("sessA");
    const b = await writer.read("sessB");

    expect(a).toHaveLength(1);
    expect(a[0]!.text).toBe("A");
    expect(b).toHaveLength(1);
    expect(b[0]!.text).toBe("B");
  });
});
