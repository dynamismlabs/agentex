import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ExecutionContext, ExecutionResult } from "../../types.js";
import { findBinary } from "../../utils/binary.js";
import { buildEnv, ensurePathInEnv } from "../../utils/env.js";
import { runChildProcess, deriveErrorCode } from "../../utils/process.js";
import { detectAuth } from "../../utils/auth.js";
import { injectWorkspaceSkills } from "../../utils/skills.js";
import { resolveInstructions } from "../../utils/instructions.js";
import { createToolNameTracker } from "../../utils/tool-names.js";
import { prepareWorkspace } from "../../utils/workspace.js";
import type { PreparedWorkspace } from "../../utils/workspace.js";
import { uuidv7 } from "../../utils/uuid.js";
import {
  parseCodexJsonl,
  parseCodexStreamLine,
  stripCodexRolloutNoise,
  isCodexAuthRequired,
  isCodexUnknownSessionError,
} from "./parse.js";
import { withPlanModePreamble } from "./plan-mode.js";
import { scanCodexSessionUsage } from "./usage-scanner.js";

export async function executeCodexProvider(ctx: ExecutionContext): Promise<ExecutionResult> {
  const runId = ctx.runId ?? uuidv7();
  let cwd = ctx.cwd ?? process.cwd();
  const model = ctx.model ?? ctx.config?.model;
  const config = ctx.config ?? {};
  const startedAt = new Date().toISOString();

  // 1. Resolve binary
  ctx.onLifecycle?.({ phase: "preparing", step: "binary" });
  let resolvedBinary;
  try {
    resolvedBinary = await findBinary("codex", config.command);
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

  // 3. Build env & resolve instructions
  ctx.onLifecycle?.({ phase: "preparing", step: "instructions" });
  const env = buildEnv(ctx.env);
  ensurePathInEnv(env);

  // 3. Resolve instructions. In plan mode, prepend a preamble that tells the
  //    agent to investigate-and-propose rather than attempt-and-fail — Codex
  //    has no native plan-mode UX, so the system prompt is what makes plan
  //    mode actually work as a planning flow.
  const baseInstructions = await resolveInstructions(config.instructionsFile);
  const instructions = config.planMode
    ? withPlanModePreamble(baseInstructions)
    : baseInstructions;
  const fullPrompt = instructions ? `${instructions}\n\n${ctx.prompt}` : ctx.prompt;

  // 4. Inject skills into workspace
  ctx.onLifecycle?.({ phase: "preparing", step: "skills" });
  if (config.skillDirs && config.skillDirs.length > 0) {
    try {
      await injectWorkspaceSkills(config.skillDirs, cwd);
    } catch {
      // Non-fatal
    }
  }

  // Detect auth/billing. Codex prefers its stored subscription (`codex login`)
  // over OPENAI_API_KEY when both exist, so env-only detection would wrongly
  // predict "api" whenever OPENAI_API_KEY is set. Check the auth.json stat:
  // if the subscription file is present, billing is "subscription" regardless.
  ctx.onLifecycle?.({ phase: "preparing", step: "auth" });
  const codexAuthPath = path.join(
    process.env["CODEX_HOME"] || path.join(os.homedir(), ".codex"),
    "auth.json",
  );
  const hasCodexSubscription = await fs.stat(codexAuthPath).then(
    (s) => s.isFile(),
    () => false,
  );
  const billingType = hasCodexSubscription
    ? "subscription"
    : detectAuth("codex", env).billingType;

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
    if (sessionCwd && path.resolve(sessionCwd) !== path.resolve(cwd)) return null;
    return id;
  })();

  // 5. Build args
  const buildArgs = (resumeSessionId: string | null): string[] => {
    const args = [...resolvedBinary.prefixArgs];
    if (config.search) args.push("--search");
    args.push("exec", "--json");
    // planMode and skipPermissions are mutually exclusive — planMode wins.
    if (config.planMode) {
      args.push("--sandbox", "read-only");
    } else if (config.skipPermissions) {
      args.push("--dangerously-bypass-approvals-and-sandbox");
    }
    if (model) args.push("--model", model);
    if (config.effort) args.push("-c", `model_reasoning_effort=${JSON.stringify(config.effort)}`);
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
    // Track thread_id across lines — Codex only emits it once (thread.started)
    // but downstream events need it attached for DB correlation.
    let streamThreadId: string | null = resumeSessionId;
    // Correlates tool_call → tool_result so emitted tool_result events carry
    // toolName. One tracker per attempt (a retry restarts the stream).
    const trackToolName = createToolNameTracker();

    const handleLine = async (trimmed: string) => {
      if (!trimmed) return;
      if (streamThreadId === null) {
        try {
          const parsed = JSON.parse(trimmed) as Record<string, unknown>;
          if (parsed && parsed["type"] === "thread.started" && typeof parsed["thread_id"] === "string") {
            streamThreadId = parsed["thread_id"];
          }
        } catch { /* ignore */ }
      }
      if (!ctx.onEvent) return;
      const event = parseCodexStreamLine(trimmed, streamThreadId);
      if (event) {
        try { await ctx.onEvent(trackToolName(event)); } catch { /* swallow */ }
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
          lineBuffer += chunk;
          const lines = lineBuffer.split("\n");
          lineBuffer = lines.pop() ?? "";
          for (const line of lines) {
            await handleLine(line.trim());
          }
        }
      },
    });

    if (lineBuffer.trim()) {
      await handleLine(lineBuffer.trim());
    }

    return proc;
  };

  // 7. Initial attempt
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
    // Codex emits `type: "error"` / `type: "turn.failed"` events but those
    // are generic — the auth-vs-rate-limit distinction lives in the text.
    // Surface an auth_required stream event so consumers wired to onEvent
    // get the same uniform signal as Claude.
    if (ctx.onEvent) {
      try {
        await ctx.onEvent({
          type: "auth_required",
          httpStatus: null,
          reason: parsed.errorMessage && /invalid.*api.*key/i.test(parsed.errorMessage) ? "invalid" : "missing",
          loginCommand: "codex login",
          message: parsed.errorMessage,
          timestamp: new Date().toISOString(),
          providerType: "codex",
          sessionId: parsed.sessionId,
          messageId: null,
          eventId: null,
          turnId: null,
          parentToolCallId: null,
          raw: parsed.finalEvent ?? {},
        });
      } catch { /* swallow */ }
    }
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
    usage: parsed.usage && resolvedModel
      ? { [resolvedModel]: {
          inputTokens: parsed.usage.inputTokens,
          outputTokens: parsed.usage.outputTokens,
          ...(parsed.usage.cachedInputTokens !== undefined ? { cachedInputTokens: parsed.usage.cachedInputTokens } : {}),
        } }
      : await scanCodexSessionUsage({
          startedAfter: new Date(startedAt),
          threadId: resolvedSessionId ?? undefined,
        }),
    costUsd: null,
    model: resolvedModel,
    summary: parsed.summary,
    sessionParams: resultSessionParams,
    sessionDisplayId: resolvedSessionId,
    clearSession,
    billingType,
    raw: parsed.finalEvent,
    workspace,
  };
}
