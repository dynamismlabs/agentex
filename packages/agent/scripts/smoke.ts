/**
 * Smoke test — run against real or mock agent CLIs.
 *
 * Usage:
 *   pnpm smoke                          # test all providers (real binaries)
 *   pnpm smoke claude codex             # test specific providers
 *   pnpm smoke --mock                   # test all providers with mock scripts
 *   pnpm smoke --mock pi opencode       # test specific providers with mocks
 */
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { getProvider } from "../src/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.resolve(__dirname, "../tests/fixtures");

const MOCK_COMMANDS: Record<string, string> = {
  claude: path.join(FIXTURES_DIR, "mock-claude.sh"),
  codex: path.join(FIXTURES_DIR, "mock-codex.sh"),
  gemini: path.join(FIXTURES_DIR, "mock-gemini.sh"),
  cursor: path.join(FIXTURES_DIR, "mock-cursor.sh"),
  opencode: path.join(FIXTURES_DIR, "mock-opencode.sh"),
  pi: path.join(FIXTURES_DIR, "mock-pi.sh"),
};

async function testProvider(type: string, useMock: boolean) {
  console.log(`\n${"=".repeat(50)}`);
  console.log(`Testing: ${type}${useMock ? " (mock)" : ""}`);
  console.log("=".repeat(50));

  const provider = getProvider(type);

  // In mock mode, skip environment test (mock binaries won't be in PATH)
  if (!useMock) {
    console.log("\n--- Environment Test ---");
    const envResult = await provider.testEnvironment({
      providerType: type,
      config: {},
    });
    console.log(`Status: ${envResult.status}`);
    for (const check of envResult.checks) {
      console.log(`  [${check.level}] ${check.code}: ${check.message}`);
    }

    if (envResult.status === "fail") {
      console.log(`Skipping execution — environment check failed.`);
      return;
    }

    // List models (if supported)
    if (provider.listModels) {
      console.log("\n--- Models ---");
      const models = await provider.listModels();
      console.log(
        `  Found ${models.length} models:`,
        models
          .slice(0, 5)
          .map((m) => m.id)
          .join(", "),
      );
    }
  }

  // Execute a simple prompt
  console.log("\n--- Execute ---");
  const mockCommand = useMock ? MOCK_COMMANDS[type] : undefined;
  if (useMock && !mockCommand) {
    console.log(`  No mock available for "${type}", skipping.`);
    return;
  }

  const result = await provider.execute({
    prompt: "Respond with exactly: hello from agentex",
    config: {
      command: mockCommand,
      maxTurns: 1,
      skipPermissions: true,
      timeoutSec: 30,
    },
    env: useMock ? { MOCK_BEHAVIOR: "success" } : undefined,
    onOutput: (stream, chunk) => {
      if (stream === "stdout" && chunk.trim()) {
        process.stdout.write(".");
      }
    },
    onEvent: (event) => {
      if (event.type === "assistant") {
        console.log(`\n  [event] assistant: ${event.text.slice(0, 80)}`);
      }
    },
  });

  console.log(`\n  Exit code: ${result.exitCode}`);
  console.log(`  Timed out: ${result.timedOut}`);
  console.log(`  Duration: ${(result.durationMs / 1000).toFixed(1)}s`);
  console.log(`  Model: ${result.model}`);
  console.log(`  Billing: ${result.billingType}`);
  console.log(`  Cost: ${result.costUsd != null ? `$${result.costUsd.toFixed(4)}` : "n/a"}`);
  if (result.usage) {
    console.log(
      `  Tokens: ${result.usage.inputTokens} in / ${result.usage.outputTokens} out${result.usage.cachedInputTokens ? ` (${result.usage.cachedInputTokens} cached)` : ""}`,
    );
  }
  console.log(`  Summary: ${result.summary?.slice(0, 120)}`);
  console.log(`  Session ID: ${result.sessionDisplayId}`);
  console.log(`  Error: ${result.errorMessage ?? "none"}`);

  // In mock mode, validate result correctness
  if (useMock) {
    const issues: string[] = [];
    if (result.exitCode !== 0) issues.push(`exit code ${result.exitCode} (expected 0)`);
    if (result.timedOut) issues.push("timed out unexpectedly");
    if (result.errorMessage) issues.push(`error: ${result.errorMessage}`);
    if (!result.summary) issues.push("missing summary");

    if (issues.length > 0) {
      console.log(`  FAIL: ${issues.join(", ")}`);
    } else {
      console.log("  PASS");
    }
  }
}

async function main() {
  const args = process.argv.slice(2);
  const useMock = args.includes("--mock");
  const providers = args.filter((a) => a !== "--mock");
  const defaultProviders = ["claude", "codex", "gemini", "cursor", "opencode", "pi"];
  const toTest = providers.length > 0 ? providers : defaultProviders;

  if (useMock) {
    console.log("Running in mock mode — using mock scripts instead of real binaries.");
  }

  let passed = 0;
  let failed = 0;

  for (const type of toTest) {
    try {
      await testProvider(type, useMock);
      passed++;
    } catch (err) {
      console.error(`\nFATAL for ${type}:`, err);
      failed++;
    }
  }

  if (useMock) {
    console.log(`\n${"=".repeat(50)}`);
    console.log(`Results: ${passed} passed, ${failed} failed out of ${toTest.length} providers`);
    console.log("=".repeat(50));
    if (failed > 0) process.exit(1);
  }
}

main();
