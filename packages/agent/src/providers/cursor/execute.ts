import * as path from "node:path";
import type { ExecutionContext, ExecutionResult, StreamEvent } from "../../types.js";
import { buildEnv, ensurePathInEnv } from "../../utils/env.js";
import { runChildProcess, deriveErrorCode } from "../../utils/process.js";
import { detectAuth } from "../../utils/auth.js";
import { injectHomeSkills } from "../../utils/skills.js";
import { resolveInstructions } from "../../utils/instructions.js";
import { prepareWorkspace } from "../../utils/workspace.js";
import type { PreparedWorkspace } from "../../utils/workspace.js";
import { uuidv7 } from "../../utils/uuid.js";
import {
  parseCursorJsonl,
  parseCursorStreamLine,
  normalizeCursorStreamLine,
  isCursorUnknownSessionError,
  isCursorAuthRequired,
} from "./parse.js";
import { findCursorBinary } from "./runtime.js";

export async function executeCursorProvider(ctx: ExecutionContext): Promise<ExecutionResult> {
  const runId = ctx.runId ?? uuidv7();
  let cwd = ctx.cwd ?? process.cwd();
  const model = ctx.model ?? ctx.config?.model ?? "";
  const config = ctx.config ?? {};
  const startedAt = new Date().toISOString();

  // 1. Resolve binary
  ctx.onLifecycle?.({ phase: "preparing", step: "binary" });
  let resolvedBinary;
  try {
    resolvedBinary = await findCursorBinary({ cwd, env: ctx.env, config });
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : "Binary not found";
    ctx.onLifecycle?.({ phase: "error", message: errorMessage });
    return {
      runId,
      exitCode: null,
      signal: null,
      status: "failed" as const,
      startedAt,
      completedAt: new Date().toISOString(),
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

  // 3. Build env & detect auth/billing
  ctx.onLifecycle?.({ phase: "preparing", step: "auth" });
  const env = buildEnv(ctx.env);
  ensurePathInEnv(env);
  const billingType = detectAuth("cursor", env).billingType;

  // 3. Resolve instructions
  ctx.onLifecycle?.({ phase: "preparing", step: "instructions" });
  const instructions = await resolveInstructions(config.instructionsFile);
  const fullPrompt = instructions ? `${instructions}\n\n${ctx.prompt}` : ctx.prompt;

  // 4. Inject skills into ~/.cursor/skills/
  ctx.onLifecycle?.({ phase: "preparing", step: "skills" });
  if (config.skillDirs && config.skillDirs.length > 0) {
    try {
      await injectHomeSkills(config.skillDirs, "cursor");
    } catch {
      // Non-fatal
    }
  }

  // 4. Determine session resume
  const sessionParams = ctx.sessionParams ?? null;
  const sessionId = (() => {
    if (!sessionParams) return null;
    const id =
      (sessionParams["sessionId"] as string | undefined) ??
      (sessionParams["session_id"] as string | undefined);
    if (!id || typeof id !== "string") return null;
    const sessionCwd = sessionParams["cwd"] as string | undefined;
    if (sessionCwd && path.resolve(sessionCwd) !== path.resolve(cwd)) return null;
    return id;
  })();

  // 5. Build args
  const buildArgs = (resumeSessionId: string | null): string[] => {
    const args = [...resolvedBinary.prefixArgs, "-p", "--output-format", "stream-json"];
    if (resumeSessionId) args.push("--resume", resumeSessionId);
    if (model) args.push("--model", model);
    const selectedMode = config.planMode ? "plan" : (config.modeId ?? config.mode);
    if (selectedMode) args.push("--mode", selectedMode);
    if (config.skipPermissions) args.push("--force");
    if (config.extraArgs) args.push(...config.extraArgs);
    return args;
  };

  // 6. Run attempt
  const runAttempt = async (resumeSessionId: string | null) => {
    const args = buildArgs(resumeSessionId);
    let stdoutLineBuffer = "";
    let accepted = false;
    let protocolViolation = false;
    const bufferedEvents: StreamEvent[] = [];
    const bufferedOutput: Array<{ stream: "stdout" | "stderr"; chunk: string }> = [];

    const flushOutput = async (): Promise<void> => {
      if (!ctx.onOutput) return;
      for (const output of bufferedOutput.splice(0)) {
        try { await ctx.onOutput(output.stream, output.chunk); } catch { /* swallow */ }
      }
    };

    const dispatchOutput = async (stream: "stdout" | "stderr", chunk: string): Promise<void> => {
      if (!accepted) {
        bufferedOutput.push({ stream, chunk });
        return;
      }
      if (ctx.onOutput) {
        try { await ctx.onOutput(stream, chunk); } catch { /* swallow */ }
      }
    };

    const dispatch = async (event: StreamEvent): Promise<void> => {
      if (!accepted) {
        bufferedEvents.push(event);
        if (event.type !== "system" || event.subtype !== "init") {
          if (event.type !== "unknown") protocolViolation = true;
          return;
        }
        if (protocolViolation) return;
        accepted = true;
        await flushOutput();
        if (ctx.onEvent) {
          for (const buffered of bufferedEvents.splice(0)) {
            try { await ctx.onEvent(buffered); } catch { /* swallow */ }
          }
        }
        return;
      }
      if (ctx.onEvent) {
        try { await ctx.onEvent(event); } catch { /* swallow */ }
      }
    };

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
        if (stream !== "stdout") {
          await dispatchOutput(stream, chunk);
          return;
        }

        // Buffer stdout and normalize cursor stream lines
        stdoutLineBuffer += chunk;
        const lines = stdoutLineBuffer.split("\n");
        stdoutLineBuffer = lines.pop() ?? "";

        for (const rawLine of lines) {
          const normalized = normalizeCursorStreamLine(rawLine);
          if (!normalized.line) continue;

          await dispatchOutput(normalized.stream ?? "stdout", `${normalized.line}\n`);

          const event = parseCursorStreamLine(rawLine);
          if (event) await dispatch(event);
        }
      },
    });

    // Flush remaining buffer
    if (stdoutLineBuffer.trim()) {
      const normalized = normalizeCursorStreamLine(stdoutLineBuffer);
      if (normalized.line) await dispatchOutput(normalized.stream ?? "stdout", `${normalized.line}\n`);
      const event = parseCursorStreamLine(stdoutLineBuffer);
      if (event) await dispatch(event);
    }

    return { proc, accepted, protocolViolation: protocolViolation || (!accepted && proc.exitCode === 0) };
  };

  // 7. Initial attempt
  let attempt = await runAttempt(sessionId);
  let proc = attempt.proc;
  let clearSession = false;

  // 8. Check for unknown session — retry once
  if (
    sessionId &&
    !proc.timedOut &&
    (proc.exitCode ?? 0) !== 0 &&
    !attempt.accepted &&
    isCursorUnknownSessionError(proc.stdout, proc.stderr)
  ) {
    attempt = await runAttempt(null);
    proc = attempt.proc;
    clearSession = true;
  }

  // 9. Parse result
  const parsed = parseCursorJsonl(proc.stdout);
  const processErrorCode = deriveErrorCode(proc);

  let errorCode = processErrorCode;
  if (attempt.protocolViolation) errorCode = "protocol_degraded";
  if (!errorCode && isCursorAuthRequired(proc.stdout, proc.stderr)) {
    errorCode = "auth_required";
    if (ctx.onEvent) {
      try {
        await ctx.onEvent({
          type: "auth_required",
          httpStatus: null,
          reason: "missing",
          loginCommand: "cursor-agent login",
          message: parsed.errorMessage,
          timestamp: new Date().toISOString(),
          providerType: "cursor",
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
    if (errorCode === "auth_required") return "Cursor requires authentication.";
    if (errorCode === "protocol_degraded") {
      return "Cursor did not emit the supported stream-json acceptance marker before visible output.";
    }
    if (parsed.errorMessage) return parsed.errorMessage;
    if ((proc.exitCode ?? 0) !== 0 && !parsed.summary) {
      const stderrLine = proc.stderr.split(/\r?\n/).map((l) => l.trim()).find(Boolean);
      return stderrLine ?? `Cursor exited with code ${proc.exitCode ?? -1}`;
    }
    return null;
  })();

  const resolvedSessionId = parsed.sessionId;
  const resultSessionParams = resolvedSessionId ? { sessionId: resolvedSessionId, cwd } : null;

  const completedAt = new Date().toISOString();
  const resolvedModel = parsed.model ?? model ?? null;
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
    billingType,
    raw: null,
    workspace,
  };
}
