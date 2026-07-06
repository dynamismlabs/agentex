/**
 * measure-import — a tool (not a test) for the §8 acceptance table.
 *
 * For each public entry point it reports, in a fresh child Node process:
 *   - import time in ms (best of N runs, to shed GC / FS-cache noise)
 *   - the number of the package's own `dist/**` modules pulled into the graph
 *     (via the load-recorder hook in tests/packaging)
 *
 * Usage:  pnpm -C packages/agent exec tsx scripts/measure-import.ts
 */
import { execFileSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, "..");
const registerHooks = resolve(pkgRoot, "tests", "packaging", "register-hooks.mjs");

const PROVIDERS = [
  "claude", "codex", "cursor", "openclaw", "opencode",
  "pi", "process", "acp", "gemini", "copilot",
];

const ENTRIES: Array<[label: string, specifier: string]> = [
  ["barrel (.)", "@agentex/agent"],
  ["./registry", "@agentex/agent/registry"],
  ["./utils/ask-user-question", "@agentex/agent/utils/ask-user-question"],
  ...PROVIDERS.map(
    (p) => [`./providers/${p}`, `@agentex/agent/providers/${p}`] as [string, string],
  ),
];

const RUNS = 5;

function timeImport(specifier: string): number {
  const probe = `const t = performance.now(); await import(${JSON.stringify(
    specifier,
  )}); process.stdout.write(String(performance.now() - t));`;
  const out = execFileSync(process.execPath, ["--input-type=module", "-e", probe], {
    cwd: pkgRoot,
    encoding: "utf8",
  });
  return Number(out);
}

function distModuleCount(specifier: string): number {
  const log = join(tmpdir(), `measure-${process.pid}-${ENTRIES.length}-${specifier.replace(/\W+/g, "_")}.txt`);
  rmSync(log, { force: true });
  try {
    execFileSync(
      process.execPath,
      ["--import", registerHooks, "--input-type=module", "-e", `await import(${JSON.stringify(specifier)});`],
      { cwd: pkgRoot, env: { ...process.env, AGENTEX_LOAD_LOG: log }, stdio: "pipe" },
    );
    const urls = readFileSync(log, "utf8").split("\n").filter(Boolean);
    return urls.filter((u) => u.includes("/dist/")).length;
  } finally {
    rmSync(log, { force: true });
  }
}

function main(): void {
  const rows: Array<{ entry: string; ms: string; modules: string }> = [];
  for (const [label, specifier] of ENTRIES) {
    let best = Infinity;
    let ok = true;
    for (let i = 0; i < RUNS; i++) {
      try {
        best = Math.min(best, timeImport(specifier));
      } catch {
        ok = false;
        break;
      }
    }
    if (!ok) {
      rows.push({ entry: label, ms: "ERROR", modules: "—" });
      continue;
    }
    rows.push({
      entry: label,
      ms: best.toFixed(1),
      modules: String(distModuleCount(specifier)),
    });
  }

  const w1 = Math.max(5, ...rows.map((r) => r.entry.length));
  const w2 = Math.max(9, ...rows.map((r) => r.ms.length));
  const w3 = Math.max(12, ...rows.map((r) => r.modules.length));
  const line = (a: string, b: string, c: string) =>
    `| ${a.padEnd(w1)} | ${b.padStart(w2)} | ${c.padStart(w3)} |`;
  console.log(line("Entry", `min ms/${RUNS}`, "dist modules"));
  console.log(`| ${"-".repeat(w1)} | ${"-".repeat(w2)} | ${"-".repeat(w3)} |`);
  for (const r of rows) console.log(line(r.entry, r.ms, r.modules));
}

main();
