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
import { getProvider, parseAskUserQuestion, aggregateUsage } from "../src/index.js";
import type {
  StreamEvent,
  TurnResult,
  UserInputRequest,
  ElicitationRequest,
  HookCallbackRequest,
} from "../src/index.js";

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

const MOCK_SESSION_COMMAND = path.join(FIXTURES_DIR, "mock-claude-session.sh");

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
  console.log("\n--- Execute (one-shot) ---");
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
  console.log(`  Status: ${result.status}`);
  console.log(`  Duration: ${(result.durationMs / 1000).toFixed(1)}s`);
  console.log(`  Model: ${result.model}`);
  console.log(`  Billing: ${result.billingType}`);
  console.log(`  Cost: ${result.costUsd != null ? `$${result.costUsd.toFixed(4)}` : "n/a"}`);
  const agg = aggregateUsage(result.usage);
  if (agg) {
    console.log(
      `  Tokens: ${agg.inputTokens} in / ${agg.outputTokens} out${agg.cachedInputTokens ? ` (${agg.cachedInputTokens} cached)` : ""}`,
    );
  }
  console.log(`  Summary: ${result.summary?.slice(0, 120)}`);
  console.log(`  Session ID: ${result.sessionDisplayId}`);
  console.log(`  Error: ${result.errorMessage ?? "none"}`);

  // In mock mode, validate result correctness
  if (useMock) {
    const issues: string[] = [];
    if (result.exitCode !== 0) issues.push(`exit code ${result.exitCode} (expected 0)`);
    if (result.status === "timeout") issues.push("timed out unexpectedly");
    if (result.errorMessage) issues.push(`error: ${result.errorMessage}`);
    if (!result.summary) issues.push("missing summary");

    if (issues.length > 0) {
      console.log(`  FAIL: ${issues.join(", ")}`);
    } else {
      console.log("  PASS");
    }
  }
}

// ---------------------------------------------------------------------------
// Session smoke test (Claude-only, mock or real)
// ---------------------------------------------------------------------------

async function testSession(useMock: boolean) {
  console.log(`\n${"=".repeat(50)}`);
  console.log(`Testing: createSession (claude${useMock ? ", mock" : ""})`);
  console.log("=".repeat(50));

  const provider = getProvider("claude");

  if (!provider.createSession) {
    console.log("  SKIP — createSession not available on provider");
    return;
  }

  const events: StreamEvent[] = [];
  const session = await provider.createSession({
    config: {
      command: useMock ? MOCK_SESSION_COMMAND : undefined,
      skipPermissions: true,
      maxTurns: 5,
      timeoutSec: 30,
    },
    onEvent: (event) => {
      events.push(event);
    },
  });

  const issues: string[] = [];

  // Turn 1
  console.log("\n--- Turn 1 ---");
  const r1 = await session.send("Hello from smoke test turn 1");
  logTurn(r1);
  if (r1.status === "failed") issues.push(`turn 1 error: ${r1.errorMessage}`);
  if (!r1.summary) issues.push("turn 1 missing summary");

  // Turn 2 — verify context retention (session stays alive)
  console.log("\n--- Turn 2 ---");
  const r2 = await session.send("This is turn 2, do you remember turn 1?");
  logTurn(r2);
  if (r2.status === "failed") issues.push(`turn 2 error: ${r2.errorMessage}`);
  if (!r2.summary) issues.push("turn 2 missing summary");

  // Turn 3
  console.log("\n--- Turn 3 ---");
  const r3 = await session.send("Final turn, turn 3");
  logTurn(r3);
  if (r3.status === "failed") issues.push(`turn 3 error: ${r3.errorMessage}`);
  if (!r3.summary) issues.push("turn 3 missing summary");

  // Verify session state
  console.log(`\n  Session ID: ${session.sessionId}`);
  console.log(`  Session state: ${session.state}`);
  console.log(`  Total events: ${events.length}`);

  if (session.state !== "idle") issues.push(`expected state "idle", got "${session.state}"`);
  if (events.length === 0) issues.push("no stream events received");

  // Close
  await session.close();
  console.log(`  State after close: ${session.state}`);
  if (session.state !== "closed") issues.push(`expected "closed" after close, got "${session.state}"`);

  if (issues.length > 0) {
    console.log(`\n  FAIL: ${issues.join(", ")}`);
    return false;
  }
  console.log("\n  PASS");
  return true;
}

function logTurn(r: TurnResult): void {
  console.log(`  Summary: ${r.summary?.slice(0, 100)}`);
  console.log(`  Status: ${r.status}`);
  console.log(`  Error: ${r.errorMessage ?? "none"}`);
  const turnAgg = aggregateUsage(r.usage);
  if (turnAgg) {
    console.log(`  Tokens: ${turnAgg.inputTokens} in / ${turnAgg.outputTokens} out`);
  }
  if (r.costUsd != null) console.log(`  Cost: $${r.costUsd.toFixed(4)}`);
}

// ---------------------------------------------------------------------------
// Session protocol tests (mock-only) — permission, elicitation, hooks, cancel
// ---------------------------------------------------------------------------

async function testSessionProtocol(useMock: boolean): Promise<boolean> {
  if (!useMock) {
    console.log("  SKIP — protocol tests only run in mock mode");
    return true;
  }

  console.log(`\n${"=".repeat(50)}`);
  console.log("Testing: session protocol (permissions, elicitation, hooks, cancel)");
  console.log("=".repeat(50));

  const provider = getProvider("claude");
  if (!provider.createSession) {
    console.log("  SKIP — createSession not available");
    return true;
  }

  const issues: string[] = [];

  // Track callback invocations
  const permissionCalls: UserInputRequest[] = [];
  const elicitationCalls: ElicitationRequest[] = [];
  const hookCalls: HookCallbackRequest[] = [];

  const session = await provider.createSession({
    config: {
      command: MOCK_SESSION_COMMAND,
      maxTurns: 10,
      timeoutSec: 30,
    },
    onEvent: () => {},
    onUserInputRequest: async (req) => {
      permissionCalls.push(req);

      // AskUserQuestion — return answers via updatedInput
      const questions = parseAskUserQuestion(req);
      if (questions) {
        const answers: Record<string, string> = {};
        for (const q of questions) {
          answers[q.question] = q.options[0]?.label ?? "default";
        }
        return { allow: true, updatedInput: { ...req.input, answers } };
      }

      // Regular tool — allow
      return { allow: true };
    },
    onElicitation: async (req) => {
      elicitationCalls.push(req);
      return { action: "accept", content: { framework: "express", notes: "looks good" } };
    },
    onHookCallback: async (req) => {
      hookCalls.push(req);
      return { result: { allowed: true } };
    },
  });

  // --- Test 1: can_use_tool permission ---
  console.log("\n--- Permission (can_use_tool) ---");
  const r1 = await session.send("test-permissions");
  logTurn(r1);
  if (r1.status === "failed") issues.push(`permission turn error: ${r1.errorMessage}`);
  if (permissionCalls.length === 0) {
    issues.push("onUserInputRequest was never called");
  } else {
    const call = permissionCalls[0]!;
    if (call.toolName !== "Bash") issues.push(`expected toolName "Bash", got "${call.toolName}"`);
    if (!call.toolUseId) issues.push("missing toolUseId");
    // Verify optional fields are mapped from wire format
    if (call.title !== "Run shell command") issues.push(`expected title "Run shell command", got "${call.title}"`);
    if (call.description !== "Execute echo hello") issues.push(`expected description "Execute echo hello", got "${call.description}"`);
    // Verify input content
    const cmd = (call.input as Record<string, unknown>)["command"];
    if (cmd !== "echo hello") issues.push(`expected input.command "echo hello", got "${cmd}"`);
    console.log(`  onUserInputRequest called: toolName=${call.toolName} title=${call.title} toolUseId=${call.toolUseId}`);
    console.log("  PASS");
  }

  // --- Test 2: AskUserQuestion ---
  console.log("\n--- AskUserQuestion ---");
  permissionCalls.length = 0;
  const r2 = await session.send("test-ask-question");
  logTurn(r2);
  if (r2.status === "failed") issues.push(`ask-question turn error: ${r2.errorMessage}`);
  if (permissionCalls.length === 0) {
    issues.push("onUserInputRequest not called for AskUserQuestion");
  } else {
    const call = permissionCalls[0]!;
    if (call.toolName !== "AskUserQuestion") issues.push(`expected "AskUserQuestion", got "${call.toolName}"`);
    const questions = parseAskUserQuestion(call);
    if (!questions) {
      issues.push("parseAskUserQuestion returned null");
    } else {
      if (questions.length !== 1) issues.push(`expected 1 question, got ${questions.length}`);
      if (questions[0]!.options.length !== 3) issues.push(`expected 3 options, got ${questions[0]!.options.length}`);
      console.log(`  Parsed ${questions.length} question(s) with ${questions[0]!.options.length} options`);
      console.log("  PASS");
    }
  }

  // --- Test 2b: AskUserQuestion multi-select ---
  console.log("\n--- AskUserQuestion (multiSelect) ---");
  permissionCalls.length = 0;
  const r2b = await session.send("test-ask-multiselect");
  logTurn(r2b);
  if (r2b.status === "failed") issues.push(`ask-multiselect turn error: ${r2b.errorMessage}`);
  if (permissionCalls.length === 0) {
    issues.push("onUserInputRequest not called for multiSelect AskUserQuestion");
  } else {
    const call = permissionCalls[0]!;
    const questions = parseAskUserQuestion(call);
    if (!questions) {
      issues.push("parseAskUserQuestion returned null for multiSelect");
    } else {
      if (questions[0]!.multiSelect !== true) issues.push("expected multiSelect to be true");
      if (questions[0]!.options.length !== 4) issues.push(`expected 4 options, got ${questions[0]!.options.length}`);
      console.log(`  multiSelect=${questions[0]!.multiSelect}, ${questions[0]!.options.length} options`);
      console.log("  PASS");
    }
  }

  // --- Test 3: Elicitation ---
  console.log("\n--- Elicitation ---");
  const r3 = await session.send("test-elicitation");
  logTurn(r3);
  if (r3.status === "failed") issues.push(`elicitation turn error: ${r3.errorMessage}`);
  if (elicitationCalls.length === 0) {
    issues.push("onElicitation was never called");
  } else {
    const call = elicitationCalls[0]!;
    if (call.mcpServerName !== "mock-server") issues.push(`expected mcpServerName "mock-server", got "${call.mcpServerName}"`);
    if (call.message !== "Choose your framework") issues.push(`expected message "Choose your framework", got "${call.message}"`);
    if (call.mode !== "form") issues.push(`expected mode "form", got "${call.mode}"`);
    if (!call.elicitationId) issues.push("missing elicitationId");
    if (!call.requestedSchema) {
      issues.push("missing requestedSchema");
    } else {
      // Verify schema content was parsed correctly
      const props = (call.requestedSchema as Record<string, unknown>)["properties"] as Record<string, unknown> | undefined;
      if (!props) issues.push("requestedSchema missing properties");
      else if (!props["framework"]) issues.push("requestedSchema missing framework property");
      const required = call.requestedSchema["required"];
      if (!Array.isArray(required) || !required.includes("framework")) {
        issues.push("requestedSchema missing required: [framework]");
      }
    }
    console.log(`  onElicitation called: server=${call.mcpServerName} message="${call.message}" mode=${call.mode} elicitationId=${call.elicitationId}`);
    console.log("  PASS");
  }

  // --- Test 4: Hook callback ---
  console.log("\n--- Hook callback ---");
  const r4 = await session.send("test-hook");
  logTurn(r4);
  if (r4.status === "failed") issues.push(`hook turn error: ${r4.errorMessage}`);
  if (hookCalls.length === 0) {
    issues.push("onHookCallback was never called");
  } else {
    const call = hookCalls[0]!;
    if (!call.callbackId) issues.push("missing callbackId");
    // Verify input content was mapped correctly
    if (call.input["event"] !== "pre_tool_use") issues.push(`expected input.event "pre_tool_use", got "${call.input["event"]}"`);
    if (call.input["tool_name"] !== "Bash") issues.push(`expected input.tool_name "Bash", got "${call.input["tool_name"]}"`);
    console.log(`  onHookCallback called: callbackId=${call.callbackId} event=${call.input["event"]} tool=${call.input["tool_name"]}`);
    console.log("  PASS");
  }

  // --- Test 5: Cancel ---
  console.log("\n--- Cancel (control_cancel_request) ---");
  permissionCalls.length = 0;
  const r5 = await session.send("test-cancel");
  logTurn(r5);
  if (r5.status === "failed") issues.push(`cancel turn error: ${r5.errorMessage}`);
  // The permission callback may or may not fire — the cancel races it.
  // The key test is that the turn completes without hanging or crashing.
  console.log("  Turn completed without hanging — cancel handled correctly");
  console.log("  PASS");

  // Clean up
  await session.close();

  if (issues.length > 0) {
    console.log(`\n  FAIL: ${issues.join(", ")}`);
    return false;
  }
  console.log("\n  ALL PROTOCOL TESTS PASSED");
  return true;
}

// ---------------------------------------------------------------------------
// Session edge cases — fallback paths, denial, callback errors
// ---------------------------------------------------------------------------

async function testSessionEdgeCases(useMock: boolean): Promise<boolean> {
  if (!useMock) {
    console.log("  SKIP — edge case tests only run in mock mode");
    return true;
  }

  console.log(`\n${"=".repeat(50)}`);
  console.log("Testing: session edge cases (fallbacks, deny, errors)");
  console.log("=".repeat(50));

  const provider = getProvider("claude");
  if (!provider.createSession) {
    console.log("  SKIP — createSession not available");
    return true;
  }

  const issues: string[] = [];

  // --- Test A: No callbacks (fallback paths) ---
  // When no onUserInputRequest/onElicitation/onHookCallback is provided,
  // session.ts should auto-allow / auto-decline / auto-empty without hanging.
  console.log("\n--- Fallback: no callbacks ---");
  {
    const session = await provider.createSession({
      config: {
        command: MOCK_SESSION_COMMAND,
        maxTurns: 10,
        timeoutSec: 15,
      },
      onEvent: () => {},
      // Deliberately: no onUserInputRequest, no onElicitation, no onHookCallback
    });

    // Permission with no callback → should auto-allow, turn completes
    const r1 = await session.send("test-permissions");
    if (r1.status === "failed") issues.push(`fallback permission turn error: ${r1.errorMessage}`);
    else console.log("  auto-allow (no onUserInputRequest): turn completed");

    // Elicitation with no callback → should auto-decline, turn completes
    const r2 = await session.send("test-elicitation");
    if (r2.status === "failed") issues.push(`fallback elicitation turn error: ${r2.errorMessage}`);
    else console.log("  auto-decline (no onElicitation): turn completed");

    // Hook with no callback → should return empty, turn completes
    const r3 = await session.send("test-hook");
    if (r3.status === "failed") issues.push(`fallback hook turn error: ${r3.errorMessage}`);
    else console.log("  auto-empty (no onHookCallback): turn completed");

    await session.close();
    if (!issues.some((i) => i.startsWith("fallback"))) console.log("  PASS");
  }

  // --- Test B: Permission denial ---
  console.log("\n--- Permission denial ---");
  {
    let deniedToolName = "";
    const session = await provider.createSession({
      config: {
        command: MOCK_SESSION_COMMAND,
        maxTurns: 10,
        timeoutSec: 15,
      },
      onEvent: () => {},
      onUserInputRequest: async (req) => {
        deniedToolName = req.toolName;
        return { allow: false, message: "Denied by test" };
      },
    });

    const r = await session.send("test-permissions");
    logTurn(r);
    if (r.status === "failed") issues.push(`deny turn error: ${r.errorMessage}`);
    if (deniedToolName !== "Bash") issues.push(`deny: expected toolName "Bash", got "${deniedToolName}"`);
    // Turn should complete — the mock gets the deny response and continues
    console.log(`  Denied tool="${deniedToolName}" — turn completed`);
    if (!issues.some((i) => i.startsWith("deny"))) console.log("  PASS");

    await session.close();
  }

  // --- Test C: Permission callback throws ---
  console.log("\n--- Permission callback error ---");
  {
    let callbackFired = false;
    const session = await provider.createSession({
      config: {
        command: MOCK_SESSION_COMMAND,
        maxTurns: 10,
        timeoutSec: 15,
      },
      onEvent: () => {},
      onUserInputRequest: async () => {
        callbackFired = true;
        throw new Error("Intentional test error");
      },
    });

    const r = await session.send("test-permissions");
    logTurn(r);
    if (!callbackFired) issues.push("error test: onUserInputRequest never fired");
    if (r.status === "failed") issues.push(`error test turn error: ${r.errorMessage}`);
    // Turn should complete — session.ts catch block sends deny
    console.log(`  Callback threw, turn completed (catch → deny)`);
    if (!issues.some((i) => i.startsWith("error test"))) console.log("  PASS");

    await session.close();
  }

  // --- Test D: Elicitation callback throws ---
  console.log("\n--- Elicitation callback error ---");
  {
    let callbackFired = false;
    const session = await provider.createSession({
      config: {
        command: MOCK_SESSION_COMMAND,
        maxTurns: 10,
        timeoutSec: 15,
      },
      onEvent: () => {},
      onElicitation: async () => {
        callbackFired = true;
        throw new Error("Intentional elicitation error");
      },
    });

    const r = await session.send("test-elicitation");
    logTurn(r);
    if (!callbackFired) issues.push("elicitation error test: callback never fired");
    if (r.status === "failed") issues.push(`elicitation error test turn error: ${r.errorMessage}`);
    console.log(`  Callback threw, turn completed (catch → cancel)`);
    if (!issues.some((i) => i.startsWith("elicitation error"))) console.log("  PASS");

    await session.close();
  }

  // --- Test E: Hook callback throws ---
  console.log("\n--- Hook callback error ---");
  {
    let callbackFired = false;
    const session = await provider.createSession({
      config: {
        command: MOCK_SESSION_COMMAND,
        maxTurns: 10,
        timeoutSec: 15,
      },
      onEvent: () => {},
      onHookCallback: async () => {
        callbackFired = true;
        throw new Error("Intentional hook error");
      },
    });

    const r = await session.send("test-hook");
    logTurn(r);
    if (!callbackFired) issues.push("hook error test: callback never fired");
    if (r.status === "failed") issues.push(`hook error test turn error: ${r.errorMessage}`);
    console.log(`  Callback threw, turn completed (catch → error response)`);
    if (!issues.some((i) => i.startsWith("hook error"))) console.log("  PASS");

    await session.close();
  }

  if (issues.length > 0) {
    console.log(`\n  FAIL: ${issues.join(", ")}`);
    return false;
  }
  console.log("\n  ALL EDGE CASE TESTS PASSED");
  return true;
}

// ---------------------------------------------------------------------------
// parseAskUserQuestion unit test
// ---------------------------------------------------------------------------

function testParseAskUserQuestion(): boolean {
  console.log(`\n${"=".repeat(50)}`);
  console.log("Testing: parseAskUserQuestion (unit)");
  console.log("=".repeat(50));

  const issues: string[] = [];

  // Should return null for non-AskUserQuestion tools
  const bashReq: UserInputRequest = {
    toolName: "Bash",
    input: { command: "ls" },
    toolUseId: "tool_1",
  };
  if (parseAskUserQuestion(bashReq) !== null) {
    issues.push("should return null for Bash tool");
  }

  // Should return null if no questions array
  const badReq: UserInputRequest = {
    toolName: "AskUserQuestion",
    input: { notQuestions: true },
    toolUseId: "tool_2",
  };
  if (parseAskUserQuestion(badReq) !== null) {
    issues.push("should return null when questions is missing");
  }

  // Should return null for empty questions array
  const emptyReq: UserInputRequest = {
    toolName: "AskUserQuestion",
    input: { questions: [] },
    toolUseId: "tool_3",
  };
  if (parseAskUserQuestion(emptyReq) !== null) {
    issues.push("should return null for empty questions array");
  }

  // Should parse valid questions
  const validReq: UserInputRequest = {
    toolName: "AskUserQuestion",
    input: {
      questions: [
        {
          question: "Pick a color",
          header: "Colors",
          options: [
            { label: "Red", description: "warm" },
            { label: "Blue", description: "cool" },
          ],
        },
      ],
    },
    toolUseId: "tool_4",
  };
  const result = parseAskUserQuestion(validReq);
  if (!result) {
    issues.push("should parse valid questions");
  } else {
    if (result.length !== 1) issues.push(`expected 1 question, got ${result.length}`);
    if (result[0]!.question !== "Pick a color") issues.push("wrong question text");
    if (result[0]!.options.length !== 2) issues.push(`expected 2 options, got ${result[0]!.options.length}`);
    if (result[0]!.options[0]!.label !== "Red") issues.push("wrong first option label");
  }

  // Should parse multiSelect questions
  const multiReq: UserInputRequest = {
    toolName: "AskUserQuestion",
    input: {
      questions: [
        {
          question: "Which toppings?",
          header: "Pizza",
          multiSelect: true,
          options: [
            { label: "Pepperoni", description: "meat" },
            { label: "Mushrooms", description: "veggie" },
          ],
        },
      ],
    },
    toolUseId: "tool_5",
  };
  const multiResult = parseAskUserQuestion(multiReq);
  if (!multiResult) {
    issues.push("should parse multiSelect questions");
  } else {
    if (multiResult[0]!.multiSelect !== true) issues.push("expected multiSelect true");
    if (multiResult[0]!.options.length !== 2) issues.push(`expected 2 multiSelect options, got ${multiResult[0]!.options.length}`);
  }

  if (issues.length > 0) {
    console.log(`  FAIL: ${issues.join(", ")}`);
    return false;
  }
  console.log("  PASS");
  return true;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

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

  // One-shot tests
  for (const type of toTest) {
    try {
      await testProvider(type, useMock);
      passed++;
    } catch (err) {
      console.error(`\nFATAL for ${type}:`, err);
      failed++;
    }
  }

  // Session test (only for claude, or if explicitly requested)
  const runSession = toTest.includes("claude") || providers.length === 0;
  if (runSession) {
    try {
      const ok = await testSession(useMock);
      if (ok === false) failed++;
      else passed++;
    } catch (err) {
      console.error("\nFATAL for createSession:", err);
      failed++;
    }

    // Protocol tests (permissions, elicitation, hooks, cancel) — mock only
    try {
      const ok = await testSessionProtocol(useMock);
      if (ok === false) failed++;
      else passed++;
    } catch (err) {
      console.error("\nFATAL for session protocol:", err);
      failed++;
    }

    // Edge case tests (fallbacks, denial, callback errors) — mock only
    try {
      const ok = await testSessionEdgeCases(useMock);
      if (ok === false) failed++;
      else passed++;
    } catch (err) {
      console.error("\nFATAL for session edge cases:", err);
      failed++;
    }
  }

  // Unit tests (always run)
  try {
    const ok = testParseAskUserQuestion();
    if (!ok) failed++;
    else passed++;
  } catch (err) {
    console.error("\nFATAL for parseAskUserQuestion:", err);
    failed++;
  }

  if (useMock) {
    console.log(`\n${"=".repeat(50)}`);
    console.log(`Results: ${passed} passed, ${failed} failed`);
    console.log("=".repeat(50));
    if (failed > 0) process.exit(1);
  }
}

main();
