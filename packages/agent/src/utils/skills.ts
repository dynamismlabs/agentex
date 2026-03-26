import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

export type SkillRuntime = "claude" | "codex" | "gemini" | "cursor" | "opencode" | "pi";

export type SkillLocation = "global" | "workspace";

/** Runtimes that support home-directory-based skill discovery. */
const GLOBAL_RUNTIMES: SkillRuntime[] = ["gemini", "cursor", "opencode", "pi"];

/** All runtimes support workspace-relative skill discovery. */
const WORKSPACE_RUNTIMES: SkillRuntime[] = ["claude", "codex", "gemini", "cursor", "opencode", "pi"];

// ---------------------------------------------------------------------------
// Public API types
// ---------------------------------------------------------------------------

export interface InstallSkillsOptions {
  /** Runtimes to install for. Defaults depend on location:
   *  - "global": gemini, cursor, opencode, pi
   *  - "workspace": all runtimes (claude, codex, gemini, cursor, opencode, pi) */
  runtimes?: SkillRuntime[];
  /** Where to install skills. Defaults to "global" (home directory).
   *  - "global": ~/.gemini/skills/, ~/.cursor/skills/, etc.
   *  - "workspace": {cwd}/.gemini/skills/, {cwd}/.claude/skills/, etc. */
  location?: SkillLocation;
  /** Working directory. Required for "workspace" location.
   *  In "global" mode, also installs for codex at {cwd}/.agents/skills/. */
  cwd?: string;
}

export interface SkillInstallEntry {
  runtime: string;
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
  /** Runtimes to remove from. Defaults depend on location. */
  runtimes?: SkillRuntime[];
  /** Where to remove skills from. Defaults to "global". */
  location?: SkillLocation;
  /** Working directory. Required for "workspace" location.
   *  In "global" mode, also removes codex skills from {cwd}/.agents/skills/. */
  cwd?: string;
}

export interface SkillRemoveEntry {
  runtime: string;
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
// Public API
// ---------------------------------------------------------------------------

/**
 * Install skill directories into agent discovery paths via idempotent symlinks.
 *
 * @param location "global" (default) — installs into home-dir paths (~/.gemini/skills/, etc.)
 *                 "workspace" — installs into project-local paths ({cwd}/.gemini/skills/, etc.)
 *
 * @example
 * ```typescript
 * // Global install (home directory)
 * const result = await installSkills([
 *   "~/.myapp/skills/code-review",
 *   "~/.myapp/skills/deploy-helper",
 * ]);
 *
 * // Workspace install (project-local)
 * const result = await installSkills(skillDirs, {
 *   location: "workspace",
 *   cwd: "/path/to/project",
 * });
 * ```
 */
export async function installSkills(
  skillDirs: string[],
  options?: InstallSkillsOptions,
): Promise<SkillInstallResult> {
  const entries: SkillInstallEntry[] = [];
  const location = options?.location ?? "global";

  // Build the list of runtime → skillsHome pairs to process
  const targets: Array<{ runtime: string; skillsHome: string }> = [];

  if (location === "workspace") {
    if (!options?.cwd) {
      throw new Error("cwd is required when location is 'workspace'");
    }
    const runtimes = options?.runtimes ?? WORKSPACE_RUNTIMES;
    for (const runtime of runtimes) {
      targets.push({ runtime, skillsHome: resolveSkillsWorkspace(runtime, options.cwd) });
    }
  } else {
    // Global mode
    const runtimes = options?.runtimes ?? GLOBAL_RUNTIMES;
    for (const runtime of runtimes) {
      const skillsHome = resolveSkillsHome(runtime);
      if (skillsHome) targets.push({ runtime, skillsHome });
    }
    // Backward compat: codex workspace install when cwd provided in global mode
    if (options?.cwd) {
      targets.push({ runtime: "codex", skillsHome: path.join(options.cwd, ".agents", "skills") });
    }
  }

  for (const { runtime, skillsHome } of targets) {
    await fs.mkdir(skillsHome, { recursive: true });

    for (const dir of skillDirs) {
      const resolved = path.resolve(dir);
      const name = path.basename(resolved);
      const target = path.join(skillsHome, name);
      try {
        const status = await ensureSkillSymlink(resolved, target);
        entries.push({ runtime, skillName: name, status, targetPath: target });
      } catch (err) {
        entries.push({
          runtime,
          skillName: name,
          status: "error",
          targetPath: target,
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

  const targets: Array<{ runtime: string; skillsHome: string }> = [];

  if (location === "workspace") {
    if (!options?.cwd) {
      throw new Error("cwd is required when location is 'workspace'");
    }
    const runtimes = options?.runtimes ?? WORKSPACE_RUNTIMES;
    for (const runtime of runtimes) {
      targets.push({ runtime, skillsHome: resolveSkillsWorkspace(runtime, options.cwd) });
    }
  } else {
    const runtimes = options?.runtimes ?? GLOBAL_RUNTIMES;
    for (const runtime of runtimes) {
      const skillsHome = resolveSkillsHome(runtime);
      if (skillsHome) targets.push({ runtime, skillsHome });
    }
    if (options?.cwd) {
      targets.push({ runtime: "codex", skillsHome: path.join(options.cwd, ".agents", "skills") });
    }
  }

  for (const { runtime, skillsHome } of targets) {
    for (const dir of skillDirs) {
      const resolved = path.resolve(dir);
      const name = path.basename(resolved);
      const target = path.join(skillsHome, name);

      try {
        const stat = await fs.lstat(target);
        if (!stat.isSymbolicLink()) {
          entries.push({ runtime, skillName: name, status: "conflict", targetPath: target });
          continue;
        }
        const existing = await fs.readlink(target);
        const resolvedExisting = path.resolve(path.dirname(target), existing);
        if (resolvedExisting !== resolved) {
          // Symlink points somewhere else — not ours, don't touch it
          entries.push({ runtime, skillName: name, status: "conflict", targetPath: target });
          continue;
        }
        await fs.unlink(target);
        entries.push({ runtime, skillName: name, status: "removed", targetPath: target });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          entries.push({ runtime, skillName: name, status: "not_found", targetPath: target });
        } else {
          entries.push({
            runtime,
            skillName: name,
            status: "error",
            targetPath: target,
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
 * List skills currently installed in a runtime's discovery directory.
 *
 * @param cwdOrOptions - A cwd string (backward compat for codex), or options object.
 *
 * @example
 * ```typescript
 * // Global (home directory)
 * const skills = await listInstalledSkills("gemini");
 *
 * // Workspace (project-local)
 * const skills = await listInstalledSkills("gemini", { location: "workspace", cwd: "/path/to/project" });
 *
 * // Backward compat: codex with cwd string
 * const skills = await listInstalledSkills("codex", "/path/to/project");
 * ```
 */
export async function listInstalledSkills(
  runtime: SkillRuntime,
  cwdOrOptions?: string | { location?: SkillLocation; cwd?: string },
): Promise<InstalledSkill[]> {
  let skillsHome: string | null;

  if (typeof cwdOrOptions === "string") {
    // Backward compat: listInstalledSkills("codex", "/path")
    if (runtime === "codex") {
      skillsHome = path.join(cwdOrOptions, ".agents", "skills");
    } else {
      skillsHome = resolveSkillsHome(runtime);
    }
  } else if (cwdOrOptions?.location === "workspace") {
    if (!cwdOrOptions.cwd) return [];
    skillsHome = resolveSkillsWorkspace(runtime, cwdOrOptions.cwd);
  } else {
    // Global mode
    if (runtime === "codex") {
      const cwd = cwdOrOptions?.cwd;
      if (!cwd) return [];
      skillsHome = path.join(cwd, ".agents", "skills");
    } else {
      skillsHome = resolveSkillsHome(runtime);
    }
  }

  if (!skillsHome) return [];

  let dirEntries: string[];
  try {
    dirEntries = await fs.readdir(skillsHome);
  } catch {
    return [];
  }

  const results: InstalledSkill[] = [];
  for (const name of dirEntries) {
    const fullPath = path.join(skillsHome, name);
    try {
      const stat = await fs.lstat(fullPath);
      if (stat.isSymbolicLink()) {
        const linkTarget = await fs.readlink(fullPath);
        results.push({
          name,
          sourcePath: path.resolve(path.dirname(fullPath), linkTarget),
          isSymlink: true,
        });
      } else if (stat.isDirectory()) {
        results.push({ name, sourcePath: fullPath, isSymlink: false });
      }
    } catch {
      // Skip unreadable entries
    }
  }

  return results;
}

/**
 * Resolve the home-directory-based skills path for a given runtime.
 * Returns null for runtimes that don't use home-dir skill discovery.
 */
export function resolveSkillsHome(runtime: SkillRuntime): string | null {
  switch (runtime) {
    case "gemini":
      return path.join(os.homedir(), ".gemini", "skills");
    case "cursor":
      return path.join(os.homedir(), ".cursor", "skills");
    case "opencode":
      // OpenCode reads skills from the same path as Claude
      return path.join(os.homedir(), ".claude", "skills");
    case "pi":
      return path.join(os.homedir(), ".pi", "agent", "skills");
    default:
      return null;
  }
}

/**
 * Resolve the workspace-relative skills path for a given runtime.
 * All runtimes support workspace-relative skill discovery.
 */
export function resolveSkillsWorkspace(runtime: SkillRuntime, cwd: string): string {
  switch (runtime) {
    case "claude":
    case "opencode":
      return path.join(cwd, ".claude", "skills");
    case "codex":
      return path.join(cwd, ".agents", "skills");
    case "gemini":
      return path.join(cwd, ".gemini", "skills");
    case "cursor":
      return path.join(cwd, ".cursor", "skills");
    case "pi":
      return path.join(cwd, ".pi", "agent", "skills");
  }
}

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
      // Points elsewhere — don't overwrite (could be user-installed)
      return "conflict";
    }
    // Target exists as a real directory/file — don't overwrite
    return "conflict";
  } catch {
    // Target doesn't exist — create the symlink
    await fs.symlink(source, target, "dir");
    return "created";
  }
}

/**
 * Place skills into a home-directory-based skills folder via idempotent symlinks.
 * Used by gemini (~/.gemini/skills), cursor (~/.cursor/skills),
 * opencode (~/.claude/skills), and pi (~/.pi/agent/skills).
 *
 * Returns the skills home path, or null if no skills were provided.
 */
export async function injectHomeSkills(
  skillDirs: string[],
  runtime: SkillRuntime,
): Promise<string | null> {
  if (skillDirs.length === 0) return null;

  const skillsHome = resolveSkillsHome(runtime);
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
 * Used by codex which discovers skills from the workspace directory.
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
