import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import type { SkillRuntime } from "./skills.js";
import { getRuntimeHomeEnvVar, getDefaultRuntimeHome } from "./runtime-homes.js";
import { uuidv7 } from "./uuid.js";

export interface TempConfigResult {
  /** Environment variables to pass to the child process (includes the
   *  runtime home env var pointing at the temp config dir). */
  env: Record<string, string>;
  /** Path to the temporary config directory. */
  configDir: string;
  /** Remove the temporary config directory. */
  cleanup(): Promise<void>;
}

export interface TempConfigOptions {
  /** Which runtime CLI tool to configure. */
  runtime: SkillRuntime;
  /** Base environment to extend. */
  env?: Record<string, string>;
  /** If true, copy the contents of the default home into the temp dir
   *  before applying overrides. Defaults to false. */
  seedFromDefault?: boolean;
  /** Files to write into the temp config dir (relative paths → content). */
  overrides?: Record<string, string>;
}

/**
 * Create a temporary config directory for a CLI runtime, optionally seeded
 * from the user's default home, with arbitrary file overrides applied.
 *
 * Returns an env object with the runtime home env var pointed at the temp dir,
 * and a cleanup function to remove the temp dir when done.
 *
 * This is useful for running a CLI tool with custom configuration (e.g.
 * injecting system prompts, custom settings) without modifying the user's
 * real config directory.
 */
export async function withTempConfig(options: TempConfigOptions): Promise<TempConfigResult> {
  const { runtime, seedFromDefault, overrides } = options;

  const envVarName = getRuntimeHomeEnvVar(runtime);
  const shortId = uuidv7().slice(0, 8);
  const configDir = path.join(os.tmpdir(), `agentex-cfg-${runtime}-${shortId}`);

  await fs.mkdir(configDir, { recursive: true });

  // Seed from the user's default home if requested
  if (seedFromDefault) {
    const defaultHome = getDefaultRuntimeHome(runtime);
    try {
      await copyDir(defaultHome, configDir);
    } catch {
      // Default home may not exist — non-fatal
    }
  }

  // Apply overrides
  if (overrides) {
    for (const [relativePath, content] of Object.entries(overrides)) {
      const target = path.join(configDir, relativePath);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, content, "utf-8");
    }
  }

  // Build env with the runtime home pointing to our temp dir
  const env = { ...(options.env ?? {}) };
  if (envVarName) {
    env[envVarName] = configDir;
  }

  return {
    env,
    configDir,
    async cleanup(): Promise<void> {
      await fs.rm(configDir, { recursive: true, force: true });
    },
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function copyDir(src: string, dest: string): Promise<void> {
  const entries = await fs.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      await fs.mkdir(destPath, { recursive: true });
      await copyDir(srcPath, destPath);
    } else {
      await fs.copyFile(srcPath, destPath);
    }
  }
}
