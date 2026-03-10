import type { ExecutionContext, ExecutionResult } from "../../types.js";
import { ensureCommandResolvable } from "../../utils/binary.js";
import { buildEnv, ensurePathInEnv } from "../../utils/env.js";
import { runChildProcess, deriveErrorCode } from "../../utils/process.js";
import { uuidv7 } from "../../utils/uuid.js";

export async function executeProcessAdapter(ctx: ExecutionContext): Promise<ExecutionResult> {
  const runId = ctx.runId ?? uuidv7();
  const cwd = ctx.cwd ?? process.cwd();
  const config = ctx.config ?? {};
  const command = config.command;

  if (!command) {
    return {
      runId,
      exitCode: null,
      signal: null,
      timedOut: false,
      errorMessage: 'Process adapter requires config.command to be set.',
      errorCode: "binary_not_found",
      costUsd: null,
      model: null,
      summary: null,
      sessionParams: null,
      sessionDisplayId: null,
      clearSession: false,
      billingType: null,
    };
  }

  let resolvedBinary;
  try {
    resolvedBinary = await ensureCommandResolvable(command);
  } catch (err) {
    return {
      runId,
      exitCode: null,
      signal: null,
      timedOut: false,
      errorMessage: err instanceof Error ? err.message : "Command not found",
      errorCode: "binary_not_found",
      costUsd: null,
      model: null,
      summary: null,
      sessionParams: null,
      sessionDisplayId: null,
      clearSession: false,
      billingType: null,
    };
  }

  const env = buildEnv(ctx.env);
  ensurePathInEnv(env);

  const proc = await runChildProcess({
    runId,
    command: resolvedBinary.bin,
    args: [...resolvedBinary.prefixArgs, ...(config.extraArgs ?? [])],
    cwd,
    env,
    stdin: ctx.prompt,
    timeoutSec: config.timeoutSec,
    graceSec: config.graceSec,
    onOutput: ctx.onOutput ? async (stream, chunk) => {
      try { await ctx.onOutput!(stream, chunk); } catch { /* swallow */ }
    } : undefined,
  });

  const errorCode = deriveErrorCode(proc);
  const errorMessage = (() => {
    if (proc.timedOut) return `Timed out after ${config.timeoutSec ?? 0}s`;
    if ((proc.exitCode ?? 0) !== 0) {
      const stderrLine = proc.stderr.split(/\r?\n/).map((l) => l.trim()).find(Boolean);
      return stderrLine ?? `Process exited with code ${proc.exitCode ?? -1}`;
    }
    return null;
  })();

  return {
    runId,
    exitCode: proc.exitCode,
    signal: proc.signal ?? null,
    timedOut: proc.timedOut,
    errorMessage,
    errorCode,
    costUsd: null,
    model: null,
    summary: proc.stdout.trim() || null,
    sessionParams: null,
    sessionDisplayId: null,
    clearSession: false,
    billingType: null,
    raw: null,
  };
}
