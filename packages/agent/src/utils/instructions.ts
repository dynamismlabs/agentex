import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createHash } from "node:crypto";
import type { SkillRuntime, SkillLocation } from "./skills.js";
import { getDefaultRuntimeHome } from "./runtime-homes.js";

/**
 * Read an instructions file and return its content.
 * Returns null if no path is provided.
 * Throws a clear error if the file doesn't exist.
 */
export async function resolveInstructions(filePath?: string): Promise<string | null> {
  if (!filePath) return null;
  try {
    return await fs.readFile(filePath, "utf-8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new Error(`Instructions file not found: ${filePath}`);
    }
    throw err;
  }
}

// ===========================================================================
// installInstructions — the instruction-file twin of installSkills.
//
// installSkills condenses every runtime into two discovery channels
// (.agents/skills + .claude/skills) with a per-runtime "native" escape hatch.
// Instruction files follow the same shape:
//
//   - every runtime reads AGENTS.md at a workspace root (Claude Code since
//     2.1.277, where the folder has no CLAUDE.md)
//   - Claude's CLAUDE.md and Gemini's GEMINI.md are native files, written only
//     on opt-in (`includeNativeFiles`)
//
// Two locations, mirroring installSkills:
//
//   - "workspace": files at {cwd}/ — the repo-root AGENTS.md convention. Files
//     dedupe by name, so the default writes AGENTS.md once.
//   - "global": each runtime reads its own file in its own home dir
//     (~/.claude/CLAUDE.md, ~/.codex/AGENTS.md, ~/.gemini/GEMINI.md, ...). There
//     is no universal ~/AGENTS.md, so global is inherently per-runtime.
//
// Claude Code reads AGENTS.md only where no CLAUDE.md exists: a CLAUDE.md (or
// a CLAUDE.local.md, or one in a parent directory) hides AGENTS.md completely.
// So a workspace CLAUDE.md is only ever a one-line pointer (`@AGENTS.md`),
// never a second copy of the brief, and a CLAUDE.md already on disk is
// reconciled on every install: one holding nothing but our managed region is
// removed when the opt-in is off, and one the user wrote gets the pointer so
// the brief still reaches Claude.
//
// Unlike skills (which are symlinked dirs), instruction files carry content, so
// installInstructions does a managed-region merge: it wraps `content` in marker
// comments and replaces only that region on re-install, preserving anything the
// user wrote outside it.
// ===========================================================================

interface RuntimeInstructionSpec {
  /** File this runtime reads at a workspace/repo root. AGENTS.md for every runtime. */
  projectFile: string;
  /** The runtime's own preferred filename. Written in a workspace only on opt-in (`includeNativeFiles`). */
  nativeFile: string;
  /**
   * How an opt-in native file carries the brief. "pointer": only an import of
   * the project file (`@AGENTS.md`), because the native file's mere presence
   * hides the project file from the runtime (Claude). "copy": the brief itself
   * (Gemini, which doesn't read AGENTS.md by default).
   */
  nativeFileMode: "pointer" | "copy";
  /** Whether the runtime has a file-based global config. False for Cursor (global = app User Rules). */
  hasGlobalFile: boolean;
}

const RUNTIME_INSTRUCTIONS: Record<SkillRuntime, RuntimeInstructionSpec> = {
  claude: { projectFile: "AGENTS.md", nativeFile: "CLAUDE.md", nativeFileMode: "pointer", hasGlobalFile: true },
  codex: { projectFile: "AGENTS.md", nativeFile: "AGENTS.md", nativeFileMode: "copy", hasGlobalFile: true },
  opencode: { projectFile: "AGENTS.md", nativeFile: "AGENTS.md", nativeFileMode: "copy", hasGlobalFile: true },
  gemini: { projectFile: "AGENTS.md", nativeFile: "GEMINI.md", nativeFileMode: "copy", hasGlobalFile: true },
  antigravity: { projectFile: "AGENTS.md", nativeFile: "GEMINI.md", nativeFileMode: "copy", hasGlobalFile: true },
  cursor: { projectFile: "AGENTS.md", nativeFile: "AGENTS.md", nativeFileMode: "copy", hasGlobalFile: false },
  pi: { projectFile: "AGENTS.md", nativeFile: "AGENTS.md", nativeFileMode: "copy", hasGlobalFile: true },
};

const ALL_RUNTIMES: SkillRuntime[] = ["claude", "codex", "gemini", "antigravity", "cursor", "opencode", "pi"];

const DEFAULT_MANAGED_TAG = "agentex";

export interface InstallInstructionsOptions {
  /** Which runtimes to write instruction files for. Defaults to all known runtimes. */
  runtimes?: SkillRuntime[];
  /** "workspace" ({cwd}/) — default — or "global" (each runtime's home dir). */
  location?: SkillLocation;
  /** Working directory. Required for "workspace". */
  cwd?: string;
  /**
   * Also write each runtime's native file when it differs from the shared
   * AGENTS.md: Claude's CLAUDE.md (as a one-line `@AGENTS.md` pointer) and
   * Gemini's GEMINI.md (as a copy). Only affects "workspace"; "global" always
   * uses native files. Default: false.
   *
   * Opt in for Claude Code before 2.1.277, or on Bedrock, Vertex or Foundry,
   * where Claude doesn't read AGENTS.md on its own.
   */
  includeNativeFiles?: boolean;
  /**
   * Wrap `content` in managed markers and merge into any existing file,
   * replacing only the previously-managed region and preserving everything the
   * user wrote outside it. Default: true. When false, the file is overwritten
   * with raw `content` (escape hatch for fully-owned files), and an existing
   * CLAUDE.md is left alone even though it hides AGENTS.md from Claude Code.
   */
  managed?: boolean;
  /** Marker tag, so the comment reads `<!-- <tag>:managed:start -->`. Default: "agentex". */
  managedTag?: string;
  /**
   * Override the home-directory base for "global" installs (sandboxes / tests).
   * Defaults to os.homedir().
   */
  homeDir?: string;
}

/**
 * "removed": a workspace CLAUDE.md that held nothing but this installer's
 * managed region, deleted because the opt-in (`includeNativeFiles`) is off.
 */
export type InstructionStatus = "created" | "updated" | "skipped" | "removed" | "error";

export interface InstructionInstallEntry {
  /** The filename written, e.g. "AGENTS.md", "CLAUDE.md", "GEMINI.md". */
  filename: string;
  /** Absolute path written. */
  targetPath: string;
  /** Which requested runtimes this file serves. */
  runtimes: SkillRuntime[];
  /** Set when the file is a pointer: its managed region is `@<importsFile>`, not the brief. */
  importsFile?: string;
  status: InstructionStatus;
  error?: string;
}

export interface InstructionInstallResult {
  entries: InstructionInstallEntry[];
  installed: number; // newly created files
  updated: number; // existing files whose content changed
  skipped: number; // content already current → no write
  removed: number; // managed-only CLAUDE.md deleted because the opt-in is off
  errors: number;
}

export interface InstructionTarget {
  filename: string;
  targetPath: string;
  runtimes: SkillRuntime[];
  /** Set when the file is a pointer: its managed region is `@<importsFile>`, not the brief. */
  importsFile?: string;
}

export interface RemoveInstructionsOptions {
  runtimes?: SkillRuntime[];
  location?: SkillLocation;
  cwd?: string;
  /** Marker tag whose managed region should be removed. Default: "agentex". */
  managedTag?: string;
  homeDir?: string;
}

export type InstructionRemoveStatus = "removed" | "not_found" | "skipped" | "error";

export interface InstructionRemoveEntry {
  filename: string;
  targetPath: string;
  runtimes: SkillRuntime[];
  status: InstructionRemoveStatus;
  error?: string;
}

export interface InstructionRemoveResult {
  entries: InstructionRemoveEntry[];
  removed: number;
}

export interface ManagedBlockOptions {
  /** Marker tag. Default: "agentex". */
  tag?: string;
}

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

/**
 * Resolve which instruction files would be written for the given options,
 * without touching disk.
 *
 * - "workspace": files dedupe by name under {cwd}/ (the default writes
 *   AGENTS.md once). `includeNativeFiles` adds CLAUDE.md (a pointer, marked by
 *   `importsFile`) and GEMINI.md.
 * - "global": one file per runtime in each runtime's home dir. Runtimes without
 *   a file-based global config (Cursor) are omitted.
 */
export function resolveInstructionTargets(options?: {
  runtimes?: SkillRuntime[];
  location?: SkillLocation;
  cwd?: string;
  includeNativeFiles?: boolean;
  homeDir?: string;
}): InstructionTarget[] {
  const location: SkillLocation = options?.location ?? "workspace";
  const runtimes = dedupeRuntimes(options?.runtimes ?? ALL_RUNTIMES);

  if (location === "workspace") {
    const cwd = options?.cwd;
    if (!cwd) throw new Error("cwd is required when location is 'workspace'");

    const byFile = new Map<string, InstructionTarget>();
    const add = (filename: string, runtime: SkillRuntime, importsFile?: string) => {
      const target: InstructionTarget = byFile.get(filename) ?? {
        filename,
        targetPath: path.join(cwd, filename),
        runtimes: [],
        ...(importsFile !== undefined && { importsFile }),
      };
      target.runtimes.push(runtime);
      byFile.set(filename, target);
    };

    for (const runtime of runtimes) {
      const spec = RUNTIME_INSTRUCTIONS[runtime];
      add(spec.projectFile, runtime);
      if (options?.includeNativeFiles && spec.nativeFile !== spec.projectFile) {
        add(spec.nativeFile, runtime, spec.nativeFileMode === "pointer" ? spec.projectFile : undefined);
      }
    }

    return [...byFile.values()].map((target) => ({ ...target, runtimes: dedupeRuntimes(target.runtimes) }));
  }

  // global: each runtime reads its own native file in its own home dir. Gemini
  // CLI and Antigravity share ~/.gemini/GEMINI.md, so targets merge by path.
  const byPath = new Map<string, InstructionTarget>();
  for (const runtime of runtimes) {
    const spec = RUNTIME_INSTRUCTIONS[runtime];
    if (!spec.hasGlobalFile) continue; // e.g. cursor global = app User Rules, not a file
    const home = getDefaultRuntimeHome(runtime, options?.homeDir);
    const targetPath = path.join(home, spec.nativeFile);
    const existing = byPath.get(targetPath);
    if (existing) existing.runtimes.push(runtime);
    else byPath.set(targetPath, { filename: spec.nativeFile, targetPath, runtimes: [runtime] });
  }
  return [...byPath.values()];
}

function dedupeRuntimes(runtimes: SkillRuntime[]): SkillRuntime[] {
  return [...new Set(runtimes)];
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Install an instruction brief into the right per-runtime files.
 *
 * By default merges `content` into a managed region of `{cwd}/AGENTS.md`,
 * preserving any user-authored content outside the markers. Idempotent: a
 * re-install with unchanged content reports every entry as "skipped".
 *
 * When Claude is among the runtimes, a `{cwd}/CLAUDE.md` already on disk is
 * reconciled, because it would hide AGENTS.md from Claude Code: one holding
 * nothing but this installer's managed region is removed, and one the user
 * wrote gets `@AGENTS.md` in its managed region. With `includeNativeFiles`,
 * CLAUDE.md is written as that pointer either way. `managed: false` leaves an
 * existing CLAUDE.md alone.
 *
 * @example
 * ```ts
 * // Workspace (repo-root) install — the common case.
 * await installInstructions(brief, { location: "workspace", cwd: projectDir });
 * // → {cwd}/AGENTS.md
 *
 * // Also write the native files: CLAUDE.md as an `@AGENTS.md` pointer (for
 * // Claude Code before 2.1.277, or on Bedrock/Vertex/Foundry) and GEMINI.md.
 * await installInstructions(brief, { location: "workspace", cwd, includeNativeFiles: true });
 *
 * // Global install — per-runtime home files.
 * await installInstructions(brief, { location: "global" });
 * // → ~/.claude/CLAUDE.md, ~/.codex/AGENTS.md, ~/.gemini/GEMINI.md, ...
 * ```
 */
export async function installInstructions(
  content: string,
  options?: InstallInstructionsOptions,
): Promise<InstructionInstallResult> {
  const managed = options?.managed ?? true;
  const tag = options?.managedTag ?? DEFAULT_MANAGED_TAG;
  const entries: InstructionInstallEntry[] = [];

  for (const target of resolveInstructionTargets(options)) {
    const body = target.importsFile !== undefined ? `@${target.importsFile}` : content;
    entries.push(await writeTarget(target, body, managed, tag));
  }
  if (managed) {
    for (const target of unrequestedPointerTargets(options)) {
      const entry = await reconcilePointer(target, tag);
      if (entry) entries.push(entry);
    }
  }

  return {
    entries,
    installed: entries.filter((e) => e.status === "created").length,
    updated: entries.filter((e) => e.status === "updated").length,
    skipped: entries.filter((e) => e.status === "skipped").length,
    removed: entries.filter((e) => e.status === "removed").length,
    errors: entries.filter((e) => e.status === "error").length,
  };
}

async function writeTarget(
  target: InstructionTarget,
  body: string,
  managed: boolean,
  tag: string,
): Promise<InstructionInstallEntry> {
  try {
    const existing = await readFileOrNull(target.targetPath);
    const next = managed ? upsertManagedBlock(existing, body, { tag }) : ensureTrailingNewline(body);

    let status: InstructionStatus;
    if (existing === null) {
      status = "created";
    } else if (existing === next) {
      status = "skipped";
    } else {
      status = "updated";
    }

    if (status !== "skipped") {
      await fs.mkdir(path.dirname(target.targetPath), { recursive: true });
      await fs.writeFile(target.targetPath, next, { mode: 0o644 });
    }
    return { ...target, status };
  } catch (err) {
    return { ...target, status: "error", error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Pointer files (a workspace CLAUDE.md) for the requested runtimes that the
 * install doesn't write because the opt-in is off, but that still need
 * reconciling if they exist.
 */
function unrequestedPointerTargets(options?: InstallInstructionsOptions): InstructionTarget[] {
  if ((options?.location ?? "workspace") !== "workspace" || options?.includeNativeFiles) return [];
  return resolveInstructionTargets({ ...options, includeNativeFiles: true }).filter(
    (target) => target.importsFile !== undefined,
  );
}

/**
 * An existing pointer file with the opt-in off: delete it when nothing but our
 * managed region is in it, otherwise keep the user's content and make sure it
 * imports the project file. Returns null when there is no file.
 */
async function reconcilePointer(
  target: InstructionTarget,
  tag: string,
): Promise<InstructionInstallEntry | null> {
  try {
    const existing = await readFileOrNull(target.targetPath);
    if (existing === null) return null;
    if (stripManagedBlock(existing, { tag }) === null) {
      await fs.rm(target.targetPath, { force: true });
      return { ...target, status: "removed" };
    }
    const next = upsertManagedBlock(existing, `@${target.importsFile}`, { tag });
    if (next === existing) return { ...target, status: "skipped" };
    await fs.writeFile(target.targetPath, next);
    return { ...target, status: "updated" };
  } catch (err) {
    return { ...target, status: "error", error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Remove the managed region installed by {@link installInstructions}, preserving
 * any user-authored content outside the markers. If the file contains nothing
 * but the managed block, it is deleted. User-owned files (no managed region) are
 * left untouched and reported as "skipped". Native files (CLAUDE.md, GEMINI.md)
 * are always checked, whether or not they were installed with
 * `includeNativeFiles`.
 */
export async function removeInstructions(
  options?: RemoveInstructionsOptions,
): Promise<InstructionRemoveResult> {
  const tag = options?.managedTag ?? DEFAULT_MANAGED_TAG;
  const targets = resolveInstructionTargets({
    runtimes: options?.runtimes,
    location: options?.location,
    cwd: options?.cwd,
    includeNativeFiles: true,
    homeDir: options?.homeDir,
  });
  const entries: InstructionRemoveEntry[] = [];

  for (const target of targets) {
    try {
      const existing = await readFileOrNull(target.targetPath);
      if (existing === null) {
        entries.push({ ...target, status: "not_found" });
        continue;
      }

      const stripped = stripManagedBlock(existing, { tag });
      if (stripped === existing) {
        // No managed region present — never touch user-owned files.
        entries.push({ ...target, status: "skipped" });
        continue;
      }

      if (stripped === null) {
        await fs.rm(target.targetPath, { force: true });
      } else {
        await fs.writeFile(target.targetPath, stripped, { mode: 0o644 });
      }
      entries.push({ ...target, status: "removed" });
    } catch (err) {
      entries.push({
        ...target,
        status: "error",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { entries, removed: entries.filter((e) => e.status === "removed").length };
}

// ---------------------------------------------------------------------------
// Managed-region merge (exported for low-level use / hosts with custom layouts)
// ---------------------------------------------------------------------------

/**
 * Merge `content` into `existing` as a managed region, preserving everything the
 * user wrote outside the markers.
 *
 * - `existing` has a managed region → replace only the bytes between the markers.
 * - `existing` has no markers → prepend the managed block, keep prior content below.
 * - `existing` is null/empty → return just the managed block.
 *
 * The start marker embeds a short content hash, so re-running with identical
 * content produces a byte-identical result (enabling cheap skip detection).
 */
export function upsertManagedBlock(
  existing: string | null,
  content: string,
  options?: ManagedBlockOptions,
): string {
  const tag = options?.tag ?? DEFAULT_MANAGED_TAG;
  const block = buildManagedBlock(content, tag);

  if (existing === null || existing.length === 0) {
    return `${block}\n`;
  }

  const re = managedBlockRegex(tag);
  if (re.test(existing)) {
    return existing.replace(re, block);
  }

  // No managed region yet — prepend it, keep the user's file below.
  return `${block}\n\n${existing.replace(/^\n+/, "")}`;
}

/**
 * Remove the managed region (if any) from `existing`, preserving user content.
 * Returns the cleaned string, the original string if there was no managed
 * region, or null if nothing but the managed block remained.
 */
export function stripManagedBlock(existing: string, options?: ManagedBlockOptions): string | null {
  const tag = options?.tag ?? DEFAULT_MANAGED_TAG;
  const re = managedBlockRegex(tag);
  if (!re.test(existing)) return existing;

  const stripped = existing.replace(re, "").replace(/^\n+/, "");
  return stripped.trim().length === 0 ? null : stripped;
}

function buildManagedBlock(content: string, tag: string): string {
  const body = content.replace(/\s+$/, "");
  const hash = createHash("sha256").update(body).digest("hex").slice(0, 12);
  return `<!-- ${tag}:managed:start hash=${hash} -->\n${body}\n<!-- ${tag}:managed:end -->`;
}

function managedBlockRegex(tag: string): RegExp {
  const t = escapeRegExp(tag);
  return new RegExp(`<!--\\s*${t}:managed:start[^>]*-->[\\s\\S]*?<!--\\s*${t}:managed:end\\s*-->`);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function ensureTrailingNewline(s: string): string {
  return s.endsWith("\n") ? s : `${s}\n`;
}

async function readFileOrNull(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}
