import { execFileSync } from "node:child_process";
import { statSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";

/**
 * Global setup for the packaging tests. §7 (exports-map / no-tdz / lazy-graph /
 * tree-shake) all assert against the *built* `dist/`, so the suite must run
 * against a fresh build. We build once here (before any test file) — this also
 * eliminates the race that per-file `beforeAll` builds would hit under parallel
 * workers. Guarded on mtime so an already-fresh `dist/` is a no-op.
 */

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, "..", "..");

function newestMtime(dir: string): number {
  let newest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      newest = Math.max(newest, newestMtime(full));
    } else {
      newest = Math.max(newest, statSync(full).mtimeMs);
    }
  }
  return newest;
}

function distIsFresh(): boolean {
  try {
    const distIndex = statSync(join(pkgRoot, "dist", "index.js")).mtimeMs;
    const srcNewest = newestMtime(join(pkgRoot, "src"));
    return distIndex >= srcNewest;
  } catch {
    return false; // no dist yet
  }
}

export default function setup(): void {
  if (distIsFresh()) return;
  const tsc = createRequire(import.meta.url).resolve("typescript/bin/tsc");
  execFileSync(process.execPath, [tsc, "-p", join(pkgRoot, "tsconfig.json")], {
    cwd: pkgRoot,
    stdio: "inherit",
  });
}
