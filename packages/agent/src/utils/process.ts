import { spawn } from "node:child_process";
import process from "node:process";

export interface RunProcessOptions {
  runId: string;
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  stdin?: string;
  timeoutSec?: number;
  graceSec?: number;
  maxCaptureBytes?: number;
  onOutput?: (stream: "stdout" | "stderr", chunk: string) => void | Promise<void>;
  onStart?: (pid: number) => void;
}

export interface RunProcessResult {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
}

const DEFAULT_MAX_CAPTURE = 4 * 1024 * 1024; // 4MB
const DEFAULT_GRACE_SEC = 5;

export function deriveErrorCode(result: RunProcessResult): string | null {
  if (result.timedOut) return "timeout";
  if (result.signal && !result.timedOut) return "killed";
  return null;
}

export function killProcessTree(pid: number, signal: NodeJS.Signals = "SIGTERM"): void {
  if (process.platform === "win32") {
    try {
      spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
    } catch {
      // Best effort
    }
    return;
  }

  // Unix: try process group kill
  try {
    process.kill(-pid, signal);
  } catch {
    // Fallback: kill individual process
    try {
      process.kill(pid, signal);
    } catch {
      // Process already dead
    }
  }
}

export function runChildProcess(opts: RunProcessOptions): Promise<RunProcessResult> {
  return new Promise((resolve) => {
    const maxCapture = opts.maxCaptureBytes ?? DEFAULT_MAX_CAPTURE;
    const graceSec = opts.graceSec ?? DEFAULT_GRACE_SEC;

    let stdoutBuf = "";
    let stderrBuf = "";
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timedOut = false;
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
    let graceHandle: ReturnType<typeof setTimeout> | null = null;

    // Chained promise for ordered callback execution
    let callbackChain = Promise.resolve();

    const child = spawn(opts.command, opts.args, {
      cwd: opts.cwd,
      env: opts.env,
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
      detached: process.platform !== "win32", // Enable process group on Unix
    });

    // Notify caller of the child PID
    if (opts.onStart && child.pid != null) {
      opts.onStart(child.pid);
    }

    // Write stdin and close
    if (opts.stdin != null) {
      child.stdin.write(opts.stdin);
    }
    child.stdin.end();

    const appendWithCap = (
      stream: "stdout" | "stderr",
      chunk: string,
    ): void => {
      const bytes = Buffer.byteLength(chunk, "utf-8");
      if (stream === "stdout") {
        if (stdoutBytes < maxCapture) {
          const remaining = maxCapture - stdoutBytes;
          stdoutBuf += bytes <= remaining ? chunk : chunk.slice(0, remaining);
        }
        stdoutBytes += bytes;
      } else {
        if (stderrBytes < maxCapture) {
          const remaining = maxCapture - stderrBytes;
          stderrBuf += bytes <= remaining ? chunk : chunk.slice(0, remaining);
        }
        stderrBytes += bytes;
      }

      if (opts.onOutput) {
        const cb = opts.onOutput;
        callbackChain = callbackChain
          .then(() => cb(stream, chunk))
          .catch(() => {
            // Callback errors must not crash the process
          });
      }
    };

    child.stdout.setEncoding("utf-8");
    child.stderr.setEncoding("utf-8");

    child.stdout.on("data", (chunk: string) => appendWithCap("stdout", chunk));
    child.stderr.on("data", (chunk: string) => appendWithCap("stderr", chunk));

    // Timeout handling
    if (opts.timeoutSec && opts.timeoutSec > 0) {
      timeoutHandle = setTimeout(() => {
        timedOut = true;
        if (child.pid != null) {
          killProcessTree(child.pid, "SIGTERM");
          // Grace period then SIGKILL
          graceHandle = setTimeout(() => {
            if (child.pid != null) {
              killProcessTree(child.pid, "SIGKILL");
            }
          }, graceSec * 1000);
        }
      }, opts.timeoutSec * 1000);
    }

    child.on("close", (code, signal) => {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      if (graceHandle) clearTimeout(graceHandle);

      // Wait for callbacks to complete before resolving
      callbackChain.then(() => {
        resolve({
          exitCode: code,
          signal: signal ?? null,
          timedOut,
          stdout: stdoutBuf,
          stderr: stderrBuf,
        });
      }).catch(() => {
        resolve({
          exitCode: code,
          signal: signal ?? null,
          timedOut,
          stdout: stdoutBuf,
          stderr: stderrBuf,
        });
      });
    });

    child.on("error", (err) => {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      if (graceHandle) clearTimeout(graceHandle);

      resolve({
        exitCode: null,
        signal: null,
        timedOut: false,
        stdout: stdoutBuf,
        stderr: err.message,
      });
    });
  });
}
