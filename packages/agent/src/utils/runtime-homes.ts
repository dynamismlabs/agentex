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
 * Home directory subpath (relative to the home base) for each runtime.
 */
const HOME_SUBPATH_MAP: Record<SkillRuntime, string[]> = {
  claude: [".claude"],
  codex: [".codex"],
  gemini: [".gemini"],
  cursor: [".cursor"],
  opencode: [".config", "opencode"],
  pi: [".pi"],
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
 *
 * Pass `homeDir` to resolve against a base other than the user's real home
 * directory (useful for sandboxed installs and tests). Defaults to os.homedir().
 */
export function getDefaultRuntimeHome(runtime: SkillRuntime, homeDir: string = os.homedir()): string {
  const subpath = HOME_SUBPATH_MAP[runtime] ?? [`.${runtime}`];
  return path.join(homeDir, ...subpath);
}
