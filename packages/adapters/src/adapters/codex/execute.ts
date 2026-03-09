import * as path from "node:path";
import type { ExecutionContext, ExecutionResult } from "../../types.js";
import { findBinary } from "../../utils/binary.js";
import { buildEnv, ensurePathInEnv } from "../../utils/env.js";
import { runChildProcess, deriveErrorCode } from "../../utils/process.js";
import { buildSkillsDir, cleanupSkillsDir } from "../../utils/skills.js";
import {
  parseCodexJsonl,
  parseCodexStreamLine,
  stripCodexRolloutNoise,
  isCodexAuthRequired,
  isCodexUnknownSessionError,
} from "./parse.js";

function hasNonEmptyEnvValue(env: Record<string, string>, key: string): boolean {
  const raw = env[key];
  return typeof raw === "string" && raw.trim().length > 0;
}

export async function executeCodexAdapter(ctx: ExecutionContext): Promise<ExecutionResult> {
  const config = ctx.config ?? {};

  // 1. Resolve binary
  let resolvedBinary;
  try {
    resolvedBinary = await findBinary("codex", config.command);
  } catch (err) {
    return {
      exitCode: null,
      signal: null,
      timedOut: false,
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
  const billingType = hasNonEmptyEnvValue(env, "OPENAI_API_KEY") ? "api" as const : "subscription" as const;

  // 3. Build skills dir
  let skillsDir: string | null = null;
  if (config.skillDirs && config.skillDirs.length > 0) {
    try {
      skillsDir = await buildSkillsDir(config.skillDirs, "codex");
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
      (sessionParams["thread_id"] as string | undefined);
    if (!id || typeof id !== "string") return null;
    const sessionCwd = sessionParams["cwd"] as string | undefined;
    if (sessionCwd && path.resolve(sessionCwd) !== path.resolve(ctx.cwd)) return null;
    return id;
  })();

  // 5. Build args
  const buildArgs = (resumeSessionId: string | null): string[] => {
    const args = [...resolvedBinary.prefixArgs, "exec", "--json"];
    if (config.skipPermissions) args.push("--dangerously-bypass-approvals-and-sandbox");
    if (config.model) args.push("--model", config.model);
    if (config.extraArgs) args.push(...config.extraArgs);
    if (resumeSessionId) {
      args.push("resume", resumeSessionId, "-");
    } else {
      args.push("-");
    }
    return args;
  };

  // 6. Run attempt
  const runAttempt = async (resumeSessionId: string | null) => {
    const args = buildArgs(resumeSessionId);
    let lineBuffer = "";

    const proc = await runChildProcess({
      runId: ctx.runId,
      command: resolvedBinary.bin,
      args,
      cwd: ctx.cwd,
      env,
      stdin: ctx.prompt,
      timeoutSec: config.timeoutSec,
      graceSec: config.graceSec,
      onOutput: async (stream, chunk) => {
        if (stream === "stderr") {
          // Filter rollout noise before forwarding
          const cleaned = stripCodexRolloutNoise(chunk);
          if (cleaned.trim() && ctx.onOutput) {
            try { await ctx.onOutput(stream, cleaned); } catch { /* swallow */ }
          }
        } else {
          if (ctx.onOutput) {
            try { await ctx.onOutput(stream, chunk); } catch { /* swallow */ }
          }

          // Parse stdout lines for stream events
          if (ctx.onEvent) {
            lineBuffer += chunk;
            const lines = lineBuffer.split("\n");
            lineBuffer = lines.pop() ?? "";
            for (const line of lines) {
              const trimmed = line.trim();
              if (!trimmed) continue;
              const event = parseCodexStreamLine(trimmed);
              if (event) {
                try { await ctx.onEvent(event); } catch { /* swallow */ }
              }
            }
          }
        }
      },
    });

    if (lineBuffer.trim() && ctx.onEvent) {
      const event = parseCodexStreamLine(lineBuffer.trim());
      if (event) {
        try { await ctx.onEvent(event); } catch { /* swallow */ }
      }
    }

    return proc;
  };

  try {
    let proc = await runAttempt(sessionId);
    let clearSession = false;

    // Check for unknown session — retry once
    if (
      sessionId &&
      !proc.timedOut &&
      (proc.exitCode ?? 0) !== 0 &&
      isCodexUnknownSessionError(proc.stdout, proc.stderr)
    ) {
      proc = await runAttempt(null);
      clearSession = true;
    }

    const parsed = parseCodexJsonl(proc.stdout);
    const processErrorCode = deriveErrorCode(proc);

    let errorCode = processErrorCode;
    if (!errorCode && isCodexAuthRequired(proc.stdout, proc.stderr)) {
      errorCode = "auth_required";
    }

    const errorMessage = (() => {
      if (proc.timedOut) return `Timed out after ${config.timeoutSec ?? 0}s`;
      if (errorCode === "auth_required") return "Codex requires OPENAI_API_KEY.";
      if ((proc.exitCode ?? 0) !== 0) {
        return parsed.errorMessage ?? stripCodexRolloutNoise(proc.stderr).split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? `Codex exited with code ${proc.exitCode ?? -1}`;
      }
      if (parsed.isError) return parsed.errorMessage;
      return null;
    })();

    const resolvedSessionId = parsed.sessionId;
    const resultSessionParams = resolvedSessionId
      ? { sessionId: resolvedSessionId, cwd: ctx.cwd }
      : null;

    return {
      exitCode: proc.exitCode,
      signal: proc.signal ?? null,
      timedOut: proc.timedOut,
      errorMessage,
      errorCode,
      usage: parsed.usage
        ? { inputTokens: parsed.usage.inputTokens, outputTokens: parsed.usage.outputTokens }
        : undefined,
      costUsd: null,
      model: parsed.model ?? config.model ?? null,
      summary: parsed.summary,
      sessionParams: resultSessionParams,
      sessionDisplayId: resolvedSessionId,
      clearSession,
      billingType,
      raw: null,
    };
  } finally {
    if (skillsDir) {
      await cleanupSkillsDir(skillsDir);
    }
  }
}
