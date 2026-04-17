import type { ExecutionContext, ExecutionResult } from "../../types.js";
import { ensureCommandResolvable } from "../../utils/binary.js";
import { buildEnv, ensurePathInEnv } from "../../utils/env.js";
import { runChildProcess, deriveErrorCode } from "../../utils/process.js";
import { resolveInstructions } from "../../utils/instructions.js";
import { prepareWorkspace } from "../../utils/workspace.js";
import type { PreparedWorkspace } from "../../utils/workspace.js";
import { uuidv7 } from "../../utils/uuid.js";

export async function executeProcessProvider(ctx: ExecutionContext): Promise<ExecutionResult> {
  const runId = ctx.runId ?? uuidv7();
  let cwd = ctx.cwd ?? process.cwd();
  const config = ctx.config ?? {};
  const startedAt = new Date().toISOString();
  const startMs = Date.now();
  const command = config.command;

  ctx.onLifecycle?.({ phase: "preparing", step: "binary" });
  if (!command) {
    const errorMessage = 'Process provider requires config.command to be set.';
    ctx.onLifecycle?.({ phase: "error", message: errorMessage });
    return {
      runId,
      exitCode: null,
      signal: null,
      status: "failed" as const,
      startedAt,
      completedAt: new Date().toISOString(),
      durationMs: Date.now() - startMs,
      errorMessage,
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
    const errorMessage = err instanceof Error ? err.message : "Command not found";
    ctx.onLifecycle?.({ phase: "error", message: errorMessage });
    return {
      runId,
      exitCode: null,
      signal: null,
      status: "failed" as const,
      startedAt,
      completedAt: new Date().toISOString(),
      durationMs: Date.now() - startMs,
      errorMessage,
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

  // Workspace isolation
  let workspace: PreparedWorkspace | undefined;
  if (config.workspace) {
    ctx.onLifecycle?.({ phase: "preparing", step: "workspace" });
    workspace = await prepareWorkspace(cwd, config.workspace);
    cwd = workspace.cwd;
  }

  const env = buildEnv(ctx.env);
  ensurePathInEnv(env);

  // Resolve instructions
  ctx.onLifecycle?.({ phase: "preparing", step: "instructions" });
  const instructions = await resolveInstructions(config.instructionsFile);
  const fullPrompt = instructions ? `${instructions}\n\n${ctx.prompt}` : ctx.prompt;

  ctx.onLifecycle?.({ phase: "spawning" });
  const proc = await runChildProcess({
    runId,
    command: resolvedBinary.bin,
    args: [...resolvedBinary.prefixArgs, ...(config.extraArgs ?? [])],
    cwd,
    env,
    stdin: fullPrompt,
    timeoutSec: config.timeoutSec,
    graceSec: config.graceSec,
    onStart: (pid) => {
      ctx.onLifecycle?.({ phase: "running", pid });
      ctx.onStart?.(pid);
    },
    signal: ctx.signal,
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

  const completedAt = new Date().toISOString();
  const status = proc.aborted ? "aborted" as const
    : proc.timedOut ? "timeout" as const
    : (errorCode || errorMessage) ? "failed" as const
    : "completed" as const;

  if (status === "completed") {
    ctx.onLifecycle?.({ phase: "completed" });
  } else if (status === "aborted") {
    ctx.onLifecycle?.({ phase: "cancelled" });
  } else {
    ctx.onLifecycle?.({ phase: "error", message: errorMessage ?? "Unknown error" });
  }

  return {
    runId,
    exitCode: proc.exitCode,
    signal: proc.signal ?? null,
    status,
    startedAt,
    completedAt,
    durationMs: new Date(completedAt).getTime() - startMs,
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
    workspace,
  };
}
