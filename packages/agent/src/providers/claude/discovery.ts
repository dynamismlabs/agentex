/**
 * Claude Code model and effort discovery.
 *
 * Claude Code ships no catalog subcommand and its SDK init frame reports only
 * the resolved model, so there is nothing to read the way `codex debug models`
 * can be read. What the CLI *will* do is validate `--model` and `--effort`
 * eagerly, before any API call, and say so on stderr when it does not
 * recognize a value. That turns discovery into two different jobs:
 *
 *   Efforts are enumerable. `--help` prints the accepted values inline, so the
 *   installed binary names them itself. Values it accepts but omits from help
 *   (`ultracode` today) are recovered by probing the canonical list.
 *
 *   Models are not enumerable. Probing can only answer "do you know this one?"
 *   for names we already ship, so `CLAUDE_MODEL_CANDIDATES` stays a curated
 *   list. What probing buys is that a name the installed CLI does not know is
 *   dropped instead of offered and silently ignored at run time.
 *
 * Probes run with `--bare` when the binary supports it. The reason is side
 * effects, not speed: `--bare` skips hooks, LSP, plugin sync, auto-memory, and
 * keychain reads, so asking "do you know this flag value" cannot fire a user's
 * SessionStart hook four times. Argument validation still runs under it.
 * Probes also pass `-p ""`, so the process exits on empty input long before it
 * would reach the network. No probe costs a token.
 *
 * Budget: two serial spawns, then one concurrent batch. `--help` and the
 * control probe below are each on the critical path; only the per-candidate
 * probes run in parallel. Measured cold against 2.1.232 that is ~1.8-3s
 * depending on machine load, against ~0.1s for Codex's single-command
 * catalog.
 * Worth caching for minutes rather than seconds: callers should pass
 * `cacheTtlMs` and keep a static fallback for first paint rather than blocking
 * a picker on this.
 */
import type { ListModelsOptions, ProviderModel } from "../../types.js";
import { findBinary, type ResolvedBinary } from "../../utils/binary.js";
import { buildEnv, ensurePathInEnv } from "../../utils/env.js";
import { runChildProcess } from "../../utils/process.js";
import { withModelCache } from "../../utils/model-cache.js";
import { CLAUDE_EFFORTS, claudeEffortFlagValue, claudeEffortFromFlagValue } from "./effort.js";

/**
 * Tier aliases rather than pinned versions, so each one keeps meaning "the
 * newest model in this tier" and the list does not rot between releases. A
 * genuinely new tier is one line here, gated by the probe so older CLIs that
 * have never heard of it simply do not show it.
 */
export const CLAUDE_MODEL_CANDIDATES: ReadonlyArray<{ id: string; name: string; description: string }> = [
  { id: "opus", name: "Opus", description: "Always resolves to the newest Opus release" },
  { id: "sonnet", name: "Sonnet", description: "Always resolves to the newest Sonnet release" },
  { id: "haiku", name: "Haiku", description: "Always resolves to the newest Haiku release" },
  { id: "fable", name: "Fable", description: "Always resolves to the newest Fable release" },
];

/**
 * The error a probe earns when the flag value was accepted: the CLI got far
 * enough to care that the prompt was empty. Treated as the positive signal so
 * an unexpected failure (missing binary, unknown flag, changed wording) reads
 * as "unsupported" rather than "supported". Discovery that fails open would
 * offer values the CLI then ignores, which is the exact failure this replaces.
 */
const ACCEPTED = /input must be provided/i;
const UNKNOWN_EFFORTS = /unknown --effort value/i;
const UNKNOWN_MODEL = /is not a model this version of claude code recognizes/i;

/**
 * Read the effort values `--help` advertises.
 *
 * The option's accepted list is rendered inline and commander wraps it onto a
 * continuation line, so the scan joins whitespace and stops at the next flag
 * to avoid swallowing a later option's parenthetical.
 */
export function claudeEffortsFromHelp(output: string): string[] {
  const index = output.indexOf("--effort");
  if (index === -1) return [];
  const tail = output.slice(index + "--effort".length);
  const stop = tail.search(/\n\s*(?:-[a-z]|--[a-z])/i);
  const block = (stop === -1 ? tail : tail.slice(0, stop)).replace(/\s+/g, " ");
  const list = block.match(/\(([^)]+)\)/);
  if (!list?.[1]) return [];
  const values = list[1]
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter((value) => /^[a-z][a-z0-9-]*$/.test(value));
  return [...new Set(values.map(claudeEffortFromFlagValue))];
}

/** Order a discovered set by the canonical ladder, unknown values last. */
function ordered(values: Iterable<string>): string[] {
  const seen = [...new Set(values)];
  const rank = (value: string) => {
    const index = (CLAUDE_EFFORTS as readonly string[]).indexOf(value);
    return index === -1 ? CLAUDE_EFFORTS.length : index;
  };
  return seen.sort((left, right) => rank(left) - rank(right));
}

interface ClaudeBinary {
  resolved: ResolvedBinary;
  env: Record<string, string>;
  cwd: string;
}

interface ProbeRuntime extends ClaudeBinary {
  /** Whether the binary is new enough for `--bare` (see the file header). */
  bare: boolean;
  /** `--help` output, already paid for while detecting `--bare`. */
  help: string;
}

async function runClaude(runtime: ClaudeBinary, args: string[], timeoutSec = 30): Promise<string> {
  const result = await runChildProcess({
    runId: "claude-discovery",
    command: runtime.resolved.bin,
    args: [...runtime.resolved.prefixArgs, ...args],
    cwd: runtime.cwd,
    env: runtime.env,
    timeoutSec,
  });
  return `${result.stdout}\n${result.stderr}`;
}

async function probeFlag(
  runtime: ProbeRuntime,
  flag: "--model" | "--effort",
  value: string,
): Promise<boolean> {
  const output = await runClaude(
    runtime,
    [...(runtime.bare ? ["--bare"] : []), flag, value, "-p", ""],
  );
  if (!ACCEPTED.test(output)) return false;
  return !(flag === "--effort" ? UNKNOWN_EFFORTS : UNKNOWN_MODEL).test(output);
}

/**
 * Prove the probe mechanism itself still works, with no flag under test.
 *
 * Without this, an empty result is ambiguous: it means both "this CLI
 * recognizes none of our candidates" and "the probe broke" — a renamed flag, a
 * reworded error, a binary that will not start. Failing closed only helps if
 * the caller can tell those apart, and it cannot: falling back to a static list
 * on a broken probe offers exactly the unvalidated names that failing open
 * would have. So a broken mechanism throws, and an empty list becomes a real
 * answer rather than a shrug.
 */
async function probeMechanismWorks(runtime: ProbeRuntime): Promise<boolean> {
  const output = await runClaude(runtime, [...(runtime.bare ? ["--bare"] : []), "-p", ""]);
  return ACCEPTED.test(output);
}

/**
 * Effort values the installed binary accepts, in canonical vocabulary.
 *
 * Exported separately because efforts are a property of the CLI rather than of
 * any one model: Claude takes a single `--effort` flag and applies it to
 * whatever model the turn runs on.
 */
export async function listClaudeEfforts(options: ListModelsOptions = {}): Promise<string[]> {
  const runtime = await probeRuntime(options);
  if (!await probeMechanismWorks(runtime)) {
    throw new Error("Claude Code effort discovery failed: the CLI did not respond as expected to a probe");
  }
  return discoverEfforts(runtime);
}

async function probeRuntime(options: ListModelsOptions): Promise<ProbeRuntime> {
  const resolved = await findBinary("claude", options.config?.command);
  const env = buildEnv(options.env);
  ensurePathInEnv(env);
  const base: ClaudeBinary = { resolved, env, cwd: options.cwd ?? process.cwd() };
  // One spawn answers two questions: which efforts the binary advertises, and
  // whether it understands `--bare` well enough to probe without side effects.
  const help = await runClaude(base, ["--help"], 15);
  return { ...base, bare: /--bare\b/.test(help), help };
}

async function discoverEfforts(runtime: ProbeRuntime): Promise<string[]> {
  const advertised = claudeEffortsFromHelp(runtime.help);
  // Anything help omits still gets a probe, so a value the CLI accepts without
  // documenting is not lost. When help parsing yields nothing this degrades to
  // probing the whole ladder rather than to returning nothing.
  const unlisted: string[] = CLAUDE_EFFORTS.filter((effort) => !advertised.includes(effort));
  const confirmed = await Promise.all(
    unlisted.map(async (effort) => (
      await probeFlag(runtime, "--effort", claudeEffortFlagValue(effort)) ? effort : null
    )),
  );
  return ordered([...advertised, ...confirmed.filter((effort): effort is string => effort !== null)]);
}

export async function listClaudeModels(options: ListModelsOptions = {}): Promise<ProviderModel[]> {
  return withModelCache("claude", options, options.cacheTtlMs, async () => {
    const runtime = await probeRuntime(options);
    // Throwing rather than returning [] keeps "no models" meaningful. Callers
    // already treat a discovery failure as "use your fallback catalog".
    if (!await probeMechanismWorks(runtime)) {
      throw new Error("Claude Code model discovery failed: the CLI did not respond as expected to a probe");
    }
    const [supportedEfforts, recognized] = await Promise.all([
      discoverEfforts(runtime),
      Promise.all(CLAUDE_MODEL_CANDIDATES.map(async (candidate) => (
        await probeFlag(runtime, "--model", candidate.id) ? candidate : null
      ))),
    ]);
    return recognized
      .filter((candidate): candidate is (typeof CLAUDE_MODEL_CANDIDATES)[number] => candidate !== null)
      .map((candidate) => ({
        id: candidate.id,
        name: candidate.name,
        description: candidate.description,
        ...(supportedEfforts.length > 0 ? { supportedEfforts } : {}),
      }));
  });
}
