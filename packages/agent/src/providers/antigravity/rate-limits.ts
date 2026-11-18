import type { RateLimitBucket, RateLimitUpdate } from "../../types.js";
import type { ResolvedBinary } from "../../utils/binary.js";
import { isoTime, nonnegative, record, textValue } from "../../utils/jsonl-lines.js";
import { runChildProcess } from "../../utils/process.js";
import { isAgyAuthRequired } from "./parse.js";

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

export async function readAntigravityQuota(
  binary: ResolvedBinary,
  cwd: string,
  env: Record<string, string>,
  signal: AbortSignal,
): Promise<RateLimitUpdate | "upgrade_required" | "signed_out" | null> {
  const run = (runId: string, args: string[]) => runChildProcess({
    runId, command: binary.bin, args: [...binary.prefixArgs, ...args], cwd, env, signal, graceSec: 1,
  });
  const version = await run("antigravity-quota-version", ["--version"]);
  if (version.exitCode !== 0) return null;
  if (!supportsLocalUsage(version.stdout || version.stderr)) return "upgrade_required";

  // Override only for this invocation. A user's disableSlashCommands setting
  // would otherwise send /usage as an inference prompt.
  const result = await run("antigravity-quota-read", [
    "--settings", '{"disableSlashCommands":false}', "--print", "/usage", "--output-format", "json",
  ]);
  if (result.exitCode !== 0) return isAgyAuthRequired(`${result.stdout}\n${result.stderr}`) ? "signed_out" : null;
  return parseAntigravityQuota(result.stdout, new Date().toISOString());
}

function parseAntigravityQuota(output: string, observedAt: string): RateLimitUpdate | null {
  let raw: unknown;
  try { raw = JSON.parse(output); } catch { return null; }
  const response = record(raw);
  const command = record(response?.command);
  const groups = record(command?.data)?.groups;
  if (response?.status !== "SUCCESS" || response.num_turns !== 0 || command?.name !== "usage" || !Array.isArray(groups)) return null;

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
      const remaining = nonnegative(bucket?.remaining_fraction);
      // Absolute balances without an allowance cannot yield a percentage.
      if (!id || remaining === undefined || remaining > 1 || bucket?.disabled === true) continue;
      const durationMs = bucket?.window === "5h" ? 5 * 3_600_000 : bucket?.window === "weekly" ? 7 * 24 * 3_600_000 : undefined;
      const name = textValue(bucket?.name)?.replace(/\s+remaining$/i, "");
      const resetAt = isoTime(bucket?.reset_time);
      buckets.push({
        id, label: durationMs || !name ? pool : `${pool} ${name}`,
        owner: { kind: "account" }, applicability: { kind: "provider_pool", pool },
        usedPercent: 100 - remaining * 100, observedAt,
        ...(durationMs !== undefined ? { durationMs } : {}), ...(resetAt ? { resetAt } : {}),
      });
    }
  }
  if (reportedBuckets && !buckets.length) return null;
  return { mode: "replace", snapshot: { provider: "antigravity", buckets, observedAt } };
}
