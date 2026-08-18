/**
 * Reasoning-effort vocabulary for Claude Code.
 *
 * `ProviderConfig.effort` is one shared scale across providers, but the CLIs
 * do not agree on what to call its top rung: Codex accepts `ultra`, Claude
 * accepts `ultracode`. Translating at the flag boundary keeps that difference
 * out of every caller.
 *
 * This is not cosmetic. `claude --effort ultra` does not fail — it prints a
 * warning to stderr and runs the turn at the session default. An untranslated
 * value is therefore a silent downgrade, indistinguishable at the API surface
 * from having worked.
 */

/** Canonical effort ids, weakest to strongest, in the shared vocabulary. */
export const CLAUDE_EFFORTS = ["low", "medium", "high", "xhigh", "max", "ultra"] as const;

/** Canonical id -> the token `claude --effort` accepts. Identity when absent. */
const WIRE_VALUES: Record<string, string> = {
  ultra: "ultracode",
};

/** The token to pass to `--effort` for a canonical effort id. */
export function claudeEffortFlagValue(effort: string): string {
  return WIRE_VALUES[effort] ?? effort;
}

/** Inverse of `claudeEffortFlagValue`, for reading a CLI-advertised list. */
export function claudeEffortFromFlagValue(value: string): string {
  for (const [canonical, wire] of Object.entries(WIRE_VALUES)) {
    if (wire === value) return canonical;
  }
  return value;
}
