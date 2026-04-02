/**
 * Install the test-interactive skill into the demo workspace so the Claude CLI
 * picks it up automatically when you run `claude` from that directory.
 *
 * Usage:
 *   npx tsx demo/session-demo/install-skill.ts
 *
 * After running, start Claude in the workspace:
 *   cd demo/session-demo/workspace && claude
 *   > test interactive
 */
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync } from 'node:fs';
import { installSkills } from '../../packages/agent/src/index.js';

const run = async () => {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const workspaceDir = join(__dirname, 'workspace');
  mkdirSync(workspaceDir, { recursive: true });

  const skillDir = join(__dirname, 'skills', 'test-interactive');

  const result = await installSkills([skillDir], {
    location: 'workspace',
    cwd: workspaceDir,
  });

  for (const entry of result.entries) {
    console.log(`${entry.status}: ${entry.skillName} → ${entry.targetPath}`);
  }

  console.log(`\nInstalled ${result.installed}, skipped ${result.skipped}`);
  console.log(`\nNow run: cd demo/session-demo/workspace && claude`);
  console.log(`Then type: test interactive`);
};

run();
