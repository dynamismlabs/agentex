import { execFile } from "node:child_process";
import { NotInstalledError } from "../errors.js";

export interface GhExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export type GhExecutor = (
  args: readonly string[],
  opts: { cwd?: string; input?: string },
) => Promise<GhExecResult>;

function defaultExecutor(
  args: readonly string[],
  opts: { cwd?: string; input?: string },
): Promise<GhExecResult> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      "gh",
      args as string[],
      {
        cwd: opts.cwd,
        maxBuffer: 64 * 1024 * 1024,
        env: { ...process.env, GH_PROMPT_DISABLED: "1" },
      },
      (err, stdout, stderr) => {
        const stdoutText = stdout?.toString() ?? "";
        const stderrText = stderr?.toString() ?? "";
        if (err) {
          const code = (err as NodeJS.ErrnoException).code;
          if (code === "ENOENT") {
            reject(new NotInstalledError());
            return;
          }
          // execFile signals non-zero exit with `err.code` set to the exit
          // number (when not ENOENT). Surface as a normal result so callers
          // can map exit code + stderr to typed errors.
          const exitCode =
            typeof (err as { code?: unknown }).code === "number"
              ? ((err as { code: number }).code as number)
              : 1;
          resolve({ stdout: stdoutText, stderr: stderrText, exitCode });
          return;
        }
        resolve({ stdout: stdoutText, stderr: stderrText, exitCode: 0 });
      },
    );
    if (opts.input !== undefined) {
      child.stdin?.write(opts.input);
      child.stdin?.end();
    }
  });
}

let currentExecutor: GhExecutor = defaultExecutor;

export async function ghExec(
  args: readonly string[],
  opts: { cwd?: string; input?: string } = {},
): Promise<GhExecResult> {
  return currentExecutor(args, opts);
}

/** Internal — only used by tests to swap a stub executor in. */
export function _setGhExecutor(fn: GhExecutor): void {
  currentExecutor = fn;
}

/** Internal — restores the real executor after a test replaces it. */
export function _resetGhExecutor(): void {
  currentExecutor = defaultExecutor;
}
