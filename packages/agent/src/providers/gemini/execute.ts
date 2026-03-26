import * as path from "node:path";
import type { ExecutionContext, ExecutionResult } from "../../types.js";
import { findBinary } from "../../utils/binary.js";
import { buildEnv, ensurePathInEnv } from "../../utils/env.js";
import { runChildProcess, deriveErrorCode } from "../../utils/process.js";
import { injectHomeSkills } from "../../utils/skills.js";
import { uuidv7 } from "../../utils/uuid.js";
import {
  parseGeminiJsonl,
  parseGeminiStreamLine,
  isGeminiUnknownSessionError,
  isGeminiAuthRequired,
  isGeminiTurnLimit,
} from "./parse.js";

function hasNonEmptyEnvValue(env: Record<string, string>, key: string): boolean {
  const raw = env[key];
  return typeof raw === "string" && raw.trim().length > 0;
}

export async function executeGeminiProvider(ctx: ExecutionContext): Promise<ExecutionResult> {
  const runId = ctx.runId ?? uuidv7();
  const cwd = ctx.cwd ?? process.cwd();
  const model = ctx.model ?? ctx.config?.model;
  const config = ctx.config ?? {};
  const startedAt = new Date().toISOString();

  // 1. Resolve binary
  let resolvedBinary;
  try {
    resolvedBinary = await findBinary("gemini", config.command);
  } catch (err) {
    return {
      runId,
      exitCode: null,
      signal: null,
      timedOut: false,
      startedAt,
      completedAt: new Date().toISOString(),
      durationMs: Date.now() - new Date(startedAt).getTime(),
      errorMessage: err instanceof Error ? err.message : "Binary not found",
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

  // 2. Build env & detect billing
  const env = buildEnv(ctx.env);
  ensurePathInEnv(env);
  const billingType =
    hasNonEmptyEnvValue(env, "GEMINI_API_KEY") || hasNonEmptyEnvValue(env, "GOOGLE_API_KEY")
      ? ("api" as const)
      : ("subscription" as const);

  // 3. Inject skills into ~/.gemini/skills/
  if (config.skillDirs && config.skillDirs.length > 0) {
    try {
      await injectHomeSkills(config.skillDirs, "gemini");
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
      (sessionParams["session_id"] as string | undefined) ??
      (sessionParams["checkpoint_id"] as string | undefined);
    if (!id || typeof id !== "string") return null;
    const sessionCwd = sessionParams["cwd"] as string | undefined;
    if (sessionCwd && path.resolve(sessionCwd) !== path.resolve(cwd)) return null;
    return id;
  })();

  // 5. Build args
  const buildArgs = (resumeSessionId: string | null): string[] => {
    const args = [...resolvedBinary.prefixArgs, "--output-format", "stream-json"];
    if (resumeSessionId) args.push("--resume", resumeSessionId);
    if (model) args.push("--model", model);
    if (config.skipPermissions !== false) {
      args.push("--approval-mode", "yolo");
    }
    if (config.sandbox) {
      args.push("--sandbox");
    } else {
      args.push("--sandbox=none");
    }
    if (config.extraArgs) args.push(...config.extraArgs);
    args.push("--prompt", ctx.prompt);
    return args;
  };

  // 6. Run attempt
  const runAttempt = async (resumeSessionId: string | null) => {
    const args = buildArgs(resumeSessionId);
    let lineBuffer = "";

    const proc = await runChildProcess({
      runId,
      command: resolvedBinary.bin,
      args,
      cwd,
      env,
      timeoutSec: config.timeoutSec,
      graceSec: config.graceSec,
      onStart: ctx.onStart,
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
            for (const event of parseGeminiStreamLine(trimmed)) {
              try { await ctx.onEvent(event); } catch { /* swallow */ }
            }
          }
        }
      },
    });

    if (lineBuffer.trim() && ctx.onEvent) {
      for (const event of parseGeminiStreamLine(lineBuffer.trim())) {
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
    isGeminiUnknownSessionError(proc.stdout, proc.stderr)
  ) {
    proc = await runAttempt(null);
    clearSession = true;
  }

  // 9. Parse result
  const parsed = parseGeminiJsonl(proc.stdout);
  const processErrorCode = deriveErrorCode(proc);

  let errorCode = processErrorCode;
  if (!errorCode && isGeminiAuthRequired(proc.stdout, proc.stderr)) {
    errorCode = "auth_required";
  }
  if (!errorCode && isGeminiTurnLimit(proc.exitCode)) {
    errorCode = "max_turns";
    clearSession = true;
  }

  const errorMessage = (() => {
    if (proc.timedOut) return `Timed out after ${config.timeoutSec ?? 0}s`;
    if (errorCode === "auth_required") return "Gemini requires authentication. Run `gemini auth login`.";
    if (parsed.errorMessage) return parsed.errorMessage;
    if ((proc.exitCode ?? 0) !== 0 && !parsed.summary) {
      const stderrLine = proc.stderr.split(/\r?\n/).map((l) => l.trim()).find(Boolean);
      return stderrLine ?? `Gemini exited with code ${proc.exitCode ?? -1}`;
    }
    return null;
  })();

  const resolvedSessionId = parsed.sessionId;
  const resultSessionParams = resolvedSessionId ? { sessionId: resolvedSessionId, cwd } : null;

  const completedAt = new Date().toISOString();
  return {
    runId,
    exitCode: proc.exitCode,
    signal: proc.signal ?? null,
    timedOut: proc.timedOut,
    startedAt,
    completedAt,
    durationMs: new Date(completedAt).getTime() - new Date(startedAt).getTime(),
    errorMessage,
    errorCode,
    usage: parsed.usage
      ? { inputTokens: parsed.usage.inputTokens, outputTokens: parsed.usage.outputTokens, cachedInputTokens: parsed.usage.cachedInputTokens }
      : undefined,
    costUsd: parsed.costUsd,
    model: parsed.model ?? model ?? null,
    summary: parsed.summary,
    sessionParams: resultSessionParams,
    sessionDisplayId: resolvedSessionId,
    clearSession,
    billingType,
    raw: null,
  };
}
