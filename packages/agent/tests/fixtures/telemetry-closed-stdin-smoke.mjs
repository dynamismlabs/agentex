// Run in a separate host process so an uncaught EPIPE is an ordinary test
// failure, rather than an unhandled error in the Vitest worker.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { createCodexSession } from "../../dist/providers/codex/session.js";
import { createClaudeSession } from "../../dist/providers/claude/session.js";

const [protocol, surface, marker] = process.argv.slice(2);
const create = protocol === "codex" ? createCodexSession : createClaudeSession;
const method = protocol === "codex" ? "account/rateLimits/read"
  : surface === "contextUsage" ? "get_context_usage" : "get_usage";
const session = await create({
  config: { command: fileURLToPath(new URL("mock-telemetry-harness.mjs", import.meta.url)), skipPermissions: true, graceSec: 1 },
  env: { MOCK_TELEMETRY_PROTOCOL: protocol, MOCK_CLOSE_STDIN_AFTER_METHOD: method, MOCK_STDIN_CLOSED_FILE: marker },
});
try {
  const telemetry = session[surface];
  const first = await telemetry.refresh();
  assert.equal(first.status, "fresh");
  const deadline = Date.now() + 2000;
  while (await readFile(marker, "utf8").catch(() => "") !== "closed") {
    assert.ok(Date.now() < deadline, "harness did not close stdin");
    await delay(10);
  }
  assert.notEqual(session.state, "closed", "refresh must race stdin closure, not process exit");
  const result = await telemetry.refresh();
  assert.equal(result.status, surface === "contextUsage" ? "stale" : "unavailable");
  assert.equal(result.refreshSupported, false);
  assert.deepEqual(result.value, surface === "contextUsage" ? first.value : {
    ...first.value, buckets: first.value.buckets.map((bucket) => ({ ...bucket, stale: true })),
  });
  assert.equal(session.state, "closed");
  assert.equal((session._pendingRpc ?? session._pendingControlResponses).size, 0);
} finally {
  await session.close();
}
assert.ok(session.proc.exitCode !== null || session.proc.signalCode !== null, "close must await harness cleanup");
console.log("closed-stdin refresh survived");
