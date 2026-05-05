import * as path from "node:path";
import { MalformedConfigError } from "./errors.js";
import { readJsonIfExists } from "./util/fs.js";

export const CONFIG_FILENAME = "agentex.workspace.json";

export interface FromSourceConfig {
  /** Relative paths to symlink from source into the workspace. */
  link?: string[];
  /** Glob patterns (picomatch dialect) to copy from source into the workspace. */
  copy?: string[];
}

/**
 * Schema for `agentex.workspace.json`. Read from the source repo (committed,
 * shared with the team) and optionally overridden by an
 * `agentex.workspace.json` at the workspace path.
 */
export interface WorkspaceConfig {
  scripts?: Record<string, string>;
  fromSource?: FromSourceConfig;
}

/**
 * Merge a base config (typically the source-side file) with an override
 * (typically the workspace-side file).
 *
 * - `scripts`: per-key override (override's `scripts.foo` wins; base's
 *   `scripts.bar` survives if override doesn't define `bar`).
 * - `fromSource`: per-field override (override's `link` wins iff defined,
 *   else falls back to base's `link`; same for `copy`).
 */
function mergeConfigs(base: WorkspaceConfig, override: WorkspaceConfig): WorkspaceConfig {
  const merged: WorkspaceConfig = {
    scripts: { ...(base.scripts ?? {}), ...(override.scripts ?? {}) },
  };
  const baseFs = base.fromSource;
  const overrideFs = override.fromSource;
  if (baseFs || overrideFs) {
    merged.fromSource = {
      link: overrideFs?.link ?? baseFs?.link ?? [],
      copy: overrideFs?.copy ?? baseFs?.copy ?? [],
    };
  }
  return merged;
}

async function readConfigSafe(p: string): Promise<WorkspaceConfig | null> {
  try {
    return await readJsonIfExists<WorkspaceConfig>(p);
  } catch (err) {
    if (err instanceof SyntaxError) {
      throw new MalformedConfigError(p, err);
    }
    throw err;
  }
}

/**
 * Read and merge `agentex.workspace.json` from the source repo (if `source` is
 * defined and the file exists) and the workspace path (if the file exists).
 * Returns an empty config if neither file exists. Throws `MalformedConfigError`
 * if either file is present but contains invalid JSON.
 */
export async function loadWorkspaceConfig(args: {
  source: string | undefined;
  workspacePath: string;
}): Promise<WorkspaceConfig> {
  const fromSource = args.source
    ? await readConfigSafe(path.join(args.source, CONFIG_FILENAME))
    : null;
  const fromWorkspace = await readConfigSafe(path.join(args.workspacePath, CONFIG_FILENAME));

  return mergeConfigs(fromSource ?? {}, fromWorkspace ?? {});
}
