import * as path from "node:path";
import type { ExecutionContext, ExecutionResult } from "../../types.js";
import { findBinary } from "../../utils/binary.js";
import { buildEnv, ensurePathInEnv } from "../../utils/env.js";
import { translateEndpoint } from "../../utils/endpoint.js";
import { runChildProcess, deriveErrorCode } from "../../utils/process.js";
import { detectAuth } from "../../utils/auth.js";
import { buildSkillsDir, cleanupSkillsDir } from "../../utils/skills.js";
import { claudeFeatureArgs, cleanupMcpConfig, stageMcpConfig } from "./mcp.js";
import { createToolNameTracker } from "../../utils/tool-names.js";
import { uuidv7 } from "../../utils/uuid.js";
import { prepareWorkspace } from "../../utils/workspace.js";
import type { PreparedWorkspace } from "../../utils/workspace.js";
import { parseClaudeStreamJson, parseStreamLine, isClaudeUnknownSessionError, isClaudeAuthRequired, CLAUDE_LOGIN_COMMAND, type PartialStreamContext } from "./parse.js";

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
  // Custom endpoint (BYOK / gateway / alt model) — env-only for claude. `unset`
  // clears ambient Anthropic creds that would otherwise leak to a custom baseUrl.
  const endpointTx = translateEndpoint("claude", config.endpoint);
  Object.assign(env, endpointTx.env);
  for (const key of endpointTx.unset) delete env[key];
  const auth = detectAuth("claude", env);
  // Any explicit endpoint auth or a custom base URL is external/BYOK billing,
  // not the local subscription (detectAuth only recognizes ANTHROPIC_API_KEY).
  const usesCustomEndpoint = !!(
    config.endpoint?.baseUrl || config.endpoint?.authToken || config.endpoint?.apiKey
  );
  const billingType = usesCustomEndpoint ? "api" : auth.billingType;
  // Skip Bedrock model-id remapping for a custom endpoint: ambient AWS creds
  // make detectAuth return a Bedrock resolveModelId that would otherwise rewrite
  // `--model` into a Bedrock id and send it to the wrong place.
  const model = !usesCustomEndpoint && rawModel && auth.resolveModelId
    ? auth.resolveModelId(rawModel)
    : rawModel;

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

  // 3.5 Stage MCP config — attached via `--mcp-config <file>` (mode 0600),
  // never argv: http server headers can carry bearer tokens and argv is
  // world-readable via `ps`.
  let mcpConfigPath: string | null = null;
  if (config.mcpServers && config.mcpServers.length > 0) {
    mcpConfigPath = await stageMcpConfig(config.mcpServers);
  }

  // 4. Build args
  const buildArgs = (resumeSessionId: string | null): string[] => {
    const args = [...resolvedBinary.prefixArgs, "--print", "-", "--output-format", "stream-json", "--verbose"];
    if (resumeSessionId) args.push("--resume", resumeSessionId);
    // planMode and skipPermissions are mutually exclusive — planMode wins.
    if (config.planMode) {
      args.push("--permission-mode", "plan");
    } else if (config.skipPermissions) {
      args.push("--dangerously-skip-permissions");
    }
    if (model) args.push("--model", model);
    if (config.effort) args.push("--effort", config.effort);
    if (config.maxTurns && config.maxTurns > 0) args.push("--max-turns", String(config.maxTurns));
    if (config.instructionsFile) args.push("--append-system-prompt-file", config.instructionsFile);
    if (skillsDir) args.push("--add-dir", skillsDir);
    args.push(...claudeFeatureArgs(config, mcpConfigPath));
    // extraArgs stay LAST so hosts can override any generated flag.
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
    // Correlates tool_call → tool_result so emitted tool_result events carry
    // toolName. One tracker per attempt (a retry restarts the stream).
    const trackToolName = createToolNameTracker();
    // Tracks the owning message id across --include-partial-messages stream
    // lines so deltas reconcile with their consolidated assistant event.
    const partialCtx: PartialStreamContext = { messageId: null };

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
            for (const event of parseStreamLine(trimmed, partialCtx)) {
              try { await ctx.onEvent(trackToolName(event)); } catch { /* swallow */ }
            }
          }
        }
      },
    });

    // Parse remaining buffer
    if (lineBuffer.trim() && ctx.onEvent) {
      for (const event of parseStreamLine(lineBuffer.trim())) {
        try { await ctx.onEvent(trackToolName(event)); } catch { /* swallow */ }
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

    // Determine error code: process-level errors take precedence, then provider-specific.
    // parsed.errorCode already covers `auth_required` when the structured
    // signal (api_error_status 401/403 or documented auth text) fired in
    // parseClaudeStreamJson. The regex fallback below catches edge cases
    // where the CLI bailed before emitting a result event at all (binary
    // failure, stderr-only error from a wrapper).
    let errorCode = processErrorCode;
    if (!errorCode && parsed.errorCode) {
      errorCode = parsed.errorCode;
    }
    if (!errorCode && isClaudeAuthRequired(proc.stdout, proc.stderr)) {
      errorCode = "auth_required";
    }

    const errorMessage = (() => {
      if (proc.timedOut) return `Timed out after ${config.timeoutSec ?? 0}s`;
      if (errorCode === "auth_required") {
        // Prefer the provider's user-facing string when we captured it,
        // so callers can show "OAuth token has expired" rather than a
        // generic banner. Fall back to a recovery hint otherwise.
        return parsed.summary
          ? `${parsed.summary} (run \`${CLAUDE_LOGIN_COMMAND}\`)`
          : `Claude requires authentication. Run \`${CLAUDE_LOGIN_COMMAND}\`.`;
      }
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
    // 10. Clean up staged dirs/files
    if (skillsDir) {
      await cleanupSkillsDir(skillsDir);
    }
    await cleanupMcpConfig(mcpConfigPath);
  }
}
