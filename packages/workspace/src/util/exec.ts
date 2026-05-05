import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type ExecResult = {
  stdout: string;
  stderr: string;
};

export async function execFileSafe(
  file: string,
  args: readonly string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
): Promise<ExecResult> {
  const result = await execFileAsync(file, args as string[], {
    cwd: options.cwd,
    env: options.env,
    timeout: options.timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
  });
  return { stdout: result.stdout.toString(), stderr: result.stderr.toString() };
}

export type ExecFullResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

/**
 * Like `execFileSafe`, but returns the full `{stdout, stderr, exitCode}` for
 * non-zero exits instead of throwing. Used by the `git.raw` escape hatch so
 * consumers can inspect failed commands without losing stdout/stderr.
 *
 * Spawn-not-found (`ENOENT`) still rejects — the consumer needs to know git
 * itself isn't on PATH; it's not a normal command failure.
 */
export async function execFileResult(
  file: string,
  args: readonly string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
): Promise<ExecFullResult> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args as string[],
      {
        cwd: options.cwd,
        env: options.env,
        timeout: options.timeoutMs,
        maxBuffer: 64 * 1024 * 1024,
      },
      (err, stdout, stderr) => {
        const stdoutText = stdout?.toString() ?? "";
        const stderrText = stderr?.toString() ?? "";
        if (err) {
          const code = (err as NodeJS.ErrnoException).code;
          if (code === "ENOENT") {
            reject(err);
            return;
          }
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
  });
}

export type ShellOneShotResult = {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
};

export async function runShellOneShot(
  command: string,
  options: { cwd: string; env?: NodeJS.ProcessEnv },
): Promise<ShellOneShotResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, {
      cwd: options.cwd,
      env: options.env,
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (err) => reject(err));
    child.on("close", (exitCode, signal) => {
      resolve({ exitCode, signal, stdout, stderr });
    });
  });
}
