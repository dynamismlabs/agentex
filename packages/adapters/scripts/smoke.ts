/**
 * Smoke test — run against real local Claude and Codex.
 * Usage: pnpm smoke [claude|codex]
 */
import { getAdapter } from "../src/index.js";

async function testAdapter(type: string) {
  console.log(`\n${'='.repeat(50)}`);
  console.log(`Testing: ${type}`);
  console.log('='.repeat(50));

  const adapter = getAdapter(type);

  // 1. Environment test
  console.log('\n--- Environment Test ---');
  const envResult = await adapter.testEnvironment({
    adapterType: type,
    config: {},
  });
  console.log(`Status: ${envResult.status}`);
  for (const check of envResult.checks) {
    console.log(`  [${check.level}] ${check.code}: ${check.message}`);
  }

  if (envResult.status === 'fail') {
    console.log(`Skipping execution — environment check failed.`);
    return;
  }

  // 2. List models (if supported)
  if (adapter.listModels) {
    console.log('\n--- Models ---');
    const models = await adapter.listModels();
    console.log(
      `  Found ${models.length} models:`,
      models
        .slice(0, 5)
        .map((m) => m.id)
        .join(', '),
    );
  }

  // 3. Execute a simple prompt
  console.log('\n--- Execute ---');
  const result = await adapter.execute({
    runId: `smoke-${type}-${Date.now()}`,
    prompt: 'Respond with exactly: hello from agentex',
    cwd: process.cwd(),
    config: {
      maxTurns: 1,
      skipPermissions: true,
      timeoutSec: 30,
    },
    onOutput: (stream, chunk) => {
      if (stream === 'stdout' && chunk.trim()) {
        process.stdout.write('.');
      }
    },
    onEvent: (event) => {
      if (event.type === 'assistant') {
        console.log(`\n  [event] assistant: ${event.text.slice(0, 80)}`);
      }
    },
  });

  console.log(`\n  Exit code: ${result.exitCode}`);
  console.log(`  Timed out: ${result.timedOut}`);
  console.log(`  Model: ${result.model}`);
  console.log(`  Billing: ${result.billingType}`);
  console.log(`  Cost: ${result.costUsd != null ? `$${result.costUsd.toFixed(4)}` : 'n/a'}`);
  console.log(`  Summary: ${result.summary?.slice(0, 120)}`);
  console.log(`  Session ID: ${result.sessionDisplayId}`);
  console.log(`  Error: ${result.errorMessage ?? 'none'}`);
}

async function main() {
  const adapters = process.argv.slice(2);
  const toTest = adapters.length > 0 ? adapters : ['claude', 'codex'];

  for (const type of toTest) {
    try {
      await testAdapter(type);
    } catch (err) {
      console.error(`\nFATAL for ${type}:`, err);
    }
  }
}

main();
