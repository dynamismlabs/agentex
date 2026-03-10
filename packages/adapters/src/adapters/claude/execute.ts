import * as path from "node:path";
import type { ExecutionContext, ExecutionResult } from "../../types.js";
import { findBinary } from "../../utils/binary.js";
import { buildEnv, ensurePathInEnv } from "../../utils/env.js";
import { runChildProcess, deriveErrorCode } from "../../utils/process.js";
import { buildSkillsDir, cleanupSkillsDir } from "../../utils/skills.js";
import { uuidv7 } from "../../utils/uuid.js";
import { parseClaudeStreamJson, parseStreamLine, isClaudeUnknownSessionError, isClaudeAuthRequired } from "./parse.js";

function hasNonEmptyEnvValue(env: Record<string, string>, key: string): boolean {
  const raw = env[key];
  return typeof raw === "string" && raw.trim().length > 0;
}

export async function executeClaudeAdapter(ctx: ExecutionContext): Promise<ExecutionResult> {
  const runId = ctx.runId ?? uuidv7();
  const cwd = ctx.cwd ?? process.cwd();
  const model = ctx.model ?? ctx.config?.model;
  const config = ctx.config ?? {};

  // 1. Resolve binary
  let resolvedBinary;
  try {
    resolvedBinary = await findBinary("claude", config.command);
  } catch (err) {
    return {
      runId,
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
  const billingType = hasNonEmptyEnvValue(env, "ANTHROPIC_API_KEY") ? "api" as const : "subscription" as const;

  // 3. Build skills dir
  let skillsDir: string | null = null;
  if (config.skillDirs && config.skillDirs.length > 0) {
    try {
      skillsDir = await buildSkillsDir(config.skillDirs, "claude");
    } catch {
      // Skill injection failure is non-fatal
    }
  }

  // 4. Build args
  const buildArgs = (resumeSessionId: string | null): string[] => {
    const args = [...resolvedBinary.prefixArgs, "--print", "-", "--output-format", "stream-json", "--verbose"];
    if (resumeSessionId) args.push("--resume", resumeSessionId);
    if (config.skipPermissions) args.push("--dangerously-skip-permissions");
    if (model) args.push("--model", model);
    if (config.effort) args.push("--effort", config.effort);
    if (config.maxTurns && config.maxTurns > 0) args.push("--max-turns", String(config.maxTurns));
    if (config.instructionsFile) args.push("--append-system-prompt-file", config.instructionsFile);
    if (skillsDir) args.push("--add-dir", skillsDir);
    if (config.mcpServers) {
      for (const mcp of config.mcpServers) {
        args.push("--mcp-server", mcp.name, "--", mcp.command, ...(mcp.args ?? []));
      }
    }
    if (config.extraArgs) args.push(...config.extraArgs);
    return args;
  };

  // 5. Determine session resume
  const sessionParams = ctx.sessionParams ?? null;
  const sessionId = (() => {
    if (!sessionParams) return null;
    const id = sessionParams["sessionId"] as string | undefined ?? sessionParams["session_id"] as string | undefined;
    if (!id || typeof id !== "string") return null;
    const sessionCwd = sessionParams["cwd"] as string | undefined;
    if (sessionCwd && path.resolve(sessionCwd) !== path.resolve(cwd)) return null;
    return id;
  })();

  // 6. Run attempt
  const runAttempt = async (resumeSessionId: string | null) => {
    const args = buildArgs(resumeSessionId);

    // stdout line buffer for real-time event parsing
    let lineBuffer = "";

    const proc = await runChildProcess({
      runId,
      command: resolvedBinary.bin,
      args,
      cwd,
      env,
      stdin: ctx.prompt,
      timeoutSec: config.timeoutSec,
      graceSec: config.graceSec,
      onOutput: async (stream, chunk) => {
        // Forward raw output
        if (ctx.onOutput) {
          try { await ctx.onOutput(stream, chunk); } catch { /* swallow */ }
        }

        // Parse stdout lines for stream events
        if (stream === "stdout" && ctx.onEvent) {
          lineBuffer += chunk;
          const lines = lineBuffer.split("\n");
          // Keep the last (possibly incomplete) line in the buffer
          lineBuffer = lines.pop() ?? "";
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            for (const event of parseStreamLine(trimmed)) {
              try { await ctx.onEvent(event); } catch { /* swallow */ }
            }
          }
        }
      },
    });

    // Parse remaining buffer
    if (lineBuffer.trim() && ctx.onEvent) {
      for (const event of parseStreamLine(lineBuffer.trim())) {
        try { await ctx.onEvent(event); } catch { /* swallow */ }
      }
    }

    return proc;
  };

  try {
    // 7. Initial attempt
    let proc = await runAttempt(sessionId);
    let clearSession = false;

    // 8. Check for unknown session — retry once
    if (
      sessionId &&
      !proc.timedOut &&
      (proc.exitCode ?? 0) !== 0 &&
      isClaudeUnknownSessionError(proc.stdout, proc.stderr)
    ) {
      proc = await runAttempt(null);
      clearSession = true;
    }

    // 9. Parse result
    const parsed = parseClaudeStreamJson(proc.stdout);
    const processErrorCode = deriveErrorCode(proc);

    // Determine error code: process-level errors take precedence, then adapter-specific
    let errorCode = processErrorCode;
    if (!errorCode && parsed.errorCode) {
      errorCode = parsed.errorCode;
    }
    if (!errorCode && isClaudeAuthRequired(proc.stdout, proc.stderr)) {
      errorCode = "auth_required";
    }

    const errorMessage = (() => {
      if (proc.timedOut) return `Timed out after ${config.timeoutSec ?? 0}s`;
      if (errorCode === "auth_required") return "Claude requires authentication. Run `claude login`.";
      if ((proc.exitCode ?? 0) !== 0 && !parsed.summary) {
        const stderrLine = proc.stderr.split(/\r?\n/).map((l) => l.trim()).find(Boolean);
        return stderrLine ?? `Claude exited with code ${proc.exitCode ?? -1}`;
      }
      if (parsed.isError) return parsed.summary;
      return null;
    })();

    const resolvedSessionId = parsed.sessionId;
    const resultSessionParams = resolvedSessionId
      ? { sessionId: resolvedSessionId, cwd }
      : null;

    return {
      runId,
      exitCode: proc.exitCode,
      signal: proc.signal ?? null,
      timedOut: proc.timedOut,
      errorMessage,
      errorCode,
      usage: parsed.usage
        ? {
            inputTokens: parsed.usage.inputTokens,
            outputTokens: parsed.usage.outputTokens,
            cachedInputTokens: parsed.usage.cachedInputTokens,
          }
        : undefined,
      costUsd: parsed.costUsd,
      model: parsed.model,
      summary: parsed.summary,
      sessionParams: resultSessionParams,
      sessionDisplayId: resolvedSessionId,
      clearSession,
      billingType,
      raw: null,
    };
  } finally {
    // 10. Clean up skills dir
    if (skillsDir) {
      await cleanupSkillsDir(skillsDir);
    }
  }
}
