import * as path from "node:path";
import type { AgentMode, ProviderConfig, ProviderRuntimeContext } from "../../types.js";
import { findBinary, type ResolvedBinary } from "../../utils/binary.js";

/** Running `agy` with no arguments signs in through the browser. */
export const AGY_LOGIN_COMMAND = "agy";

export const AGY_SIGN_IN_MESSAGE = "Antigravity CLI is not signed in. Run `agy` once to sign in.";

export function findAgyBinary(ctx: ProviderRuntimeContext = {}): Promise<ResolvedBinary> {
  return findBinary("agy", ctx.config?.command);
}

/**
 * The CLI's execution modes (`--mode`). `default` is request-review: file
 * edits wait for approval, which headless runs settle by policy. Shell
 * commands follow the permission rules in every mode.
 */
export const ANTIGRAVITY_MODES: AgentMode[] = [
  { id: "default", name: "Default", description: "Review file edits before they are applied" },
  { id: "accept-edits", name: "Accept edits", description: "Apply file edits without asking" },
  { id: "plan", name: "Plan", description: "Investigate read-only and propose a plan before editing" },
];

/** The `--mode` value for a config, or null for the CLI default. */
export function resolveAgyMode(config: ProviderConfig): string | null {
  if (config.planMode) return "plan";
  const requested = config.modeId ?? config.mode;
  if (!requested || requested === "default") return null;
  return requested;
}

/**
 * Arguments for a headless `agy` process that reads user messages as NDJSON
 * on stdin and writes `stream-json` events. One process serves a whole
 * session; one-shot runs write a single message and close stdin.
 */
export function buildAgyArgs(config: ProviderConfig, options: { resumeId: string | null; model: string | null }): string[] {
  const args = ["--input-format", "stream-json", "--output-format", "stream-json"];
  if (options.resumeId) args.push("--conversation", options.resumeId);
  if (options.model) args.push("--model", options.model);
  if (config.effort) args.push("--effort", config.effort);
  const mode = resolveAgyMode(config);
  if (mode) args.push("--mode", mode);
  // Plan mode is the more conservative intent and wins over skipPermissions.
  if (config.skipPermissions && !config.planMode) args.push("--dangerously-skip-permissions");
  if (config.sandbox) args.push("--sandbox");
  if (config.extraArgs) args.push(...config.extraArgs);
  return args;
}

/**
 * The conversation to resume from saved params, or null. Antigravity scopes
 * conversations to the directory they ran in, so params saved under a
 * different cwd start fresh instead of resuming somewhere unexpected.
 */
export function readAgyResumeId(params: Record<string, unknown> | null | undefined, cwd: string): string | null {
  if (!params) return null;
  const id = params["sessionId"] ?? params["session_id"] ?? params["conversationId"];
  if (typeof id !== "string" || !id.trim()) return null;
  const savedCwd = params["cwd"];
  if (typeof savedCwd === "string" && savedCwd && path.resolve(savedCwd) !== path.resolve(cwd)) return null;
  return id.trim();
}
