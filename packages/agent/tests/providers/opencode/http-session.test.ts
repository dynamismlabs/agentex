import { describe, it, expect } from "vitest";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { getProvider } from "../../../src/index.js";
import type { StreamEvent } from "../../../src/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OPENCODE_BIN = path.resolve(__dirname, "../../../node_modules/.bin/opencode");

// Real-binary plumbing test — opt in with AGENTEX_REAL_OPENCODE=1. Spawns the
// `opencode serve` daemon, creates a session, runs a turn, and streams events.
// The turn may complete or fail (if no model provider is configured); what's
// validated is the full server + session + SSE plumbing and a well-formed result.
describe("opencode HTTP/SSE session (real binary)", () => {
  it.skipIf(process.env.AGENTEX_REAL_OPENCODE !== "1")(
    "spawns server, creates a session, runs a turn, and tears down",
    async () => {
      const provider = getProvider("opencode");
      const events: StreamEvent[] = [];
      const session = await provider.createSession!({
        config: { command: OPENCODE_BIN, timeoutSec: 60 },
        onEvent: (e) => events.push(e),
      });
      expect(session.sessionId).toBeTruthy();

      const turn = await (await session.send("Reply with the single word: pong")).result;
      await session.close();

      expect(session.state).toBe("closed");
      expect(["completed", "failed", "timeout"]).toContain(turn.status);
    },
    90_000,
  );

  it("declares session capabilities (sessions true, createSession present)", () => {
    const p = getProvider("opencode");
    expect(p.capabilities.sessions).toBe(true);
    expect(p.createSession).toBeDefined();
    expect(p.capabilities.concurrentSend).toBe(false);
  });
});
