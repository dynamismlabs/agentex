import * as path from "node:path";
import * as os from "node:os";
import type { SkillRuntime } from "./skills.js";

/**
 * Env var that overrides the global home directory for each runtime CLI.
 * Returns null for runtimes that don't support home directory override.
 */
const ENV_VAR_MAP: Record<SkillRuntime, string | null> = {
  claude: "CLAUDE_CONFIG_DIR",
  codex: "CODEX_HOME",
  gemini: "GEMINI_CONFIG_DIR",
  cursor: "CURSOR_CONFIG_DIR",
  opencode: "XDG_CONFIG_HOME",  // affects ~/.config/opencode/
  pi: "PI_HOME",
};

/**
 * Default global home directory path for each runtime.
 */
const DEFAULT_HOME_MAP: Record<SkillRuntime, string> = {
  claude: path.join(os.homedir(), ".claude"),
  codex: path.join(os.homedir(), ".codex"),
  gemini: path.join(os.homedir(), ".gemini"),
  cursor: path.join(os.homedir(), ".cursor"),
  opencode: path.join(os.homedir(), ".config", "opencode"),
  pi: path.join(os.homedir(), ".pi"),
};

/**
 * Returns the environment variable name that overrides the global home
 * directory for the given runtime CLI tool.
 *
 * Returns null for runtimes that don't support home directory override.
 */
export function getRuntimeHomeEnvVar(runtime: SkillRuntime): string | null {
  return ENV_VAR_MAP[runtime] ?? null;
}

/**
 * Returns the default global home directory path for the given runtime.
 */
export function getDefaultRuntimeHome(runtime: SkillRuntime): string {
  return DEFAULT_HOME_MAP[runtime] ?? path.join(os.homedir(), `.${runtime}`);
}
