import * as fs from "node:fs/promises";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ensureDir } from "../src/util/fs.js";

const exec = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<{ stdout: string; stderr: string }> {
  const result = await exec("git", args, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
  return { stdout: result.stdout.toString(), stderr: result.stderr.toString() };
}

export async function initRepo(repoPath: string): Promise<void> {
  await ensureDir(repoPath);
  await git(repoPath, "init", "-b", "main");
  await git(repoPath, "config", "user.email", "test@example.com");
  await git(repoPath, "config", "user.name", "Workspace Test");
  await git(repoPath, "config", "commit.gpgsign", "false");
}

export async function writeRepoFile(
  repoPath: string,
  relPath: string,
  content: string,
): Promise<void> {
  const target = path.join(repoPath, relPath);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content, "utf-8");
}

export async function commitFile(
  repoPath: string,
  relPath: string,
  content: string,
  message: string,
): Promise<string> {
  await writeRepoFile(repoPath, relPath, content);
  await git(repoPath, "add", relPath);
  await git(repoPath, "commit", "-m", message);
  const { stdout } = await git(repoPath, "rev-parse", "HEAD");
  return stdout.trim();
}

export async function headSha(repoPath: string, ref: string = "HEAD"): Promise<string> {
  const { stdout } = await git(repoPath, "rev-parse", ref);
  return stdout.trim();
}

export async function createBranch(repoPath: string, branch: string, fromRef: string): Promise<void> {
  await git(repoPath, "branch", branch, fromRef);
}

/**
 * Sets up a repo with a small initial history and three top-level dirs so
 * sparse-checkout tests have something to exclude:
 *   README.md
 *   packages/foo/index.ts
 *   packages/bar/index.ts
 *   apps/web/main.ts
 */
export async function setupRepoWithMultipleDirs(repoPath: string): Promise<void> {
  await initRepo(repoPath);
  await commitFile(repoPath, "README.md", "# repo\n", "initial");
  await commitFile(repoPath, "packages/foo/index.ts", "export const foo = 1;\n", "add foo");
  await commitFile(repoPath, "packages/bar/index.ts", "export const bar = 1;\n", "add bar");
  await commitFile(repoPath, "apps/web/main.ts", "console.log('web');\n", "add web");
}

export async function setupSimpleRepo(repoPath: string): Promise<void> {
  await initRepo(repoPath);
  await commitFile(repoPath, "README.md", "# repo\n", "initial");
}

export async function initBareRemote(repoPath: string): Promise<void> {
  const { ensureDir } = await import("../src/util/fs.js");
  await ensureDir(repoPath);
  try {
    await git(repoPath, "init", "--bare", "-b", "main");
  } catch {
    await git(repoPath, "init", "--bare");
    await git(repoPath, "symbolic-ref", "HEAD", "refs/heads/main");
  }
}

export async function addOrigin(repoPath: string, remotePath: string): Promise<void> {
  await git(repoPath, "remote", "add", "origin", remotePath);
}

export async function pushBranch(
  repoPath: string,
  branch: string,
  remote = "origin",
): Promise<void> {
  await git(repoPath, "push", "-u", remote, branch);
}

export { git };
