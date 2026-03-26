/**
 * Skills Demo — shows how to install, inspect, and remove skills
 * across multiple agent runtimes.
 *
 * Usage: npx tsx demo/skills-demo/demo.ts [install|list|remove|run]
 */
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  installSkills,
  removeSkills,
  listInstalledSkills,
  getProvider,
  listProviders,
} from "../../src/index.js";
import type { SkillRuntime } from "../../src/utils/skills.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SKILL_DIRS = [
  path.resolve(__dirname, "skills/code-style"),
  path.resolve(__dirname, "skills/testing"),
  path.resolve(__dirname, "skills/security"),
];

const INSPECTABLE_RUNTIMES: SkillRuntime[] = ["gemini", "cursor", "opencode", "pi"];

async function install() {
  console.log("Installing skills for all agent runtimes...\n");

  const result = await installSkills(SKILL_DIRS, { cwd: process.cwd() });

  for (const entry of result.entries) {
    const icon = entry.status === "created" ? "+" : entry.status === "skipped" ? "=" : "!";
    console.log(`  [${icon}] ${entry.runtime}/${entry.skillName} — ${entry.status}`);
  }

  console.log(`\nDone: ${result.installed} installed, ${result.skipped} unchanged, ${result.conflicts} conflicts, ${result.errors} errors`);
}

async function list() {
  console.log("Installed skills by runtime:\n");

  for (const runtime of INSPECTABLE_RUNTIMES) {
    const skills = await listInstalledSkills(runtime);
    if (skills.length === 0) {
      console.log(`  ${runtime}: (none)`);
    } else {
      console.log(`  ${runtime}:`);
      for (const skill of skills) {
        const tag = skill.isSymlink ? "symlink" : "directory";
        console.log(`    - ${skill.name} [${tag}] -> ${skill.sourcePath}`);
      }
    }
  }

  // Also check codex workspace
  const codexSkills = await listInstalledSkills("codex", process.cwd());
  if (codexSkills.length > 0) {
    console.log(`  codex (workspace):`);
    for (const skill of codexSkills) {
      const tag = skill.isSymlink ? "symlink" : "directory";
      console.log(`    - ${skill.name} [${tag}] -> ${skill.sourcePath}`);
    }
  }
}

async function remove() {
  console.log("Removing skills from all agent runtimes...\n");

  const result = await removeSkills(SKILL_DIRS, { cwd: process.cwd() });

  for (const entry of result.entries) {
    const icon = entry.status === "removed" ? "-" : entry.status === "not_found" ? "?" : "!";
    console.log(`  [${icon}] ${entry.runtime}/${entry.skillName} — ${entry.status}`);
  }

  console.log(`\nDone: ${result.removed} removed`);
}

async function run() {
  // Install skills first
  console.log("Installing skills...");
  const installResult = await installSkills(SKILL_DIRS, { cwd: process.cwd() });
  console.log(`Installed ${installResult.installed} skills (${installResult.skipped} unchanged)\n`);

  // Pick the first available provider
  const preferredOrder = ["claude", "codex", "gemini", "opencode", "pi"];
  const available = listProviders();
  const providerType = preferredOrder.find((p) => available.includes(p)) ?? "claude";

  console.log(`Running ${providerType} with skills loaded...\n`);

  const provider = getProvider(providerType);

  // Check environment first
  const envCheck = await provider.testEnvironment({ providerType, config: {} });
  if (envCheck.status === "fail") {
    console.log(`Environment check failed for ${providerType}:`);
    for (const check of envCheck.checks) {
      console.log(`  [${check.level}] ${check.message}`);
    }
    console.log("\nTry: npx tsx demo/skills-demo/demo.ts install");
    console.log("Then run an agent manually to see skills in action.");
    return;
  }

  const result = await provider.execute({
    prompt: "Write a short TypeScript function that reads a user-provided file path and returns its contents. Apply all your loaded skills.",
    config: {
      skillDirs: SKILL_DIRS,
      maxTurns: 1,
      skipPermissions: true,
      timeoutSec: 60,
    },
    onEvent: (event) => {
      if (event.type === "assistant") {
        process.stdout.write(event.text);
      }
    },
  });

  console.log(`\n\n--- Result ---`);
  console.log(`Exit: ${result.exitCode}, Duration: ${(result.durationMs / 1000).toFixed(1)}s`);
  if (result.costUsd != null) console.log(`Cost: $${result.costUsd.toFixed(4)}`);
  if (result.errorMessage) console.log(`Error: ${result.errorMessage}`);
}

async function main() {
  const command = process.argv[2] ?? "install";

  switch (command) {
    case "install":
      await install();
      break;
    case "list":
      await list();
      break;
    case "remove":
      await remove();
      break;
    case "run":
      await run();
      break;
    default:
      console.log("Usage: npx tsx demo/skills-demo/demo.ts [install|list|remove|run]");
      console.log("\nCommands:");
      console.log("  install  Install skills into all agent discovery directories");
      console.log("  list     Show installed skills per runtime");
      console.log("  remove   Remove skills from all agent discovery directories");
      console.log("  run      Install skills and run a prompt with the first available agent");
  }
}

main().catch(console.error);
