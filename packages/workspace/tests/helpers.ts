import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { randomBytes } from "node:crypto";

export async function makeTmpDir(label: string): Promise<string> {
  const id = randomBytes(6).toString("hex");
  const dir = path.join(os.tmpdir(), `agentex-workspace-test-${label}-${id}`);
  await fs.mkdir(dir, { recursive: true });
  // Return the realpath so tests on macOS (where `/var` is a symlink to
  // `/private/var`) compare consistently against handles whose paths the
  // library has canonicalized.
  return fs.realpath(dir);
}

export async function removeTmpDir(dir: string): Promise<void> {
  try {
    await fs.rm(dir, { recursive: true, force: true });
  } catch {
    // best effort
  }
}

export async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.lstat(p);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}

export async function readUtf8(p: string): Promise<string> {
  return fs.readFile(p, "utf-8");
}

export async function writeUtf8(p: string, body: string): Promise<void> {
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, body, "utf-8");
}
