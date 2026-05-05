import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ghExec } from "./internal/gh-exec.js";
import { NotInstalledError } from "./errors.js";
import type { AuthenticatedStatus, InstalledStatus } from "./types.js";

const execFileAsync = promisify(execFile);

export async function checkInstalled(): Promise<InstalledStatus> {
  let result;
  try {
    result = await ghExec(["--version"]);
  } catch (err) {
    if (err instanceof NotInstalledError) return { installed: false };
    throw err;
  }
  if (result.exitCode !== 0) return { installed: false };

  // Output (line 1): "gh version 2.74.2 (2025-06-17)"
  const versionMatch = result.stdout.match(/^gh version (\S+)/m);
  const version = versionMatch?.[1];

  // Best-effort PATH lookup so the consumer can show "found at /opt/homebrew/bin/gh".
  let pathFound: string | undefined;
  try {
    const which = await execFileAsync("which", ["gh"]);
    const trimmed = which.stdout.toString().trim();
    if (trimmed.length > 0) pathFound = trimmed;
  } catch {
    // ignore — `which` may not exist on minimal Linux images.
  }

  const status: InstalledStatus = { installed: true };
  if (version !== undefined) status.version = version;
  if (pathFound !== undefined) status.path = pathFound;
  return status;
}

const AUTH_USER_RE = /Logged in to (\S+)\s+(?:as|account)\s+(\S+)/;

export async function checkAuthenticated(): Promise<AuthenticatedStatus> {
  let result;
  try {
    result = await ghExec(["auth", "status"]);
  } catch (err) {
    if (err instanceof NotInstalledError) return { authenticated: false };
    throw err;
  }

  // `gh auth status` writes its human-readable summary to stderr regardless of
  // exit code; recent versions still send the auth summary there.
  const text = result.stderr.length > 0 ? result.stderr : result.stdout;
  if (result.exitCode !== 0) {
    return { authenticated: false };
  }

  const m = text.match(AUTH_USER_RE);
  if (m) {
    const status: AuthenticatedStatus = { authenticated: true };
    if (m[1]) status.host = m[1];
    if (m[2]) status.user = m[2];
    return status;
  }

  return { authenticated: result.exitCode === 0 };
}
