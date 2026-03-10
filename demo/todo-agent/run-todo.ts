import { getAdapter } from "../../packages/adapters/src/index.js";
import type { StreamEvent } from "../../packages/adapters/src/index.js";
import { getTodo, updateTodo } from "./store.js";

const [todoId, agentType = "claude"] = process.argv.slice(2);

if (!todoId) {
  console.error("Usage: npx tsx run-todo.ts <todoId> [claude|codex]");
  process.exit(1);
}

if (!["claude", "codex"].includes(agentType)) {
  console.error(`Invalid agent type: ${agentType}. Must be 'claude' or 'codex'.`);
  process.exit(1);
}

const todo = getTodo(todoId);
if (!todo) {
  console.error(`Todo not found: ${todoId}`);
  process.exit(1);
}

console.log(`\n▶ Running todo: ${todo.title}`);
console.log(`  Agent: ${agentType}`);
console.log(`  ID: ${todo.id}\n`);

const adapter = getAdapter(agentType);
const startTime = Date.now();

updateTodo(todoId, {
  status: "running",
  agentType: agentType as "claude" | "codex",
});

const prompt = `Task: ${todo.title}\n\nDetails: ${todo.description}`;

try {
  const result = await adapter.execute({
    prompt,
    config: {
      skipPermissions: true,
      maxTurns: 5,
      timeoutSec: 120,
    },
    onEvent: (event: StreamEvent) => {
      if (event.type === "assistant") {
        process.stdout.write(event.text);
      } else if (event.type === "tool_call") {
        console.log(`\n🔧 ${event.name}`);
      } else if (event.type === "result") {
        console.log(`\n\n${event.text}`);
      }
    },
  });

  const durationMs = Date.now() - startTime;
  const success = result.exitCode === 0;

  updateTodo(todoId, {
    status: success ? "done" : "failed",
    runId: result.runId,
    completedAt: new Date().toISOString(),
    agentResult: {
      exitCode: result.exitCode,
      summary: result.summary,
      costUsd: result.costUsd,
      model: result.model,
      errorMessage: result.errorMessage,
      durationMs,
    },
  });

  console.log(`\n${"─".repeat(50)}`);
  console.log(`Status: ${success ? "done" : "failed"}`);
  console.log(`Duration: ${(durationMs / 1000).toFixed(1)}s`);
  if (result.summary) console.log(`Summary: ${result.summary}`);
  if (result.costUsd != null) console.log(`Cost: $${result.costUsd.toFixed(4)}`);
  if (result.errorMessage) console.log(`Error: ${result.errorMessage}`);
} catch (err: unknown) {
  const durationMs = Date.now() - startTime;
  const errorMessage = err instanceof Error ? err.message : String(err);

  updateTodo(todoId, {
    status: "failed",
    completedAt: new Date().toISOString(),
    agentResult: {
      exitCode: null,
      summary: null,
      costUsd: null,
      model: null,
      errorMessage,
      durationMs,
    },
  });

  console.error(`\nFailed: ${errorMessage}`);
  process.exit(1);
}
