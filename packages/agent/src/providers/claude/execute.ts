import * as path from "node:path";
import type { ExecutionContext, ExecutionResult } from "../../types.js";
import { findBinary } from "../../utils/binary.js";
import { buildEnv, ensurePathInEnv } from "../../utils/env.js";
import { runChildProcess, deriveErrorCode } from "../../utils/process.js";
import { detectAuth } from "../../utils/auth.js";
import { buildSkillsDir, cleanupSkillsDir } from "../../utils/skills.js";
import { uuidv7 } from "../../utils/uuid.js";
import { prepareWorkspace } from "../../utils/workspace.js";
import type { PreparedWorkspace } from "../../utils/workspace.js";
import { parseClaudeStreamJson, parseStreamLine, isClaudeUnknownSessionError, isClaudeAuthRequired } from "./parse.js";

export async function executeClaudeProvider(ctx: ExecutionContext): Promise<ExecutionResult> {
  const runId = ctx.runId ?? uuidv7();
  let cwd = ctx.cwd ?? process.cwd();
  const config = ctx.config ?? {};
  const rawModel = ctx.model ?? config.model;
  const startedAt = new Date().toISOString();

  // 1. Resolve binary
  ctx.onLifecycle?.({ phase: "preparing", step: "binary" });
  let resolvedBinary;
  try {
    resolvedBinary = await findBinary("claude", config.command);
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
  const auth = detectAuth("claude", env);
  const billingType = auth.billingType;
  const model = rawModel && auth.resolveModelId ? auth.resolveModelId(rawModel) : rawModel;

  // 3. Build skills dir
  ctx.onLifecycle?.({ phase: "preparing", step: "skills" });
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

    ctx.onLifecycle?.({ phase: "spawning" });
    const proc = await runChildProcess({
      runId,
      command: resolvedBinary.bin,
      args,
      cwd,
      env,
      stdin: ctx.prompt,
      timeoutSec: config.timeoutSec,
      graceSec: config.graceSec,
      onStart: (pid) => {
        ctx.onLifecycle?.({ phase: "running", pid });
        ctx.onStart?.(pid);
      },
      signal: ctx.signal,
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

    // Determine error code: process-level errors take precedence, then provider-specific
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
      usage: parsed.modelUsage ?? undefined,
      costUsd: parsed.costUsd,
      model: resolvedModel,
      summary: parsed.summary,
      sessionParams: resultSessionParams,
      sessionDisplayId: resolvedSessionId,
      clearSession,
      billingType,
      stopReason: parsed.stopReason,
      terminalReason: parsed.terminalReason,
      numTurns: parsed.numTurns,
      durationApiMs: parsed.durationApiMs,
      permissionDenials: parsed.permissionDenials ?? undefined,
      rateLimits: parsed.rateLimits.length > 0 ? parsed.rateLimits : undefined,
      raw: parsed.finalEvent,
      workspace,
    };
  } finally {
    // 10. Clean up skills dir
    if (skillsDir) {
      await cleanupSkillsDir(skillsDir);
    }
  }
}
