import * as path from "node:path";
import type { ExecutionContext, ExecutionResult } from "../../types.js";
import { findBinary } from "../../utils/binary.js";
import { buildEnv, ensurePathInEnv } from "../../utils/env.js";
import { runChildProcess, deriveErrorCode } from "../../utils/process.js";
import { resolveInstructions } from "../../utils/instructions.js";
import { prepareWorkspace } from "../../utils/workspace.js";
import type { PreparedWorkspace } from "../../utils/workspace.js";
import { uuidv7 } from "../../utils/uuid.js";
import {
  parseOpenCodeJsonl,
  parseOpenCodeStreamLine,
  isOpenCodeUnknownSessionError,
  isOpenCodeAuthRequired,
} from "./parse.js";
import { prepareOpenCodeSkillConfig } from "./skill-config.js";

export async function executeOpenCodeProvider(ctx: ExecutionContext): Promise<ExecutionResult> {
  const runId = ctx.runId ?? uuidv7();
  let cwd = ctx.cwd ?? process.cwd();
  const model = ctx.model ?? ctx.config?.model ?? "";
  const config = ctx.config ?? {};
  const startedAt = new Date().toISOString();

  // 1. Resolve binary
  ctx.onLifecycle?.({ phase: "preparing", step: "binary" });
  let resolvedBinary;
  try {
    resolvedBinary = await findBinary("opencode", config.command);
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : "Binary not found";
    const completedAt = new Date().toISOString();
    if (ctx.onEvent) {
      try {
        await ctx.onEvent({
          type: "result",
          text: errorMessage,
          costUsd: null,
          isError: true,
          stopReason: null,
          terminalReason: "failed",
          numTurns: null,
          durationMs: new Date(completedAt).getTime() - new Date(startedAt).getTime(),
          timestamp: completedAt,
          providerType: "opencode",
          sessionId: null,
          messageId: null,
          eventId: null,
          turnId: null,
          parentToolCallId: null,
          raw: {},
        });
      } catch {
        // A host event handler cannot fail the execution.
      }
    }
    ctx.onLifecycle?.({ phase: "error", message: errorMessage });
    return {
      runId,
      exitCode: null,
      signal: null,
      status: "failed" as const,
      startedAt,
      completedAt,
      durationMs: Date.now() - new Date(startedAt).getTime(),
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

  // 2. Workspace isolation
  let workspace: PreparedWorkspace | undefined;
  if (config.workspace) {
    ctx.onLifecycle?.({ phase: "preparing", step: "workspace" });
    workspace = await prepareWorkspace(cwd, config.workspace);
    cwd = workspace.cwd;
  }

  // 3. Build env
  const baseEnv = buildEnv(ctx.env);
  ensurePathInEnv(baseEnv);

  // 3. Resolve instructions
  ctx.onLifecycle?.({ phase: "preparing", step: "instructions" });
  const instructions = await resolveInstructions(config.instructionsFile);
  const fullPrompt = instructions ? `${instructions}\n\n${ctx.prompt}` : ctx.prompt;

  // 4. Inject skills through an isolated OpenCode config directory.
  ctx.onLifecycle?.({ phase: "preparing", step: "skills" });
  const skillConfig = await prepareOpenCodeSkillConfig(baseEnv, config.skillDirs);
  const env = skillConfig.env;

  try {
  // 4. Determine session resume
  const sessionParams = ctx.sessionParams ?? null;
  const sessionId = (() => {
    if (!sessionParams) return null;
    const id =
      (sessionParams["sessionId"] as string | undefined) ??
      (sessionParams["session_id"] as string | undefined) ??
      (sessionParams["sessionID"] as string | undefined);
    if (!id || typeof id !== "string") return null;
    const sessionCwd = sessionParams["cwd"] as string | undefined;
    if (sessionCwd && path.resolve(sessionCwd) !== path.resolve(cwd)) return null;
    return id;
  })();

  // 5. Build args
  const buildArgs = (resumeSessionId: string | null): string[] => {
    const args = [...resolvedBinary.prefixArgs, "run", "--format", "json"];
    if (resumeSessionId) args.push("--session", resumeSessionId);
    if (model) args.push("--model", model);
    if (config.modelVariant) args.push("--variant", config.modelVariant);
    const agent = config.planMode ? "plan" : (config.modeId ?? config.mode);
    if (agent) args.push("--agent", agent);
    if (config.extraArgs) args.push(...config.extraArgs);
    return args;
  };

  // 6. Run attempt
  const runAttempt = async (resumeSessionId: string | null) => {
    const args = buildArgs(resumeSessionId);
    let lineBuffer = "";

    ctx.onLifecycle?.({ phase: "spawning" });
    const proc = await runChildProcess({
      runId,
      command: resolvedBinary.bin,
      args,
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
      onOutput: async (stream, chunk) => {
        if (ctx.onOutput) {
          try { await ctx.onOutput(stream, chunk); } catch { /* swallow */ }
        }

        if (stream === "stdout" && ctx.onEvent) {
          lineBuffer += chunk;
          const lines = lineBuffer.split("\n");
          lineBuffer = lines.pop() ?? "";
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            const event = parseOpenCodeStreamLine(trimmed);
            if (event) {
              try { await ctx.onEvent(event); } catch { /* swallow */ }
            }
          }
        }
      },
    });

    if (lineBuffer.trim() && ctx.onEvent) {
      const event = parseOpenCodeStreamLine(lineBuffer.trim());
      if (event) {
        try { await ctx.onEvent(event); } catch { /* swallow */ }
      }
    }

    return proc;
  };

  // 7. Initial attempt
  let proc = await runAttempt(sessionId);
  let clearSession = false;

  // 8. Check for unknown session — retry once
  if (
    sessionId &&
    !proc.timedOut &&
    (proc.exitCode ?? 0) !== 0 &&
    isOpenCodeUnknownSessionError(proc.stdout, proc.stderr)
  ) {
    proc = await runAttempt(null);
    clearSession = true;
  }

  // 9. Parse result
  const parsed = parseOpenCodeJsonl(proc.stdout);
  const processErrorCode = deriveErrorCode(proc);

  let errorCode = processErrorCode;
  if (!errorCode && parsed.errorMessage) {
    errorCode = "execution_error";
  }
  if (!errorCode && isOpenCodeAuthRequired(proc.stdout, proc.stderr)) {
    errorCode = "auth_required";
    if (ctx.onEvent) {
      try {
        await ctx.onEvent({
          type: "auth_required",
          httpStatus: null,
          reason: "missing",
          loginCommand: "opencode auth login",
          message: parsed.errorMessage,
          timestamp: new Date().toISOString(),
          providerType: "opencode",
          sessionId: parsed.sessionId,
          messageId: null,
          eventId: null,
          turnId: null,
          parentToolCallId: null,
          raw: {},
        });
      } catch { /* swallow */ }
    }
  }

  const errorMessage = (() => {
    if (proc.timedOut) return `Timed out after ${config.timeoutSec ?? 0}s`;
    if (errorCode === "auth_required") return "OpenCode requires API key configuration.";
    if (parsed.errorMessage) return parsed.errorMessage;
    if ((proc.exitCode ?? 0) !== 0 && !parsed.summary) {
      const stderrLine = proc.stderr.split(/\r?\n/).map((l) => l.trim()).find(Boolean);
      return stderrLine ?? `OpenCode exited with code ${proc.exitCode ?? -1}`;
    }
    return null;
  })();

  const resolvedSessionId = parsed.sessionId;
  const resultSessionParams = resolvedSessionId ? { sessionId: resolvedSessionId, cwd } : null;
  const completedAt = new Date().toISOString();
  const resolvedModel = model || null;
  const status = proc.aborted ? "aborted" as const
    : proc.timedOut ? "timeout" as const
    : (errorCode || errorMessage) ? "failed" as const
    : "completed" as const;

  if (ctx.onEvent) {
    try {
      await ctx.onEvent({
        type: "result",
        text: parsed.summary ?? errorMessage ?? "",
        costUsd: parsed.costUsd,
        isError: status !== "completed",
        stopReason: null,
        terminalReason: status,
        numTurns: null,
        durationMs: new Date(completedAt).getTime() - new Date(startedAt).getTime(),
        timestamp: completedAt,
        providerType: "opencode",
        sessionId: resolvedSessionId,
        messageId: null,
        eventId: null,
        turnId: null,
        parentToolCallId: null,
        raw: {},
      });
    } catch {
      // A host event handler cannot fail the execution.
    }
  }

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
    durationMs: new Date(completedAt).getTime() - new Date(startedAt).getTime(),
    errorMessage,
    errorCode,
    usage: parsed.usage && resolvedModel
      ? { [resolvedModel]: { inputTokens: parsed.usage.inputTokens, outputTokens: parsed.usage.outputTokens, cachedInputTokens: parsed.usage.cachedInputTokens } }
      : undefined,
    costUsd: parsed.costUsd,
    model: resolvedModel,
    summary: parsed.summary,
    sessionParams: resultSessionParams,
    sessionDisplayId: resolvedSessionId,
    clearSession,
    billingType: "api",
    raw: null,
    workspace,
  };
  } finally {
    await skillConfig.cleanup();
  }
}
