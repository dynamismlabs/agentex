import { describe, expect, it } from "vitest";
import { Readable } from "node:stream";
import * as readline from "node:readline";

import { readJsonlLines, type JsonlLine } from "../../src/utils/jsonl-lines.js";

const LS = " ";
const PS = " ";

async function linesOf(chunks: Array<Buffer | string>, startOffset?: number): Promise<JsonlLine[]> {
  const out: JsonlLine[] = [];
  for await (const line of readJsonlLines(Readable.from(chunks, { objectMode: true }), startOffset)) out.push(line);
  return out;
}

/** Split a buffer into chunks of `size` bytes, cutting through characters. */
function chunked(bytes: Buffer, size: number): Buffer[] {
  const chunks: Buffer[] = [];
  for (let at = 0; at < bytes.length; at += size) chunks.push(bytes.subarray(at, at + size));
  return chunks;
}

describe("readJsonlLines", () => {
  it("keeps U+2028 and U+2029 inside a record, where node:readline splits it", async () => {
    // JSON.stringify writes both separators raw, as Claude Code does.
    const records = [{ text: `copied${LS}from a page` }, { text: `para${PS}graph` }];
    const file = records.map((record) => JSON.stringify(record)).join("\n") + "\n";
    expect(file).toContain(LS);

    const lines = await linesOf([file]);
    expect(lines.map((line) => JSON.parse(line.text))).toEqual(records);

    // The regression this replaces: readline cuts each record in two.
    const viaReadline: string[] = [];
    for await (const line of readline.createInterface({ input: Readable.from([file]), crlfDelay: Infinity })) {
      viaReadline.push(line);
    }
    expect(viaReadline.length).toBeGreaterThan(records.length);
  });

  it("reports exact byte offsets across multi-byte characters", async () => {
    const texts = [`{"t":"café ${LS} \u{1F680}"}`, `{"t":"plain"}`, `{"t":"日本"}`];
    const file = texts.join("\n") + "\n";
    const bytes = Buffer.from(file, "utf8");

    const lines = await linesOf([bytes]);
    expect(lines.map((line) => line.text)).toEqual(texts);
    let at = 0;
    for (const line of lines) {
      expect(line.start).toBe(at);
      expect(bytes.subarray(line.start, line.end - 1).toString("utf8")).toBe(line.text);
      at = line.end;
    }
    expect(at).toBe(bytes.length);
  });

  it("reassembles lines and characters cut across chunk boundaries", async () => {
    const texts = [`{"t":"\u{1F680}${LS}é"}`, `{"t":"${"x".repeat(50)}"}`, `{"t":"日"}`];
    const bytes = Buffer.from(texts.join("\n") + "\n", "utf8");
    for (const size of [1, 2, 3, 5, 7, 64]) {
      const lines = await linesOf(chunked(bytes, size));
      expect(lines.map((line) => line.text), `chunk size ${size}`).toEqual(texts);
      expect(lines.at(-1)!.end).toBe(bytes.length);
    }
  });

  it("drops the \\r of a CRLF ending but counts its byte", async () => {
    const lines = await linesOf(['{"a":1}\r\n{"b":2}\r\n']);
    expect(lines).toEqual([
      { text: '{"a":1}', start: 0, end: 9 },
      { text: '{"b":2}', start: 9, end: 18 },
    ]);
  });

  it("does not split on a lone \\r", async () => {
    const lines = await linesOf(['{"a":1}\r{"b":2}\n']);
    expect(lines.map((line) => line.text)).toEqual(['{"a":1}\r{"b":2}']);
  });

  it("yields a final line with no newline, ending at the end of input", async () => {
    const lines = await linesOf(['{"a":1}\n{"b":', "2}"]);
    expect(lines).toEqual([
      { text: '{"a":1}', start: 0, end: 8 },
      { text: '{"b":2}', start: 8, end: 15 },
    ]);
  });

  it("yields empty lines, so callers decide what to skip", async () => {
    const lines = await linesOf(["\n\n{}\n"]);
    expect(lines.map((line) => line.text)).toEqual(["", "", "{}"]);
    expect(lines.map((line) => line.start)).toEqual([0, 1, 2]);
  });

  it("offsets from startOffset, for streams opened partway into a file", async () => {
    const lines = await linesOf(["{}\n{}\n"], 100);
    expect(lines.map(({ start, end }) => [start, end])).toEqual([[100, 103], [103, 106]]);
  });

  it("yields nothing for empty input", async () => {
    expect(await linesOf([])).toEqual([]);
  });

  it("stops reading the source when the consumer breaks early", async () => {
    let pulled = 0;
    async function* source(): AsyncGenerator<Buffer> {
      for (let index = 0; index < 100; index++) {
        pulled++;
        yield Buffer.from(`{"i":${index}}\n`);
      }
    }
    for await (const line of readJsonlLines(source())) {
      if (line.text.includes('"i":2')) break;
    }
    expect(pulled).toBe(3);
  });
});
