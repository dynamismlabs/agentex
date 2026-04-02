/**
 * Permission-controlled session demo — approve/deny tool calls in real-time.
 *
 * Usage:
 *   npx tsx demo/session-demo/with-permissions.ts
 *
 * Instead of --dangerously-skip-permissions, uses the SDK's can_use_tool protocol
 * to let the host decide which tools the agent can use. This enables:
 *  - Read-only agents (allow Read/Glob/Grep, deny Edit/Write/Bash)
 *  - Auditing every action before it happens
 *  - Modifying tool inputs (e.g., restricting file paths)
 */
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync } from "node:fs";
import { createInterface } from "node:readline";
import { getProvider } from "../../packages/agent/src/index.js";
import type {
  StreamEvent,
  UserInputRequest,
  UserInputResponse,
  ElicitationRequest,
  ElicitationResponse,
} from "../../packages/agent/src/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const workspaceDir = join(__dirname, "workspace");
mkdirSync(workspaceDir, { recursive: true });

const provider = getProvider("claude");

if (!provider.createSession) {
  console.error("Claude provider does not support createSession.");
  process.exit(1);
}

// ── Permission strategies ──

/** Auto-allow reads, deny everything else. */
function readOnlyPolicy(req: UserInputRequest): UserInputResponse {
  const readTools = new Set(["Read", "Glob", "Grep", "Bash"]);
  // For Bash, only allow read-like commands
  if (req.toolName === "Bash") {
    const cmd = typeof req.input["command"] === "string" ? req.input["command"] : "";
    const isReadOnly = /^(ls|cat|head|tail|find|grep|rg|wc|file|stat|git\s+(status|log|diff|show))/.test(cmd.trim());
    if (!isReadOnly) {
      console.log(`  [DENIED] Bash: ${cmd.slice(0, 80)}`);
      return { allow: false, message: "Only read-only bash commands are allowed." };
    }
  }
  if (readTools.has(req.toolName)) {
    console.log(`  [ALLOWED] ${req.toolName}`);
    return { allow: true };
  }
  console.log(`  [DENIED] ${req.toolName}`);
  return { allow: false, message: `Tool '${req.toolName}' is not permitted in read-only mode.` };
}

/** Interactive — prompt the user for every tool call. */
async function interactivePolicy(req: UserInputRequest): Promise<UserInputResponse> {
  const inputPreview = JSON.stringify(req.input).slice(0, 120);
  console.log(`\n  Permission request: ${req.toolName}`);
  console.log(`  Input: ${inputPreview}${inputPreview.length >= 120 ? "..." : ""}`);

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise<string>((resolve) => {
    rl.question("  Allow? [y/N] ", resolve);
  });
  rl.close();

  const allowed = answer.trim().toLowerCase() === "y";
  console.log(`  → ${allowed ? "ALLOWED" : "DENIED"}\n`);
  return { allow: allowed };
}

// ── Elicitation handler ──

/** Handle MCP server requests for user input (forms, multiple choice, etc.). */
async function elicitationHandler(req: ElicitationRequest): Promise<ElicitationResponse> {
  console.log(`\n  [elicitation] from ${req.mcpServerName}: ${req.message}`);

  // If it's a URL to open, show it
  if (req.mode === "url" && req.url) {
    console.log(`  URL: ${req.url}`);
    return { action: "accept" };
  }

  // If there's a schema, show the expected input shape
  if (req.requestedSchema) {
    const props = (req.requestedSchema["properties"] ?? {}) as Record<string, Record<string, unknown>>;

    for (const [key, schema] of Object.entries(props)) {
      // Multiple choice — show options
      const oneOf = schema["oneOf"] as Array<{ const: string; title?: string }> | undefined;
      const enumValues = schema["enum"] as string[] | undefined;

      if (oneOf) {
        console.log(`  ${key} (select one):`);
        for (const opt of oneOf) {
          console.log(`    - ${opt.const}${opt.title ? ` — ${opt.title}` : ""}`);
        }
      } else if (enumValues) {
        console.log(`  ${key} (select one): ${enumValues.join(" | ")}`);
      } else {
        console.log(`  ${key}: [${schema["type"] ?? "any"}]`);
      }
    }

    // Auto-accept with a prompt for demo purposes
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await new Promise<string>((resolve) => {
      rl.question("  Your response (or 'skip' to decline): ", resolve);
    });
    rl.close();

    if (answer.trim().toLowerCase() === "skip") {
      return { action: "decline" };
    }

    // Simple single-field response — use the first property key
    const firstKey = Object.keys(props)[0];
    if (firstKey) {
      return { action: "accept", content: { [firstKey]: answer.trim() } };
    }
  }

  return { action: "decline" };
}

// ── Choose mode ──
const mode = process.argv[2] ?? "read-only";

const permissionHandler = mode === "interactive"
  ? interactivePolicy
  : async (req: UserInputRequest) => readOnlyPolicy(req);

console.log(`── Session with permissions (${mode} mode) ──\n`);
console.log(`Workspace: ${workspaceDir}\n`);

const session = await provider.createSession({
  cwd: workspaceDir,
  config: {
    // No skipPermissions — the onUserInputRequest callback handles it
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
  onUserInputRequest: permissionHandler,
  onElicitation: elicitationHandler,
});

try {
  console.log("[Sending] Tell me what files exist in this workspace and summarize them.\n");
  const result = await session.send(
    "List all files in the current directory and read the first few. Summarize what you find. Then create a summary.md file."
  );

  console.log(`\n${"─".repeat(50)}`);
  console.log(`Stop reason: ${result.stopReason}`);
  console.log(`Is error: ${result.isError}`);
  if (result.costUsd != null) console.log(`Cost: $${result.costUsd.toFixed(4)}`);
  if (result.errorMessage) console.log(`Error: ${result.errorMessage}`);

  console.log("\nNote: In read-only mode, the Write tool for summary.md was denied.");
  console.log("The agent could read files but not create new ones.\n");
} finally {
  await session.close();
  console.log("Session closed.");
}
