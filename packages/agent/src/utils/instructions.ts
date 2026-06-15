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
//   - every runtime except Claude reads AGENTS.md; Claude reads CLAUDE.md
//   - Gemini reads GEMINI.md by default (AGENTS.md only when configured), so it
//     gets a native escape hatch
//
// Two locations, mirroring installSkills:
//
//   - "workspace": files at {cwd}/ — the repo-root AGENTS.md convention. Files
//     dedupe by name, so the default writes CLAUDE.md + AGENTS.md once each.
//   - "global": each runtime reads its own file in its own home dir
//     (~/.claude/CLAUDE.md, ~/.codex/AGENTS.md, ~/.gemini/GEMINI.md, ...). There
//     is no universal ~/AGENTS.md, so global is inherently per-runtime.
//
// Unlike skills (which are symlinked dirs), instruction files carry content, so
// installInstructions does a managed-region merge: it wraps `content` in marker
// comments and replaces only that region on re-install, preserving anything the
// user wrote outside it.
// ===========================================================================

interface RuntimeInstructionSpec {
  /** File this runtime reads at a workspace/repo root. AGENTS.md for all but Claude. */
  projectFile: string;
  /** The runtime's own preferred filename. Differs from projectFile only for Gemini (GEMINI.md). */
  nativeFile: string;
  /** Whether the runtime has a file-based global config. False for Cursor (global = app User Rules). */
  hasGlobalFile: boolean;
}

const RUNTIME_INSTRUCTIONS: Record<SkillRuntime, RuntimeInstructionSpec> = {
  claude: { projectFile: "CLAUDE.md", nativeFile: "CLAUDE.md", hasGlobalFile: true },
  codex: { projectFile: "AGENTS.md", nativeFile: "AGENTS.md", hasGlobalFile: true },
  opencode: { projectFile: "AGENTS.md", nativeFile: "AGENTS.md", hasGlobalFile: true },
  gemini: { projectFile: "AGENTS.md", nativeFile: "GEMINI.md", hasGlobalFile: true },
  cursor: { projectFile: "AGENTS.md", nativeFile: "AGENTS.md", hasGlobalFile: false },
  pi: { projectFile: "AGENTS.md", nativeFile: "AGENTS.md", hasGlobalFile: true },
};

const ALL_RUNTIMES: SkillRuntime[] = ["claude", "codex", "gemini", "cursor", "opencode", "pi"];

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
   * standard (currently only Gemini's GEMINI.md). Only affects "workspace";
   * "global" always uses native files. Default: false.
   */
  includeNativeFiles?: boolean;
  /**
   * Wrap `content` in managed markers and merge into any existing file,
   * replacing only the previously-managed region and preserving everything the
   * user wrote outside it. Default: true. When false, the file is overwritten
   * with raw `content` (escape hatch for fully-owned files).
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

export type InstructionStatus = "created" | "updated" | "skipped" | "error";

export interface InstructionInstallEntry {
  /** The filename written, e.g. "AGENTS.md", "CLAUDE.md", "GEMINI.md". */
  filename: string;
  /** Absolute path written. */
  targetPath: string;
  /** Which requested runtimes this file serves. */
  runtimes: SkillRuntime[];
  status: InstructionStatus;
  error?: string;
}

export interface InstructionInstallResult {
  entries: InstructionInstallEntry[];
  installed: number; // newly created files
  updated: number; // existing files whose content changed
  skipped: number; // content already current → no write
  errors: number;
}

export interface InstructionTarget {
  filename: string;
  targetPath: string;
  runtimes: SkillRuntime[];
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
 *   CLAUDE.md + AGENTS.md once each). `includeNativeFiles` adds GEMINI.md.
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

    const byFile = new Map<string, SkillRuntime[]>();
    const add = (filename: string, runtime: SkillRuntime) => {
      const list = byFile.get(filename) ?? [];
      list.push(runtime);
      byFile.set(filename, list);
    };

    for (const runtime of runtimes) {
      const spec = RUNTIME_INSTRUCTIONS[runtime];
      add(spec.projectFile, runtime);
      if (options?.includeNativeFiles && spec.nativeFile !== spec.projectFile) {
        add(spec.nativeFile, runtime);
      }
    }

    return [...byFile.entries()].map(([filename, rts]) => ({
      filename,
      targetPath: path.join(cwd, filename),
      runtimes: dedupeRuntimes(rts),
    }));
  }

  // global: each runtime reads its own native file in its own home dir.
  const targets: InstructionTarget[] = [];
  for (const runtime of runtimes) {
    const spec = RUNTIME_INSTRUCTIONS[runtime];
    if (!spec.hasGlobalFile) continue; // e.g. cursor global = app User Rules, not a file
    const home = getDefaultRuntimeHome(runtime, options?.homeDir);
    targets.push({
      filename: spec.nativeFile,
      targetPath: path.join(home, spec.nativeFile),
      runtimes: [runtime],
    });
  }
  return targets;
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
 * By default merges `content` into a managed region of `{cwd}/CLAUDE.md` and
 * `{cwd}/AGENTS.md`, preserving any user-authored content outside the markers.
 * Idempotent: a re-install with unchanged content reports every entry as
 * "skipped".
 *
 * @example
 * ```ts
 * // Workspace (repo-root) install — the common case.
 * await installInstructions(brief, { location: "workspace", cwd: projectDir });
 * // → {cwd}/CLAUDE.md + {cwd}/AGENTS.md
 *
 * // Also drop Gemini's native GEMINI.md (it doesn't read AGENTS.md by default).
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
  const targets = resolveInstructionTargets(options);
  const entries: InstructionInstallEntry[] = [];

  for (const target of targets) {
    try {
      const existing = await readFileOrNull(target.targetPath);
      const next = managed
        ? upsertManagedBlock(existing, content, { tag })
        : ensureTrailingNewline(content);

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

      entries.push({ ...target, status });
    } catch (err) {
      entries.push({
        ...target,
        status: "error",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return {
    entries,
    installed: entries.filter((e) => e.status === "created").length,
    updated: entries.filter((e) => e.status === "updated").length,
    skipped: entries.filter((e) => e.status === "skipped").length,
    errors: entries.filter((e) => e.status === "error").length,
  };
}

/**
 * Remove the managed region installed by {@link installInstructions}, preserving
 * any user-authored content outside the markers. If the file contains nothing
 * but the managed block, it is deleted. User-owned files (no managed region) are
 * left untouched and reported as "skipped".
 */
export async function removeInstructions(
  options?: RemoveInstructionsOptions,
): Promise<InstructionRemoveResult> {
  const tag = options?.managedTag ?? DEFAULT_MANAGED_TAG;
  const targets = resolveInstructionTargets({
    runtimes: options?.runtimes,
    location: options?.location,
    cwd: options?.cwd,
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
