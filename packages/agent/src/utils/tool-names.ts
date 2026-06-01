import type { StreamEvent } from "../types.js";

/**
 * Upper bound on remembered `toolCallId → name` entries. A long-lived session
 * can issue thousands of tool calls; without a cap the map would grow without
 * bound. Tool calls and their results are adjacent in the stream, so a
 * generous FIFO window is plenty — we evict the oldest entry once full.
 */
const MAX_TRACKED = 4096;

/**
 * Stateful enricher that fills in `tool_result.toolName`.
 *
 * The per-line parsers (`parseStreamLine`, `parseCodexStreamLine`) are
 * stateless, and Claude delivers a `tool_use` (the call, carrying `name`) and
 * its `tool_result` (carrying only `tool_use_id`) on *separate* wire lines.
 * Correlating the two therefore has to live in a layer that sees the whole
 * event sequence — the session dispatch loop and the exec accumulator. This
 * factory returns a function that remembers each `tool_call`'s name and stamps
 * it onto the matching `tool_result`, so consumers don't have to keep their own
 * cache.
 *
 * Mutates and returns the event for call-site ergonomics (events are freshly
 * parsed objects, never shared). Only fills `toolName` when it's still null, so
 * providers whose parser already knows the name (Codex) keep their value.
 *
 * One tracker instance per session / per exec invocation. Codex's `item_N` ids
 * are turn-local but a call and its result share the same id within a turn, so
 * correlation holds; ids repeating across turns simply overwrite, which is
 * correct.
 */
export function createToolNameTracker(): (event: StreamEvent) => StreamEvent {
  const namesById = new Map<string, string>();

  return (event) => {
    if (event.type === "tool_call") {
      if (event.toolCallId && event.name) {
        if (namesById.size >= MAX_TRACKED) {
          const oldest = namesById.keys().next().value;
          if (oldest !== undefined) namesById.delete(oldest);
        }
        namesById.set(event.toolCallId, event.name);
      }
    } else if (event.type === "tool_result") {
      if (event.toolName == null && event.toolCallId) {
        event.toolName = namesById.get(event.toolCallId) ?? null;
      }
    }
    return event;
  };
}
