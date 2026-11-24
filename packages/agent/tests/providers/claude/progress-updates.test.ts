import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { getProvider } from "../../../src/index.js";
import { parseClaudeStreamJson, parseStreamLine } from "../../../src/providers/claude/parse.js";
import type { PartialStreamContext } from "../../../src/providers/claude/parse.js";
import type { StreamEvent } from "../../../src/types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Both captured live on 2026-11-24 from claude 2.1.331 on claude-opus-5-5,
// one run asked to check four files one at a time and "keep me posted":
//  - stream: stream-json stdout with --include-partial-messages (system
//    lines dropped, signatures shortened).
//  - transcript: the same run's transcript as Claude Code wrote it to disk
//    (user and assistant lines, signatures shortened).
// Claude Code requests `thinking.display: "updates"` by default, so the
// reasoning blocks are empty and the notes between tool calls come back as
// thinking blocks with text. The stream names the mode `thinking_display`,
// the transcript `thinkingDisplay`.
const STREAM = readFileSync(
  path.resolve(__dirname, "../../fixtures/claude-progress-updates-stream.jsonl"),
  "utf-8",
);
const TRANSCRIPT = readFileSync(
  path.resolve(__dirname, "../../fixtures/claude-progress-updates-transcript.jsonl"),
  "utf-8",
);

const lines = (jsonl: string) => jsonl.split("\n").filter((line) => line.trim());

function parseAll(jsonl: string): StreamEvent[] {
  const ctx: PartialStreamContext = { messageId: null };
  return lines(jsonl).flatMap((line) => parseStreamLine(line, ctx));
}

/** The text of every non-empty thinking block in the raw lines, in order. */
function rawProgressNotes(jsonl: string): string[] {
  const notes: string[] = [];
  for (const line of lines(jsonl)) {
    const record = JSON.parse(line) as { type?: string; message?: { content?: unknown } };
    if (record.type !== "assistant" || !Array.isArray(record.message?.content)) continue;
    for (const block of record.message.content as Array<{ type?: string; thinking?: string }>) {
      if (block.type === "thinking" && block.thinking?.trim()) notes.push(block.thinking);
    }
  }
  return notes;
}

const commentary = (events: StreamEvent[]) =>
  events.filter((e): e is Extract<StreamEvent, { type: "assistant" }> => e.type === "assistant" && e.phase === "commentary");

/** Swap the progress-update line's display mode for another (or remove it). */
function withDisplay(line: string, display: string | undefined): string {
  const record = JSON.parse(line) as Record<string, unknown>;
  delete record["thinking_display"];
  delete record["thinkingDisplay"];
  if (display !== undefined) record["thinking_display"] = display;
  return JSON.stringify(record);
}

const firstUpdateLine = lines(STREAM).find((line) => {
  const record = JSON.parse(line) as { type?: string; message?: { content?: Array<{ type?: string; thinking?: string }> } };
  return record.type === "assistant" && record.message?.content?.some((b) => b.type === "thinking" && b.thinking);
})!;

describe("Claude progress updates (thinking.display: \"updates\")", () => {
  it("the fixtures hold real progress notes, empty reasoning blocks and ordinary text", () => {
    expect(rawProgressNotes(STREAM).length).toBeGreaterThanOrEqual(2);
    expect(rawProgressNotes(TRANSCRIPT)).toEqual(rawProgressNotes(STREAM));
    expect(STREAM).toContain('"thinking_display":"updates"');
    expect(TRANSCRIPT).toContain('"thinkingDisplay":"updates"');
  });

  it("surfaces each progress note from the live stream as commentary, verbatim and in order", () => {
    const events = parseAll(STREAM);
    expect(commentary(events).map((e) => e.text)).toEqual(rawProgressNotes(STREAM));
    expect(events.some((e) => e.type === "thinking" && e.text.trim())).toBe(false);
  });

  it("surfaces the same notes from the transcript on disk", () => {
    const events = parseAll(TRANSCRIPT);
    expect(commentary(events).map((e) => e.text)).toEqual(rawProgressNotes(TRANSCRIPT));
    expect(events.some((e) => e.type === "thinking" && e.text.trim())).toBe(false);
  });

  it("keeps the empty reasoning blocks as thinking, and ordinary text without a phase", () => {
    const events = parseAll(STREAM);
    const thinking = events.filter((e) => e.type === "thinking");
    expect(thinking.length).toBeGreaterThan(0);
    expect(thinking.every((e) => e.type === "thinking" && e.text === "")).toBe(true);

    const plain = events.filter((e) => e.type === "assistant" && e.phase === undefined);
    expect(plain.length).toBeGreaterThan(0);
    expect(plain.some((e) => e.type === "assistant" && e.text.includes("a.txt"))).toBe(true);
  });

  it("places each note right before the tool call it introduces", () => {
    const content = new Set(["assistant", "thinking", "tool_call", "tool_result"]);
    const events = parseAll(TRANSCRIPT).filter((e) => content.has(e.type));
    for (const note of commentary(events)) {
      const next = events[events.indexOf(note) + 1];
      expect(next?.type).toBe("tool_call");
    }
  });

  it("streams a note's deltas as commentary assistant_delta that add up to the note", () => {
    const events = parseAll(STREAM);
    expect(events.some((e) => e.type === "thinking_delta")).toBe(false);

    const byBlock = new Map<string, string>();
    for (const e of events) {
      if (e.type !== "assistant_delta" || e.phase !== "commentary") continue;
      const key = `${e.messageId}:${e.blockIndex}`;
      byBlock.set(key, (byBlock.get(key) ?? "") + e.text);
    }
    const notes = commentary(events);
    expect([...byBlock.values()]).toEqual(notes.map((e) => e.text));
    for (const note of notes) expect(note.messageId).toBeTruthy();
    // Deltas carry the consolidated event's messageId, so a host can swap
    // its optimistic text for the durable event.
    const ids = new Set(notes.map((e) => e.messageId));
    for (const e of events) {
      if (e.type === "assistant_delta" && e.phase === "commentary") expect(ids.has(e.messageId)).toBe(true);
    }
  });

  it("leaves a thinking block as thinking in any other display mode, or with none", () => {
    for (const display of [undefined, "summarized", "omitted"]) {
      const events = parseStreamLine(withDisplay(firstUpdateLine, display))
        .filter((e) => e.type === "thinking" || e.type === "assistant");
      expect(events.map((e) => e.type)).toEqual(["thinking"]);
      expect(events[0]!.type === "thinking" && events[0]!.text.trim()).toBeTruthy();
    }
  });

  it("keeps notes out of the one-shot summary, which is the result text", () => {
    const result = parseClaudeStreamJson(STREAM);
    const notes = rawProgressNotes(STREAM);
    expect(result.summary).toBeTruthy();
    for (const note of notes) expect(result.summary).not.toContain(note.trim());
  });
});

describe("Claude progress updates in local history", () => {
  let root: string | undefined;

  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
    root = undefined;
  });

  it("reads saved progress notes as commentary", async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "agentex-progress-updates-"));
    const sessionId = (JSON.parse(lines(TRANSCRIPT)[0]!) as { sessionId: string }).sessionId;
    const dir = path.join(root, "projects", "-private-tmp-pu-probe3");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, `${sessionId}.jsonl`), TRANSCRIPT);

    const history = getProvider("claude").localHistory!;
    const sessions = [];
    for await (const session of history.discover({ env: { CLAUDE_CONFIG_DIR: root } })) sessions.push(session);
    expect(sessions).toHaveLength(1);

    const events: StreamEvent[] = [];
    for await (const value of history.read(sessions[0]!)) events.push(value.event);
    expect(commentary(events).map((e) => e.text)).toEqual(rawProgressNotes(TRANSCRIPT));
    expect(events.some((e) => e.type === "thinking" && e.text.trim())).toBe(false);
  });
});
