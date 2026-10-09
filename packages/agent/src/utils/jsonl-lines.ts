/**
 * Line splitting for JSONL files on disk.
 *
 * `node:readline` also breaks lines at U+2028 (LINE SEPARATOR), U+2029
 * (PARAGRAPH SEPARATOR) and a lone `\r`. JSON allows U+2028/U+2029 unescaped
 * inside strings, and both `JSON.stringify` (Claude Code) and serde_json
 * (Codex) write them raw, typically in text copied from web pages. readline
 * cuts such a record in two, both halves fail to parse, and the record
 * silently disappears. Every byte offset after it also drifts by two bytes
 * per separator, so a resume offset can land mid-record.
 *
 * {@link readJsonlLines} splits on `\n` only, drops the `\r` of a `\r\n`
 * ending, and reports exact byte offsets.
 */

export interface JsonlLine {
  /** Line text without its `\n` or `\r\n` terminator. */
  text: string;
  /** Byte offset of the line's first byte. */
  start: number;
  /**
   * Byte offset just past the line's `\n`, which is where the next line
   * starts. For a final line with no `\n`, the end of the file.
   */
  end: number;
}

const NEWLINE = 0x0a;
const CARRIAGE_RETURN = 0x0d;

function decodeLine(bytes: Buffer): string {
  const length = bytes.length > 0 && bytes[bytes.length - 1] === CARRIAGE_RETURN
    ? bytes.length - 1
    : bytes.length;
  return bytes.toString("utf8", 0, length);
}

/**
 * Yield the lines of a byte stream, typically `createReadStream(path, { start })`
 * opened without an encoding. `startOffset` is the stream's starting byte
 * offset in the file, so reported offsets are file offsets.
 *
 * Splitting happens on bytes before decoding. A `\n` byte never occurs inside
 * a multi-byte UTF-8 sequence, so no character is split across lines.
 */
export async function* readJsonlLines(
  input: AsyncIterable<Buffer | string>,
  startOffset = 0,
): AsyncGenerator<JsonlLine> {
  let pending: Buffer[] = [];
  let pendingBytes = 0;
  let lineStart = startOffset;

  for await (const value of input) {
    const chunk = typeof value === "string" ? Buffer.from(value, "utf8") : value;
    let from = 0;
    let newline = chunk.indexOf(NEWLINE, from);
    while (newline !== -1) {
      const piece = chunk.subarray(from, newline);
      const bytes = pendingBytes > 0 ? Buffer.concat([...pending, piece], pendingBytes + piece.length) : piece;
      const end = lineStart + bytes.length + 1;
      yield { text: decodeLine(bytes), start: lineStart, end };
      lineStart = end;
      pending = [];
      pendingBytes = 0;
      from = newline + 1;
      newline = chunk.indexOf(NEWLINE, from);
    }
    if (from < chunk.length) {
      const tail = chunk.subarray(from);
      pending.push(tail);
      pendingBytes += tail.length;
    }
  }

  if (pendingBytes > 0) {
    const bytes = Buffer.concat(pending, pendingBytes);
    yield { text: decodeLine(bytes), start: lineStart, end: lineStart + bytes.length };
  }
}

/** Defensive helpers shared by native telemetry adapters. */
export function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
export function nonnegative(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}
export function textValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
export function isoTime(value: unknown, unit: "seconds" | "iso" = "iso"): string | undefined {
  const ms = unit === "seconds" ? (typeof value === "number" && Number.isFinite(value) ? value * 1000 : NaN)
    : typeof value === "string" ? Date.parse(value) : NaN;
  if (!Number.isFinite(ms) || Math.abs(ms) > 8.64e15) return undefined;
  return new Date(ms).toISOString();
}
/** Keep additive protocol detail but exclude credentials recursively; never store environment/config. */
export function metadata(value: Record<string, unknown>): Record<string, unknown> {
  const seen = new WeakSet<object>();
  const clean = (v: unknown, depth: number): unknown => {
    if (depth > 12) return undefined;
    if (v === null || typeof v === "boolean" || typeof v === "number") return v;
    if (typeof v === "string") return /^(?:Bearer|Basic)\s/i.test(v) ? "[redacted]" : v;
    if (typeof v !== "object" || seen.has(v)) return undefined;
    seen.add(v);
    if (Array.isArray(v)) return v.map((item) => clean(item, depth + 1));
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(v)) {
      if (/(?:authorization|credential|password|secret|api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|cookie|^env$)/i.test(key)) continue;
      const result = clean(item, depth + 1);
      if (result !== undefined) out[key] = result;
    }
    return out;
  };
  return clean(value, 0) as Record<string, unknown>;
}
