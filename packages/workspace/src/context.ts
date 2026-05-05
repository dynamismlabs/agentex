import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ContextDir } from "./types.js";
import { ensureDir, pathExists } from "./util/fs.js";

const CONTEXT_DIR_NAME = ".context";
const ATTACHMENTS_SUBDIR = "attachments";

function resolveRel(contextRoot: string, rel: string): string {
  if (typeof rel !== "string" || rel.length === 0) {
    throw new Error("ContextDir: relative path must be a non-empty string");
  }
  if (path.isAbsolute(rel)) {
    throw new Error(`ContextDir: relative path must not be absolute (got: ${rel})`);
  }
  const resolved = path.resolve(contextRoot, rel);
  const rootWithSep = contextRoot.endsWith(path.sep) ? contextRoot : contextRoot + path.sep;
  if (resolved !== contextRoot && !resolved.startsWith(rootWithSep)) {
    throw new Error(
      `ContextDir: relative path escapes .context/ (rel: ${rel}, resolved: ${resolved})`,
    );
  }
  return resolved;
}

async function chooseUniqueAttachmentName(attachmentsDir: string, basename: string): Promise<string> {
  const ext = path.extname(basename);
  const stem = ext.length > 0 ? basename.slice(0, basename.length - ext.length) : basename;

  let candidate = basename;
  let n = 2;
  while (await pathExists(path.join(attachmentsDir, candidate))) {
    candidate = `${stem} (${n})${ext}`;
    n += 1;
  }
  return candidate;
}

export function createContextDir(workspacePath: string): ContextDir {
  const contextRoot = path.join(workspacePath, CONTEXT_DIR_NAME);

  async function read(rel: string): Promise<string> {
    const target = resolveRel(contextRoot, rel);
    return fs.readFile(target, "utf-8");
  }

  async function write(rel: string, body: string): Promise<void> {
    const target = resolveRel(contextRoot, rel);
    await ensureDir(path.dirname(target));
    await fs.writeFile(target, body, "utf-8");
  }

  async function attach(srcPath: string): Promise<string> {
    if (!path.isAbsolute(srcPath)) {
      throw new Error(`ContextDir.attach: srcPath must be an absolute path (got: ${srcPath})`);
    }
    if (!(await pathExists(srcPath))) {
      throw new Error(`ContextDir.attach: source file does not exist (path: ${srcPath})`);
    }
    const attachmentsDir = path.join(contextRoot, ATTACHMENTS_SUBDIR);
    await ensureDir(attachmentsDir);

    const basename = path.basename(srcPath);
    const finalName = await chooseUniqueAttachmentName(attachmentsDir, basename);
    const dest = path.join(attachmentsDir, finalName);
    await fs.copyFile(srcPath, dest);
    return dest;
  }

  async function list(subdir?: string): Promise<string[]> {
    const target = subdir === undefined ? contextRoot : resolveRel(contextRoot, subdir);
    if (!(await pathExists(target))) return [];
    return fs.readdir(target);
  }

  return {
    dir: contextRoot,
    read,
    write,
    attach,
    list,
  };
}
