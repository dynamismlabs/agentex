/**
 * One-shot execution demo — fire-and-forget.
 *
 * Usage:
 *   npx tsx demo/session-demo/one-shot.ts "Create a hello world Express server"
 *
 * The agent runs a single task and exits. No persistent process, no follow-ups.
 * This is what you want when you trust the agent and just need it to do a thing.
 */
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync } from "node:fs";
import { getProvider } from "../../packages/agent/src/index.js";
import type { StreamEvent } from "../../packages/agent/src/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const prompt = process.argv[2];
if (!prompt) {
  console.error("Usage: npx tsx demo/session-demo/one-shot.ts <prompt>");
  process.exit(1);
}

const workspaceDir = join(__dirname, "workspace");
mkdirSync(workspaceDir, { recursive: true });

const provider = getProvider("claude");

console.log("── One-shot execute() ──\n");
console.log(`Prompt: ${prompt}`);
console.log(`Workspace: ${workspaceDir}\n`);

const result = await provider.execute({
  prompt,
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
    } else if (event.type === "thinking") {
      // Optionally show thinking
      // process.stdout.write(chalk.dim(event.text));
    }
  },
});

console.log(`\n\n${"─".repeat(50)}`);
console.log(`Status:   ${result.exitCode === 0 ? "success" : "failed"}`);
console.log(`Duration: ${(result.durationMs / 1000).toFixed(1)}s`);
if (result.usage) {
  console.log(`Tokens:   ${result.usage.inputTokens} in / ${result.usage.outputTokens} out`);
}
if (result.costUsd != null) console.log(`Cost:     $${result.costUsd.toFixed(4)}`);
if (result.summary) console.log(`Summary:  ${result.summary}`);
if (result.errorMessage) console.log(`Error:    ${result.errorMessage}`);
