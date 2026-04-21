/**
 * Probe each provider CLI for a non-interactive model-listing subcommand.
 *
 * None of the Claude / Codex / Gemini CLIs currently expose one, so agex
 * does NOT implement listModels() for any provider — the library refuses
 * to return curated fake data. This script re-runs the probes so we know
 * when a CLI ships a real subcommand and we can wire it up.
 *
 * Usage:
 *   pnpm list-models                 # all providers
 *   pnpm list-models claude codex    # subset
 */
import { spawn } from "node:child_process";

const PROBES: Record<string, { bin: string; args: string[] }[]> = {
  claude: [
    { bin: "claude", args: ["--list-models"] },
    { bin: "claude", args: ["models"] },
  ],
  codex: [
    { bin: "codex", args: ["models"] },
    { bin: "codex", args: ["models", "list"] },
  ],
  gemini: [
    { bin: "gemini", args: ["models"] },
    { bin: "gemini", args: ["--list-models"] },
  ],
  cursor: [
    { bin: "agent", args: ["models"] },
  ],
  opencode: [
    { bin: "opencode", args: ["models"] },
  ],
  pi: [
    { bin: "pi", args: ["--list-models"] },
    { bin: "pi", args: ["models"] },
  ],
};

function runCli(
  bin: string,
  args: string[],
): Promise<{ exit: number | null; out: string; err: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    let proc;
    try {
      // detached: true puts the child in its own process group so we can
      // kill the whole tree (gemini spawns a node subprocess that otherwise
      // leaks when we kill the wrapper).
      proc = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"], detached: true });
    } catch (e) {
      resolve({ exit: null, out: "", err: e instanceof Error ? e.message : String(e), timedOut: false });
      return;
    }
    let out = "";
    let err = "";
    let timedOut = false;
    proc.stdout.on("data", (d) => (out += d.toString()));
    proc.stderr.on("data", (d) => (err += d.toString()));
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (proc.pid) process.kill(-proc.pid, "SIGKILL");
      } catch {
        proc.kill("SIGKILL");
      }
    }, 5000);
    proc.on("close", (exit) => {
      clearTimeout(timer);
      resolve({ exit, out, err, timedOut });
    });
    proc.on("error", (e) => {
      clearTimeout(timer);
      resolve({ exit: null, out, err: e.message, timedOut });
    });
  });
}

async function main() {
  const args = process.argv.slice(2);
  const targets = args.length > 0 ? args : Object.keys(PROBES);

  console.log(
    "Probing provider CLIs for model-listing subcommands.\n" +
      "agex does not ship listModels() anywhere, because none of these commands work today.\n",
  );

  for (const name of targets) {
    console.log(`=== ${name} ===`);
    const probes = PROBES[name];
    if (!probes) {
      console.log(`  (no probes defined for ${name})`);
      continue;
    }

    let anySuccess = false;
    for (const { bin, args: cliArgs } of probes) {
      const cmd = `${bin} ${cliArgs.join(" ")}`;
      const { exit, out, err, timedOut } = await runCli(bin, cliArgs);
      const status =
        exit === 0 && out.trim()
          ? "ok"
          : timedOut
            ? "TIMED OUT (5s) — CLI may be interactive"
            : `exit=${exit}`;
      console.log(`  $ ${cmd}  →  ${status}`);
      const firstStderr = err.trim().split("\n")[0];
      const firstStdout = out.trim().split("\n")[0];
      if (firstStdout) console.log(`    stdout[0]: ${firstStdout}`);
      if (firstStderr) console.log(`    stderr[0]: ${firstStderr}`);
      if (exit === 0 && out.trim()) anySuccess = true;
    }

    if (anySuccess) {
      console.log(`  ★ a probe succeeded for ${name} — consider wiring listModels() back up.`);
    }
    console.log();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
