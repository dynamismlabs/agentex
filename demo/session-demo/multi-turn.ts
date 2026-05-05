/**
 * Multi-turn session demo — persistent conversation with the agent.
 *
 * Usage:
 *   npx tsx demo/session-demo/multi-turn.ts
 *
 * Creates a persistent session and sends multiple messages. The agent keeps
 * context between turns — no process restart, no session serialization overhead.
 * This is what you want for interactive UIs, chat interfaces, or multi-step workflows.
 */
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync } from "node:fs";
import { getProvider } from "../../packages/agent/src/index.js";
import type { StreamEvent, TurnResult } from "../../packages/agent/src/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const workspaceDir = join(__dirname, "workspace");
mkdirSync(workspaceDir, { recursive: true });

const provider = getProvider("claude");

if (!provider.createSession) {
  console.error("Claude provider does not support createSession — update your agentex version.");
  process.exit(1);
}

console.log("── Multi-turn createSession() ──\n");
console.log(`Workspace: ${workspaceDir}\n`);

// Create a persistent session
const session = await provider.createSession({
  cwd: workspaceDir,
  config: {
    skipPermissions: true,
    maxTurns: 10,
    timeoutSec: 300,
  },
  onEvent: (event: StreamEvent) => {
    if (event.type === "assistant") {
      process.stdout.write(event.text);
    } else if (event.type === "tool_call") {
      console.log(`\n  [tool] ${event.name}`);
    }
  },
});

function logTurn(label: string, result: TurnResult): void {
  console.log(`\n${"─".repeat(50)}`);
  console.log(`Turn: ${label}`);
  console.log(`Stop:    ${result.stopReason ?? "unknown"}`);
  if (result.usage) {
    console.log(`Tokens:  ${result.usage.inputTokens} in / ${result.usage.outputTokens} out`);
  }
  if (result.costUsd != null) console.log(`Cost:    $${result.costUsd.toFixed(4)}`);
  if (result.errorMessage) console.log(`Error:   ${result.errorMessage}`);
  console.log("");
}

try {
  // Turn 1: Create a file
  console.log("[Turn 1] Creating a file...\n");
  const r1 = await session.send(
    "Create a file called hello.ts with a function that returns 'Hello from agentex!'"
  );
  logTurn("Create file", r1);

  // Turn 2: Modify it — the agent remembers the file it just created
  console.log("[Turn 2] Modifying the file...\n");
  const r2 = await session.send(
    "Now add a second function to that same file that takes a name parameter and returns a personalized greeting."
  );
  logTurn("Modify file", r2);

  // Turn 3: Read it back — prove context is retained
  console.log("[Turn 3] Reading the file...\n");
  const r3 = await session.send(
    "Read hello.ts and tell me what functions are defined in it."
  );
  logTurn("Read file", r3);

  console.log(`\nSession ID: ${session.sessionId}`);
  console.log(`Session state: ${session.state}`);
} finally {
  await session.close();
  console.log("Session closed.");
}
