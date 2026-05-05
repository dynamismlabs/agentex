import * as fs from "node:fs/promises";

export async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.lstat(p);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}

export async function ensureDir(p: string): Promise<void> {
  await fs.mkdir(p, { recursive: true });
}

export async function readJsonIfExists<T>(p: string): Promise<T | null> {
  let buf: string;
  try {
    buf = await fs.readFile(p, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  try {
    return JSON.parse(buf) as T;
  } catch (err) {
    // Re-throw as a `SyntaxError` with the path so callers can wrap as a
    // typed error (e.g. `MalformedConfigError`).
    throw new SyntaxError(`Invalid JSON at ${p}: ${(err as Error).message}`);
  }
}

export async function removeRecursive(p: string): Promise<void> {
  await fs.rm(p, { recursive: true, force: true });
}
