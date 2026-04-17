/**
 * Worktree isolation demo — run an agent in an isolated git worktree.
 *
 * Usage:
 *   npx tsx demo/session-demo/with-worktree.ts "Add a health check endpoint to server.ts"
 *   npx tsx demo/session-demo/with-worktree.ts --mock   # uses mock CLI, no real agent needed
 *
 * The agent works in a throwaway worktree branch. Your main working tree
 * stays clean. After execution you can inspect the diff, apply it, or
 * discard it.
 *
 * This pattern is ideal for:
 *   - Running untrusted/speculative agent tasks without risk
 *   - Parallelizing multiple agents on the same repo (each in its own worktree)
 *   - Code review workflows: let the agent work, then review the diff before merging
 */
import * as path from "node:path";
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";
import {
  getProvider,
  prepareWorkspace,
  aggregateUsage,
} from "../../packages/agent/src/index.js";
import type { StreamEvent } from "../../packages/agent/src/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.resolve(__dirname, "../../packages/agent/tests/fixtures");

async function main() {
  // ── Parse args ──────────────────────────────────────────────────────────
  const args = process.argv.slice(2);
  const useMock = args.includes("--mock");
  const prompt = args.find((a) => a !== "--mock") ?? "Create a file called hello.txt with the text 'hello from worktree'";

  // Use the monorepo root as the repo to create the worktree from
  const repoRoot = path.resolve(__dirname, "../..");

  console.log("── Worktree Isolation Demo ──\n");
  console.log(`Repo:   ${repoRoot}`);
  console.log(`Prompt: ${prompt}`);
  console.log(`Mock:   ${useMock}\n`);

  // ── 1. Create an isolated worktree ──────────────────────────────────────
  console.log("1. Creating worktree...");
  const workspace = await prepareWorkspace(repoRoot, {
    strategy: "worktree",
    branchName: `demo/worktree-${Date.now()}`,
  });

  console.log(`   Branch:   ${workspace.branch}`);
  console.log(`   Location: ${workspace.cwd}`);
  console.log(`   Main tree untouched: ${workspace.originalCwd}\n`);

  try {
    // ── 2. Run the agent inside the worktree ────────────────────────────────
    console.log("2. Running agent in worktree...\n");

    const provider = getProvider("claude");
    const mockCommand = useMock ? path.join(FIXTURES_DIR, "mock-claude.sh") : undefined;

    const result = await provider.execute({
      prompt,
      cwd: workspace.cwd,
      config: {
        command: mockCommand,
        skipPermissions: true,
        maxTurns: 10,
        timeoutSec: 120,
      },
      env: useMock ? { MOCK_BEHAVIOR: "success" } : undefined,
      onEvent: (event: StreamEvent) => {
        if (event.type === "assistant") {
          process.stdout.write(event.text);
        } else if (event.type === "tool_call") {
          console.log(`\n   [tool] ${event.name}${event.callId ? ` (${event.callId.slice(0, 8)})` : ""}`);
        }
      },
    });

    console.log(`\n\n   Status:   ${result.status}`);
    console.log(`   Duration: ${(result.durationMs / 1000).toFixed(1)}s`);
    const agg = aggregateUsage(result.usage);
    if (agg) {
      console.log(`   Tokens:   ${agg.inputTokens} in / ${agg.outputTokens} out`);
    }
    if (result.costUsd != null) console.log(`   Cost:     $${result.costUsd.toFixed(4)}`);
    if (result.errorMessage) console.log(`   Error:    ${result.errorMessage}`);

    // If mock mode, simulate some file changes so the diff has something to show
    if (useMock) {
      fs.writeFileSync(
        path.join(workspace.cwd, "hello.txt"),
        "hello from worktree\n",
      );
      const readmePath = path.join(workspace.cwd, "README.md");
      if (fs.existsSync(readmePath)) {
        fs.appendFileSync(readmePath, "\n<!-- agent modification -->\n");
      }
    }

    // ── 3. Inspect the diff ─────────────────────────────────────────────────
    console.log("\n3. Diff options:\n");

    // 3a. Full diff (default) — everything that changed
    console.log("── diff() — all changes ──");
    const fullDiff = await workspace.diff();
    if (fullDiff) {
      const lines = fullDiff.split("\n");
      for (const line of lines.slice(0, 30)) console.log(`   ${line}`);
      if (lines.length > 30) console.log(`   ... (${lines.length - 30} more lines)`);
    } else {
      console.log("   (no changes)");
    }

    // 3b. Stat summary — quick overview
    console.log("\n── diff({ stat: true }) — summary ──");
    const statDiff = await workspace.diff({ stat: true });
    if (statDiff) {
      for (const line of statDiff.split("\n")) console.log(`   ${line}`);
    } else {
      console.log("   (no changes)");
    }

    // 3c. Just untracked files
    console.log("\n── diff({ scope: 'untracked' }) — new files only ──");
    const untrackedDiff = await workspace.diff({ scope: "untracked" });
    if (untrackedDiff) {
      const lines = untrackedDiff.split("\n");
      for (const line of lines.slice(0, 20)) console.log(`   ${line}`);
      if (lines.length > 20) console.log(`   ... (${lines.length - 20} more lines)`);
    } else {
      console.log("   (no new files)");
    }

    // 3d. Just uncommitted changes to tracked files
    console.log("\n── diff({ scope: 'uncommitted' }) — modified tracked files ──");
    const uncommittedDiff = await workspace.diff({ scope: "uncommitted" });
    if (uncommittedDiff) {
      const lines = uncommittedDiff.split("\n");
      for (const line of lines.slice(0, 20)) console.log(`   ${line}`);
      if (lines.length > 20) console.log(`   ... (${lines.length - 20} more lines)`);
    } else {
      console.log("   (no uncommitted changes to tracked files)");
    }

    // ── 4. Verify main tree is clean ────────────────────────────────────────
    console.log("\n4. Main working tree:");
    const helloInMain = fs.existsSync(path.join(repoRoot, "hello.txt"));
    console.log(`   hello.txt in main? ${helloInMain}`);

  } finally {
    // ── 5. Cleanup (always runs) ────────────────────────────────────────────
    console.log("\n5. Cleaning up...");
    await workspace.cleanup({ deleteBranch: true });
    console.log(`   Worktree removed: ${!fs.existsSync(workspace.cwd)}`);
    console.log(`   Branch deleted: ${workspace.branch}`);
  }

  console.log("\nDone.");
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
