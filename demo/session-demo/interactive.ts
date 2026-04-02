/**
 * Interactive session demo — tests AskUserQuestion tool and permission flow.
 *
 * Usage:
 *   npx tsx demo/session-demo/interactive.ts
 *
 * AskUserQuestion flows through the same onUserInputRequest callback as regular
 * tool permissions. Use parseAskUserQuestion() to detect structured questions
 * and return answers via updatedInput.
 *
 * Uses the test-interactive skill to drive a multi-step Q&A conversation.
 */
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync } from "node:fs";
import { createInterface } from "node:readline";
import { getProvider, parseAskUserQuestion } from "../../packages/agent/src/index.js";
import type { StreamEvent, UserInputRequest, UserInputResponse } from "../../packages/agent/src/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const workspaceDir = join(__dirname, "workspace");
mkdirSync(workspaceDir, { recursive: true });

const SKILL_DIRS = [join(__dirname, "skills", "test-interactive")];

// ---------------------------------------------------------------------------
// AskUserQuestion — structured choices in the terminal
// ---------------------------------------------------------------------------

interface QuestionOption {
  label: string;
  description?: string;
}

interface Question {
  question: string;
  header?: string;
  options: QuestionOption[];
  multiSelect?: boolean;
}

async function promptSingleSelect(question: Question): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  console.log(`\n  ${question.header || question.question}`);
  console.log();

  for (let i = 0; i < question.options.length; i++) {
    const opt = question.options[i]!;
    const desc = opt.description ? ` — ${opt.description}` : "";
    console.log(`    ${i + 1}) ${opt.label}${desc}`);
  }
  console.log(`    ${question.options.length + 1}) Other (type your own answer)`);
  console.log();

  const answer = await new Promise<string>((resolve) => {
    rl.question("  Your choice (number or text): ", resolve);
  });
  rl.close();

  const num = parseInt(answer.trim(), 10);
  if (num >= 1 && num <= question.options.length) {
    const selected = question.options[num - 1]!.label;
    console.log(`  → ${selected}`);
    return selected;
  }
  if (num === question.options.length + 1) {
    const rl2 = createInterface({ input: process.stdin, output: process.stdout });
    const freeform = await new Promise<string>((resolve) => {
      rl2.question("  Type your answer: ", resolve);
    });
    rl2.close();
    console.log(`  → ${freeform.trim()}`);
    return freeform.trim();
  }

  console.log(`  → ${answer.trim()}`);
  return answer.trim();
}

async function promptMultiSelect(question: Question): Promise<string[]> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  console.log(`\n  ${question.header || question.question}  (select multiple, comma-separated)`);
  console.log();

  for (let i = 0; i < question.options.length; i++) {
    const opt = question.options[i]!;
    const desc = opt.description ? ` — ${opt.description}` : "";
    console.log(`    ${i + 1}) ${opt.label}${desc}`);
  }
  console.log();

  const answer = await new Promise<string>((resolve) => {
    rl.question("  Your choices (e.g. 1,3,4): ", resolve);
  });
  rl.close();

  const selected: string[] = [];
  for (const part of answer.split(",")) {
    const num = parseInt(part.trim(), 10);
    if (num >= 1 && num <= question.options.length) {
      selected.push(question.options[num - 1]!.label);
    }
  }
  if (selected.length === 0) {
    // Treat entire input as freeform
    selected.push(answer.trim());
  }
  console.log(`  → ${selected.join(", ")}`);
  return selected;
}

/**
 * Present questions to the user and collect answers.
 * Returns answers keyed by question text, suitable for updatedInput.
 */
async function collectAnswers(questions: Question[]): Promise<Record<string, string>> {
  const answers: Record<string, string> = {};

  for (const q of questions) {
    if (q.multiSelect) {
      const selected = await promptMultiSelect(q);
      answers[q.question] = selected.join(", ");
    } else {
      answers[q.question] = await promptSingleSelect(q);
    }
  }

  return answers;
}

// ---------------------------------------------------------------------------
// Unified tool request handler — permissions + AskUserQuestion
// ---------------------------------------------------------------------------

const SAFE_TOOLS = new Set(["Read", "Glob", "Grep", "LS", "View"]);

async function toolRequestHandler(req: UserInputRequest): Promise<UserInputResponse> {
  // AskUserQuestion — present structured choices to the user
  const questions = parseAskUserQuestion(req);
  if (questions) {
    const answers = await collectAnswers(questions as Question[]);
    return { allow: true, updatedInput: { ...req.input, answers } };
  }

  // Regular tool — auto-allow safe tools, prompt for others
  if (SAFE_TOOLS.has(req.toolName)) {
    return { allow: true };
  }

  const inputPreview = JSON.stringify(req.input).slice(0, 100);
  console.log(`\n  [tool request] ${req.toolName}: ${inputPreview}${inputPreview.length >= 100 ? "..." : ""}`);

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise<string>((resolve) => {
    rl.question("  Allow? [y/N] ", resolve);
  });
  rl.close();

  const allowed = answer.trim().toLowerCase() === "y";
  console.log(`  → ${allowed ? "ALLOWED" : "DENIED"}`);
  return { allow: allowed };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const provider = getProvider("claude");

  if (!provider.createSession) {
    console.error("Claude provider does not support createSession.");
    process.exit(1);
  }

  console.log("── Interactive Session Demo ──\n");
  console.log(`Workspace: ${workspaceDir}`);
  console.log(`Skills: ${SKILL_DIRS.join(", ")}\n`);

  const session = await provider.createSession({
    cwd: workspaceDir,
    config: {
      maxTurns: 20,
      timeoutSec: 300,
      skillDirs: SKILL_DIRS,
    },
    onEvent: (event: StreamEvent) => {
      if (event.type === "assistant") {
        process.stdout.write(event.text);
      } else if (event.type === "tool_call") {
        // AskUserQuestion is handled via onUserInputRequest, but log other tools
        if (event.name !== "AskUserQuestion") {
          console.log(`\n  [tool] ${event.name}`);
        }
      }
    },
    onUserInputRequest: toolRequestHandler,
  });

  const isDone = (summary: string | null) =>
    !!summary && (
      summary.includes("TEST RESULTS") ||
      summary.includes("AskUserQuestion test complete") ||
      summary.includes("All done") ||
      summary.includes("patterns tested successfully")
    );

  try {
    console.log("[You] test interactive\n");
    let result = await session.send("test interactive");

    while (!result.isError && result.stopReason === "end_turn") {
      if (isDone(result.summary)) break;

      // Fall back to manual user input
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const reply = await new Promise<string>((resolve) => {
        rl.question("\n[You] ", resolve);
      });
      rl.close();

      if (reply.trim().toLowerCase() === "quit") break;
      result = await session.send(reply.trim());
    }

    console.log(`\n${"─".repeat(50)}`);
    console.log(`Stop reason: ${result.stopReason}`);
    if (result.costUsd != null) console.log(`Cost: $${result.costUsd.toFixed(4)}`);
    if (result.isError) console.log(`Error: ${result.errorMessage}`);
  } finally {
    await session.close();
    console.log("Session closed.");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
