import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

export type SkillRuntime = "claude" | "codex" | "gemini" | "cursor" | "opencode" | "pi";

export type SkillLocation = "global" | "workspace";

/**
 * The two standard skill discovery channels:
 * - "agents": ~/.agents/skills/ or {cwd}/.agents/skills/ — scanned by Codex, Gemini, Cursor, OpenCode, Pi
 * - "claude": ~/.claude/skills/ or {cwd}/.claude/skills/ — scanned by Claude Code (the only agent that doesn't scan .agents/)
 */
export type SkillChannel = "agents" | "claude";

/**
 * Native per-runtime directories. Only used when includeNativeDirs is enabled.
 * These are in addition to the two standard channels.
 * Claude and Codex are excluded since they ARE the standard channels.
 */
const NATIVE_DIRS: Record<string, { global: string; workspace: (cwd: string) => string }> = {
  gemini: {
    global: path.join(os.homedir(), ".gemini", "skills"),
    workspace: (cwd) => path.join(cwd, ".gemini", "skills"),
  },
  cursor: {
    global: path.join(os.homedir(), ".cursor", "skills"),
    workspace: (cwd) => path.join(cwd, ".cursor", "skills"),
  },
  opencode: {
    global: path.join(os.homedir(), ".config", "opencode", "skills"),
    workspace: (cwd) => path.join(cwd, ".opencode", "skills"),
  },
  pi: {
    global: path.join(os.homedir(), ".pi", "agent", "skills"),
    workspace: (cwd) => path.join(cwd, ".pi", "skills"),
  },
};

// ---------------------------------------------------------------------------
// Public API types
// ---------------------------------------------------------------------------

export interface InstallSkillsOptions {
  /** Where to install skills. Defaults to "global" (home directory).
   *  - "global": ~/.agents/skills/ + ~/.claude/skills/
   *  - "workspace": {cwd}/.agents/skills/ + {cwd}/.claude/skills/ */
  location?: SkillLocation;
  /** Working directory. Required for "workspace" location. */
  cwd?: string;
  /** Also install into each runtime's native directory (e.g. ~/.gemini/skills/, ~/.cursor/skills/).
   *  Usually unnecessary since most runtimes scan .agents/skills/. Default: false. */
  includeNativeDirs?: boolean;
}

export interface SkillInstallEntry {
  target: string;
  skillName: string;
  status: "created" | "skipped" | "conflict" | "error";
  targetPath: string;
  error?: string;
}

export interface SkillInstallResult {
  entries: SkillInstallEntry[];
  installed: number;
  skipped: number;
  conflicts: number;
  errors: number;
}

export interface RemoveSkillsOptions {
  /** Where to remove skills from. Defaults to "global". */
  location?: SkillLocation;
  /** Working directory. Required for "workspace" location. */
  cwd?: string;
  /** Also remove from native runtime directories. Default: false. */
  includeNativeDirs?: boolean;
}

export interface SkillRemoveEntry {
  target: string;
  skillName: string;
  status: "removed" | "not_found" | "conflict" | "error";
  targetPath: string;
  error?: string;
}

export interface SkillRemoveResult {
  entries: SkillRemoveEntry[];
  removed: number;
}

export interface InstalledSkill {
  name: string;
  sourcePath: string | null;
  isSymlink: boolean;
}

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

/** Resolve the standard skill discovery paths (both channels). */
function resolveStandardPaths(location: SkillLocation, cwd?: string): Array<{ target: string; skillsHome: string }> {
  if (location === "workspace") {
    if (!cwd) throw new Error("cwd is required when location is 'workspace'");
    return [
      { target: "agents", skillsHome: path.join(cwd, ".agents", "skills") },
      { target: "claude", skillsHome: path.join(cwd, ".claude", "skills") },
    ];
  }
  return [
    { target: "agents", skillsHome: path.join(os.homedir(), ".agents", "skills") },
    { target: "claude", skillsHome: path.join(os.homedir(), ".claude", "skills") },
  ];
}

/** Resolve native per-runtime paths (for includeNativeDirs). */
function resolveNativePaths(location: SkillLocation, cwd?: string): Array<{ target: string; skillsHome: string }> {
  const results: Array<{ target: string; skillsHome: string }> = [];
  for (const [runtime, dirs] of Object.entries(NATIVE_DIRS)) {
    if (location === "workspace") {
      if (!cwd) continue;
      results.push({ target: runtime, skillsHome: dirs.workspace(cwd) });
    } else {
      results.push({ target: runtime, skillsHome: dirs.global });
    }
  }
  return results;
}

/** Build the full list of install/remove targets. */
function resolveTargets(
  location: SkillLocation,
  cwd?: string,
  includeNativeDirs?: boolean,
): Array<{ target: string; skillsHome: string }> {
  const targets = resolveStandardPaths(location, cwd);
  if (includeNativeDirs) {
    targets.push(...resolveNativePaths(location, cwd));
  }
  return targets;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Install skill directories into agent discovery paths via idempotent symlinks.
 *
 * By default, installs into the two standard channels:
 * - `.agents/skills/` — discovered by Codex, Gemini, Cursor, OpenCode, Pi
 * - `.claude/skills/` — discovered by Claude Code
 *
 * Set `includeNativeDirs: true` to also install into each runtime's
 * native directory (e.g. `.gemini/skills/`, `.cursor/skills/`).
 *
 * @example
 * ```typescript
 * // Global install (home directory)
 * await installSkills(["~/.myapp/skills/code-review"]);
 * // Creates ~/.agents/skills/code-review + ~/.claude/skills/code-review
 *
 * // Workspace install (project-local)
 * await installSkills(skillDirs, { location: "workspace", cwd: "/path/to/project" });
 * // Creates {cwd}/.agents/skills/... + {cwd}/.claude/skills/...
 * ```
 */
export async function installSkills(
  skillDirs: string[],
  options?: InstallSkillsOptions,
): Promise<SkillInstallResult> {
  const entries: SkillInstallEntry[] = [];
  const location = options?.location ?? "global";
  const targets = resolveTargets(location, options?.cwd, options?.includeNativeDirs);

  for (const { target, skillsHome } of targets) {
    await fs.mkdir(skillsHome, { recursive: true });

    for (const dir of skillDirs) {
      const resolved = path.resolve(dir);
      const name = path.basename(resolved);
      const symlink = path.join(skillsHome, name);
      try {
        const status = await ensureSkillSymlink(resolved, symlink);
        entries.push({ target, skillName: name, status, targetPath: symlink });
      } catch (err) {
        entries.push({
          target,
          skillName: name,
          status: "error",
          targetPath: symlink,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  return {
    entries,
    installed: entries.filter((e) => e.status === "created").length,
    skipped: entries.filter((e) => e.status === "skipped").length,
    conflicts: entries.filter((e) => e.status === "conflict").length,
    errors: entries.filter((e) => e.status === "error").length,
  };
}

/**
 * Remove skill symlinks from agent discovery paths.
 *
 * Only removes symlinks that point to the specified source directories.
 * User-installed skills or skills from other apps are never touched.
 */
export async function removeSkills(
  skillDirs: string[],
  options?: RemoveSkillsOptions,
): Promise<SkillRemoveResult> {
  const entries: SkillRemoveEntry[] = [];
  const location = options?.location ?? "global";
  const targets = resolveTargets(location, options?.cwd, options?.includeNativeDirs);

  for (const { target, skillsHome } of targets) {
    for (const dir of skillDirs) {
      const resolved = path.resolve(dir);
      const name = path.basename(resolved);
      const symlink = path.join(skillsHome, name);

      try {
        const stat = await fs.lstat(symlink);
        if (!stat.isSymbolicLink()) {
          entries.push({ target, skillName: name, status: "conflict", targetPath: symlink });
          continue;
        }
        const existing = await fs.readlink(symlink);
        const resolvedExisting = path.resolve(path.dirname(symlink), existing);
        if (resolvedExisting !== resolved) {
          entries.push({ target, skillName: name, status: "conflict", targetPath: symlink });
          continue;
        }
        await fs.unlink(symlink);
        entries.push({ target, skillName: name, status: "removed", targetPath: symlink });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          entries.push({ target, skillName: name, status: "not_found", targetPath: symlink });
        } else {
          entries.push({
            target,
            skillName: name,
            status: "error",
            targetPath: symlink,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }
  }

  return {
    entries,
    removed: entries.filter((e) => e.status === "removed").length,
  };
}

/**
 * List skills installed in the standard discovery channels.
 *
 * Returns a record keyed by channel ("agents", "claude") with the skills
 * found in each. If `includeNativeDirs` is true, also includes native
 * runtime directories (keyed by runtime name).
 *
 * @example
 * ```typescript
 * const skills = await listInstalledSkills();
 * // { agents: [...], claude: [...] }
 *
 * const skills = await listInstalledSkills({ location: "workspace", cwd: "/my/project" });
 * // { agents: [...], claude: [...] }
 * ```
 */
export async function listInstalledSkills(
  options?: { location?: SkillLocation; cwd?: string; includeNativeDirs?: boolean },
): Promise<Record<string, InstalledSkill[]>> {
  const location = options?.location ?? "global";
  const targets = resolveTargets(location, options?.cwd, options?.includeNativeDirs);

  const result: Record<string, InstalledSkill[]> = {};

  for (const { target, skillsHome } of targets) {
    let dirEntries: string[];
    try {
      dirEntries = await fs.readdir(skillsHome);
    } catch {
      result[target] = [];
      continue;
    }

    const skills: InstalledSkill[] = [];
    for (const name of dirEntries) {
      const fullPath = path.join(skillsHome, name);
      try {
        const stat = await fs.lstat(fullPath);
        if (stat.isSymbolicLink()) {
          const linkTarget = await fs.readlink(fullPath);
          skills.push({
            name,
            sourcePath: path.resolve(path.dirname(fullPath), linkTarget),
            isSymlink: true,
          });
        } else if (stat.isDirectory()) {
          skills.push({ name, sourcePath: fullPath, isSymlink: false });
        }
      } catch {
        // Skip unreadable entries
      }
    }
    result[target] = skills;
  }

  return result;
}

// ---------------------------------------------------------------------------
// Convenience resolvers (exported for low-level use / escape hatch)
// ---------------------------------------------------------------------------

/**
 * Resolve the global (home-directory) skills path for a standard channel.
 */
export function resolveSkillsHome(channel: SkillChannel): string {
  switch (channel) {
    case "agents":
      return path.join(os.homedir(), ".agents", "skills");
    case "claude":
      return path.join(os.homedir(), ".claude", "skills");
  }
}

/**
 * Resolve the workspace-relative skills path for a standard channel.
 */
export function resolveSkillsWorkspace(channel: SkillChannel, cwd: string): string {
  switch (channel) {
    case "agents":
      return path.join(cwd, ".agents", "skills");
    case "claude":
      return path.join(cwd, ".claude", "skills");
  }
}

/**
 * Resolve the native per-runtime skills path (home directory).
 * Returns null for runtimes that use standard channels (claude → .claude/, codex → .agents/).
 */
export function resolveNativeSkillsHome(runtime: SkillRuntime): string | null {
  const entry = NATIVE_DIRS[runtime];
  return entry?.global ?? null;
}

/**
 * Resolve the native per-runtime skills path (workspace).
 * Returns null for runtimes that use standard channels.
 */
export function resolveNativeSkillsWorkspace(runtime: SkillRuntime, cwd: string): string | null {
  const entry = NATIVE_DIRS[runtime];
  return entry ? entry.workspace(cwd) : null;
}

// ---------------------------------------------------------------------------
// Low-level helpers
// ---------------------------------------------------------------------------

/**
 * Idempotent symlink creation. Returns the outcome:
 * - "created": new symlink was created
 * - "skipped": symlink already exists and points to the correct source
 * - "conflict": symlink exists but points elsewhere (not overwritten)
 */
export async function ensureSkillSymlink(
  source: string,
  target: string,
): Promise<"created" | "skipped" | "conflict"> {
  try {
    const stat = await fs.lstat(target);
    if (stat.isSymbolicLink()) {
      const existing = await fs.readlink(target);
      const resolvedExisting = path.resolve(path.dirname(target), existing);
      if (resolvedExisting === path.resolve(source)) {
        return "skipped";
      }
      return "conflict";
    }
    return "conflict";
  } catch {
    await fs.symlink(source, target, "dir");
    return "created";
  }
}

// ---------------------------------------------------------------------------
// Internal helpers (used by provider execute functions)
// ---------------------------------------------------------------------------

/**
 * Place skills into a home-directory-based skills folder via idempotent symlinks.
 * Used internally by provider execute functions for native runtime injection.
 *
 * Returns the skills home path, or null if no skills were provided.
 */
export async function injectHomeSkills(
  skillDirs: string[],
  runtime: SkillRuntime,
): Promise<string | null> {
  if (skillDirs.length === 0) return null;

  const entry = NATIVE_DIRS[runtime];
  const skillsHome = entry?.global ?? null;
  if (!skillsHome) return null;

  await fs.mkdir(skillsHome, { recursive: true });

  for (const dir of skillDirs) {
    const name = path.basename(dir);
    const target = path.join(skillsHome, name);
    try {
      await ensureSkillSymlink(dir, target);
    } catch (err) {
      console.warn(`Failed to inject skill "${name}" into ${skillsHome}: ${err}`);
    }
  }

  return skillsHome;
}

/**
 * Place skills into {cwd}/.agents/skills/ via idempotent symlinks.
 * Used internally by codex provider.
 *
 * Returns the skills directory path, or null if no skills were provided.
 */
export async function injectWorkspaceSkills(
  skillDirs: string[],
  cwd: string,
): Promise<string | null> {
  if (skillDirs.length === 0) return null;

  const skillsHome = path.join(cwd, ".agents", "skills");
  await fs.mkdir(skillsHome, { recursive: true });

  for (const dir of skillDirs) {
    const name = path.basename(dir);
    const target = path.join(skillsHome, name);
    try {
      await ensureSkillSymlink(dir, target);
    } catch (err) {
      console.warn(`Failed to inject skill "${name}" into ${skillsHome}: ${err}`);
    }
  }

  return skillsHome;
}

/**
 * Build an ephemeral tmpdir with .claude/skills/ containing symlinks.
 * Used by Claude provider — passed via --add-dir, cleaned up after execution.
 *
 * Returns the tmpdir path (caller must clean up with cleanupSkillsDir).
 */
export async function buildSkillsDir(skillDirs: string[], runtime: SkillRuntime): Promise<string> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "agentex-skills-"));

  let skillsRoot: string;
  if (runtime === "claude") {
    skillsRoot = path.join(tmpDir, ".claude", "skills");
  } else {
    skillsRoot = path.join(tmpDir, "skills");
  }
  await fs.mkdir(skillsRoot, { recursive: true });

  for (const dir of skillDirs) {
    const name = path.basename(dir);
    try {
      await fs.symlink(dir, path.join(skillsRoot, name), "dir");
    } catch (err) {
      console.warn(`Failed to symlink skill "${name}": ${err}`);
    }
  }

  return tmpDir;
}

export async function cleanupSkillsDir(tmpDir: string): Promise<void> {
  try {
    await fs.rm(tmpDir, { recursive: true, force: true });
  } catch {
    // Best effort cleanup
  }
}
