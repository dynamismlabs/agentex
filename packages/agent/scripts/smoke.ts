/**
 * Smoke test — run against real local Claude and Codex.
 * Usage: pnpm smoke [claude|codex]
 */
import { getProvider } from "../src/index.js";

async function testProvider(type: string) {
  console.log(`\n${'='.repeat(50)}`);
  console.log(`Testing: ${type}`);
  console.log('='.repeat(50));

  const provider = getProvider(type);

  // 1. Environment test
  console.log('\n--- Environment Test ---');
  const envResult = await provider.testEnvironment({
    providerType: type,
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
  if (provider.listModels) {
    console.log('\n--- Models ---');
    const models = await provider.listModels();
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
  const result = await provider.execute({
    prompt: 'Respond with exactly: hello from agentex',
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
  console.log(`  Duration: ${(result.durationMs / 1000).toFixed(1)}s`);
  console.log(`  Model: ${result.model}`);
  console.log(`  Billing: ${result.billingType}`);
  console.log(`  Cost: ${result.costUsd != null ? `$${result.costUsd.toFixed(4)}` : 'n/a'}`);
  if (result.usage) {
    console.log(`  Tokens: ${result.usage.inputTokens} in / ${result.usage.outputTokens} out${result.usage.cachedInputTokens ? ` (${result.usage.cachedInputTokens} cached)` : ''}`);
  }
  console.log(`  Summary: ${result.summary?.slice(0, 120)}`);
  console.log(`  Session ID: ${result.sessionDisplayId}`);
  console.log(`  Error: ${result.errorMessage ?? 'none'}`);
}

async function main() {
  const providers = process.argv.slice(2);
  const toTest = providers.length > 0 ? providers : ['claude', 'codex'];

  for (const type of toTest) {
    try {
      await testProvider(type);
    } catch (err) {
      console.error(`\nFATAL for ${type}:`, err);
    }
  }
}

main();
