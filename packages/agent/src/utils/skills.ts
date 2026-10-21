import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

export type SkillRuntime = "claude" | "codex" | "gemini" | "antigravity" | "cursor" | "opencode" | "pi";

export type SkillLocation = "global" | "workspace";

/**
 * The two standard skill discovery channels:
 * - "agents": ~/.agents/skills/ or {cwd}/.agents/skills/ — scanned by Codex, Gemini, Cursor, OpenCode, Pi.
 *   Antigravity scans only the workspace one; its global folder is ~/.gemini/config/skills/.
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
  // Antigravity reads workspace skills from the standard .agents/skills
  // channel, but not ~/.agents/skills: its global folder is its own. agy
  // 1.4.3 gives the agent ~/.gemini/config/skills and never
  // ~/.gemini/antigravity-cli/skills, whose skills only its /skills menu shows.
  // Headless agy that doesn't skip permissions can't read a link installed
  // here whose real folder is outside the chat's workspace.
  antigravity: {
    global: path.join(os.homedir(), ".gemini", "config", "skills"),
    workspace: (cwd) => path.join(cwd, ".agents", "skills"),
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
  /** Install into exactly these skills folders (e.g. `resolveNativeSkillsHome("antigravity")`),
   *  instead of the ones `location` and `includeNativeDirs` pick. Each entry is reported with
   *  the folder's absolute path as its `target`. */
  folders?: string[];
  /** Replace a link at a skill's name whose target no longer exists (left by a source that was
   *  deleted), instead of reporting it as a conflict. No runtime can read a dead link, so it
   *  would otherwise keep the name taken for good. Default: false. */
  replaceDeadLinks?: boolean;
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
  /** Remove from exactly these skills folders, instead of the ones `location` and
   *  `includeNativeDirs` pick. */
  folders?: string[];
}

export interface ListInstalledSkillsOptions {
  /** Where to list skills from. Defaults to "global". */
  location?: SkillLocation;
  /** Working directory. Required for "workspace" location. */
  cwd?: string;
  /** Also list native runtime directories, keyed by runtime. Default: false. */
  includeNativeDirs?: boolean;
  /** List exactly these skills folders, keyed by absolute path, instead of the ones
   *  `location` and `includeNativeDirs` pick. */
  folders?: string[];
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
  /** Directory containing SKILL.md. Symlinks are resolved to their target directory. */
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
function resolveTargets(options: {
  location?: SkillLocation;
  cwd?: string;
  includeNativeDirs?: boolean;
  folders?: string[];
}): Array<{ target: string; skillsHome: string }> {
  if (options.folders) {
    const folders = [...new Set(options.folders.map((folder) => path.resolve(folder)))];
    return folders.map((folder) => ({ target: folder, skillsHome: folder }));
  }
  const { location = "global", cwd, includeNativeDirs } = options;
  const targets = resolveStandardPaths(location, cwd);
  if (includeNativeDirs) {
    // A runtime whose native folder is a standard channel (Antigravity's
    // workspace .agents/skills) is already covered by that channel.
    const seen = new Set(targets.map((t) => t.skillsHome));
    for (const native of resolveNativePaths(location, cwd)) {
      if (seen.has(native.skillsHome)) continue;
      seen.add(native.skillsHome);
      targets.push(native);
    }
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
 * - `.agents/skills/` — discovered by Codex, Gemini, Antigravity, Cursor, OpenCode, Pi
 * - `.claude/skills/` — discovered by Claude Code
 *
 * Set `includeNativeDirs: true` to also install into each runtime's
 * native directory (e.g. `.gemini/skills/`, `.cursor/skills/`), or pass
 * `folders` to install into exactly the folders you name.
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
 *
 * // Exactly the folders named, e.g. Antigravity's global folder too
 * await installSkills(skillDirs, {
 *   folders: [resolveSkillsHome("agents"), resolveSkillsHome("claude"), resolveNativeSkillsHome("antigravity")!],
 * });
 * ```
 */
export async function installSkills(
  skillDirs: string[],
  options?: InstallSkillsOptions,
): Promise<SkillInstallResult> {
  const entries: SkillInstallEntry[] = [];
  const targets = resolveTargets(options ?? {});

  for (const { target, skillsHome } of targets) {
    // A folder that can't be made fails only its own entries.
    let folderError: string | null = null;
    try {
      await fs.mkdir(skillsHome, { recursive: true });
    } catch (err) {
      folderError = err instanceof Error ? err.message : String(err);
    }

    for (const dir of skillDirs) {
      const resolved = path.resolve(dir);
      const name = path.basename(resolved);
      const symlink = path.join(skillsHome, name);
      if (folderError) {
        entries.push({ target, skillName: name, status: "error", targetPath: symlink, error: folderError });
        continue;
      }
      try {
        if (options?.replaceDeadLinks) await removeDeadLink(symlink, resolved);
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
  const targets = resolveTargets(options ?? {});

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
 *
 * const skills = await listInstalledSkills({ folders: ["/Users/me/.gemini/config/skills"] });
 * // { "/Users/me/.gemini/config/skills": [...] }
 * ```
 */
export async function listInstalledSkills(
  options?: ListInstalledSkillsOptions,
): Promise<Record<string, InstalledSkill[]>> {
  const targets = resolveTargets(options ?? {});

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
 * Remove a link at `target` that leads nowhere and doesn't point at `source`.
 * A live link, a real folder, and a dead link to `source` itself stay.
 */
async function removeDeadLink(target: string, source: string): Promise<void> {
  let stat;
  try {
    stat = await fs.lstat(target);
  } catch {
    return;
  }
  if (!stat.isSymbolicLink()) return;
  const existing = path.resolve(path.dirname(target), await fs.readlink(target));
  if (existing === path.resolve(source)) return;
  try {
    await fs.stat(target);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") await fs.unlink(target);
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
 * Build an ephemeral tmpdir of skill symlinks, laid out where the runtime
 * looks in a folder added with --add-dir: .claude/skills/ for Claude,
 * .agents/skills/ for Antigravity, skills/ otherwise.
 * Used by the Claude and Antigravity providers, cleaned up after execution.
 *
 * Returns the tmpdir path (caller must clean up with cleanupSkillsDir).
 */
export async function buildSkillsDir(skillDirs: string[], runtime: SkillRuntime): Promise<string> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "agentex-skills-"));

  let skillsRoot: string;
  if (runtime === "claude") {
    skillsRoot = path.join(tmpDir, ".claude", "skills");
  } else if (runtime === "antigravity") {
    skillsRoot = path.join(tmpDir, ".agents", "skills");
  } else {
    skillsRoot = path.join(tmpDir, "skills");
  }
  await fs.mkdir(skillsRoot, { recursive: true });

  for (const dir of skillDirs) {
    const name = path.basename(dir);
    try {
      await fs.symlink(path.resolve(dir), path.join(skillsRoot, name), "dir");
    } catch (err) {
      console.warn(`Failed to symlink skill "${name}": ${err}`);
    }
  }

  return tmpDir;
}

/**
 * Clear what agentex 0.0.46 and earlier left in a runtime's global skills
 * folder, where providers linked a chat's `skillDirs` and never removed them:
 * links to these skills, and links that lead nowhere that agentex could have
 * made for this chat's skills (left for a skill since renamed or deleted).
 * Those are dead links at one of these skills' names, or pointing into a
 * folder one of them comes from. A user's own folder can hold a link that is
 * dead only for a while (an unmounted drive, a repo not checked out yet), so
 * any other dead link stays, unless `anyDeadLink` says only agentex ever
 * wrote to the folder. Live links to anything else, and real folders, always
 * stay. Best effort: a link left behind does no more than before.
 */
export async function removeLegacySkillLinks(
  folder: string,
  skillDirs: string[],
  options: { anyDeadLink?: boolean } = {},
): Promise<void> {
  try {
    await removeSkills(skillDirs, { folders: [folder] });
    const names = new Set(skillDirs.map((dir) => path.basename(path.resolve(dir))));
    const sources = new Set<string>();
    for (const dir of skillDirs) {
      sources.add(path.dirname(path.resolve(dir)));
      sources.add(path.dirname(await fs.realpath(dir).catch(() => path.resolve(dir))));
    }
    const ours = async (name: string, target: string): Promise<boolean> => {
      if (options.anyDeadLink || names.has(name)) return true;
      const parent = path.dirname(target);
      return sources.has(parent) || sources.has(await fs.realpath(parent).catch(() => parent));
    };
    for (const name of await fs.readdir(folder)) {
      const entry = path.join(folder, name);
      try {
        if (!(await fs.lstat(entry)).isSymbolicLink()) continue;
        if (await fs.stat(entry).then(() => true, (err: NodeJS.ErrnoException) => err.code !== "ENOENT")) continue;
        const target = path.resolve(folder, await fs.readlink(entry));
        if (await ours(name, target)) await fs.unlink(entry);
      } catch {
        // Leave anything that can't be read or removed.
      }
    }
  } catch {
    // A missing folder lands here too.
  }
}

export async function cleanupSkillsDir(tmpDir: string): Promise<void> {
  try {
    await fs.rm(tmpDir, { recursive: true, force: true });
  } catch {
    // Best effort cleanup
  }
}
