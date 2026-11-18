import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RateLimitBucket, RateLimitUpdate } from "../../types.js";
import type { ResolvedBinary } from "../../utils/binary.js";
import { isoTime, nonnegative, record, textValue } from "../../utils/jsonl-lines.js";
import { runChildProcess } from "../../utils/process.js";
import { isAgyAuthRequired } from "./parse.js";

export type AntigravityQuotaRead = RateLimitUpdate | "upgrade_required" | "signed_out" | "not_reported" | null;

/** Antigravity 1.1.11 introduced a local print-mode /usage command. Older
 * builds can send the text to the model, so verify the version first. */
function supportsLocalUsage(output: string): boolean {
  const version = output.trim().match(/^v?(\d+)\.(\d+)\.(\d+)(-[\w.-]+)?(?:\+[\w.-]+)?$/);
  if (!version) return false;
  const [, major, minor, patch, prerelease] = version;
  if (major !== "1") return Number(major) > 1;
  if (minor !== "1") return Number(minor) > 1;
  return Number(patch) > 11 || (patch === "11" && !prerelease);
}

/**
 * Quota belongs to the account, not a folder, so `agy` runs in a private
 * empty folder: the caller's project skills and settings cannot apply.
 */
export async function readAntigravityQuota(
  binary: ResolvedBinary,
  env: Record<string, string>,
  signal: AbortSignal,
): Promise<AntigravityQuotaRead> {
  const cwd = await mkdtemp(join(tmpdir(), "agentex-agy-quota-"));
  // A passive read must not start agy's self-update (only the literal "true" disables it).
  const childEnv = { ...env, AGY_CLI_DISABLE_AUTO_UPDATE: "true" };
  const run = async (runId: string, args: string[]) => {
    let pid: number | undefined;
    const result = await runChildProcess({
      runId, command: binary.bin, args: [...binary.prefixArgs, ...args], cwd, env: childEnv, signal, graceSec: 1,
      onStart: (started) => { pid = started; },
    });
    if (pid !== undefined) endLeftoverProcesses(pid);
    return result;
  };
  try {
    const version = await run("antigravity-quota-version", ["--version"]);
    if (version.exitCode !== 0) return null;
    if (!supportsLocalUsage(version.stdout || version.stderr)) return "upgrade_required";

    // Override only for this invocation. A user's disableSlashCommands setting
    // would otherwise send /usage as an inference prompt.
    const result = await run("antigravity-quota-read", [
      "--settings", '{"disableSlashCommands":false}', "--print", "/usage", "--output-format", "json",
    ]);
    if (result.exitCode !== 0) {
      if (isAgyAuthRequired(`${result.stdout}\n${result.stderr}`)) return "signed_out";
      // Exit 2 is permanent: API-key sign-in has no account quota (1.5.11), or the CLI lacks a flag.
      return result.exitCode === 2 ? "not_reported" : null;
    }
    return parseAntigravityQuota(result.stdout, new Date().toISOString());
  } finally {
    await rm(cwd, { recursive: true, force: true }).catch(() => { /* Best effort. */ });
  }
}

/**
 * `agy` starts the user's MCP servers even for /usage and exits without
 * stopping them. They share its process group (the child runs as a group
 * leader), so end the group once it exits. Windows has no process groups.
 */
function endLeftoverProcesses(groupId: number): void {
  if (process.platform === "win32") return;
  const signalGroup = (signal: NodeJS.Signals) => {
    try { process.kill(-groupId, signal); return true; } catch { return false; }
  };
  if (!signalGroup("SIGTERM")) return;
  setTimeout(() => signalGroup("SIGKILL"), 1_000).unref();
}

function parseAntigravityQuota(output: string, observedAt: string): RateLimitUpdate | null {
  let raw: unknown;
  try { raw = JSON.parse(output); } catch { return null; }
  const response = record(raw);
  const command = record(response?.command);
  const groups = record(command?.data)?.groups;
  if (response?.status !== "SUCCESS" || response.num_turns !== 0 || command?.name !== "usage" || !Array.isArray(groups)) return null;
  const shown = textReportRemaining(response.response);

  const buckets: RateLimitBucket[] = [];
  let reportedBuckets = 0;
  for (const group of groups) {
    const entry = record(group);
    const pool = textValue(entry?.name);
    if (!pool || !Array.isArray(entry?.buckets)) return null;
    reportedBuckets += entry.buckets.length;
    for (const rawBucket of entry.buckets) {
      const bucket = record(rawBucket);
      const id = textValue(bucket?.id);
      if (!bucket || !id || bucket.disabled === true) continue;
      const name = textValue(bucket.name);
      const window = textValue(bucket.window);
      // agy declares remaining_fraction omitempty, so an empty pool's zero can
      // be missing. Its text report still prints that bucket's percentage.
      const remaining = "remaining_fraction" in bucket ? fraction(bucket.remaining_fraction)
        : name ? shown.get(`${pool}\t${name}`) ?? undefined : undefined;
      // Malformed fractions and absolute balances cannot yield a percentage. An
      // allowance window with no figure anywhere stays, without a guessed one.
      if (remaining === undefined && ("remaining_fraction" in bucket || !window || "remaining_amount" in bucket)) continue;
      const durationMs = window === "5h" ? 5 * 3_600_000 : window === "weekly" ? 7 * 24 * 3_600_000 : undefined;
      const resetAt = isoTime(bucket.reset_time);
      buckets.push({
        id, label: durationMs || !name ? pool : `${pool} ${name.replace(/\s+remaining$/i, "")}`,
        owner: { kind: "account" }, applicability: { kind: "provider_pool", pool },
        ...(remaining !== undefined ? { usedPercent: Math.round((1 - remaining) * 10_000) / 100 } : {}),
        observedAt, ...(durationMs !== undefined ? { durationMs } : {}), ...(resetAt ? { resetAt } : {}),
      });
    }
  }
  if (reportedBuckets && !buckets.length) return null;
  return { mode: "replace", snapshot: { provider: "antigravity", buckets, observedAt } };
}

function fraction(value: unknown): number | undefined {
  const remaining = nonnegative(value);
  return remaining !== undefined && remaining <= 1 ? remaining : undefined;
}

/**
 * Remaining fractions from the report's text lines, `<group>\t<bucket>\t<n>%\t<reset>`,
 * keyed by group and bucket name. A repeated key is ambiguous and maps to null.
 */
function textReportRemaining(text: unknown): Map<string, number | null> {
  const rows = new Map<string, number | null>();
  for (const line of typeof text === "string" ? text.split("\n") : []) {
    const [group, name, shown] = line.split("\t");
    const percent = /^(\d{1,3}(?:\.\d+)?)%$/.exec(shown?.trim() ?? "")?.[1];
    if (!group || !name || percent === undefined || Number(percent) > 100) continue;
    const key = `${group}\t${name}`;
    rows.set(key, rows.has(key) ? null : Number(percent) / 100);
  }
  return rows;
}
