import * as fs from "node:fs/promises";
import * as path from "node:path";
import picomatch from "picomatch";

const ALWAYS_SKIP = new Set([".git"]);

/**
 * Walk `root` recursively and yield POSIX-relative paths of every file (and
 * symlink-to-file). Skips `.git/` at every depth so source-repo internals
 * (and any nested submodules / vendored repos) never leak into copy globs.
 */
async function* walkFiles(root: string, relPrefix: string): AsyncGenerator<string> {
  const here = path.join(root, relPrefix);
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(here, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (ALWAYS_SKIP.has(entry.name)) continue;
    const rel = relPrefix === "" ? entry.name : `${relPrefix}/${entry.name}`;
    if (entry.isDirectory()) {
      yield* walkFiles(root, rel);
    } else if (entry.isFile() || entry.isSymbolicLink()) {
      yield rel;
    }
  }
}

/**
 * Match every file under `source` against the given glob `patterns` (picomatch
 * dialect, dot-aware). Returns POSIX-relative paths, de-duplicated and sorted.
 */
export async function globMatchFiles(
  source: string,
  patterns: readonly string[],
): Promise<string[]> {
  if (patterns.length === 0) return [];
  const matchers = patterns.map((p) => picomatch(p, { dot: true }));
  const results = new Set<string>();
  for await (const rel of walkFiles(source, "")) {
    for (const m of matchers) {
      if (m(rel)) {
        results.add(rel);
        break;
      }
    }
  }
  return Array.from(results).sort();
}
