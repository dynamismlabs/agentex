import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import type { ExecutionContext, ExecutionResult } from "../../types.js";
import { findBinary } from "../../utils/binary.js";
import { buildEnv, ensurePathInEnv } from "../../utils/env.js";
import { runChildProcess, deriveErrorCode } from "../../utils/process.js";
import { injectHomeSkills } from "../../utils/skills.js";
import { resolveInstructions } from "../../utils/instructions.js";
import { prepareWorkspace } from "../../utils/workspace.js";
import type { PreparedWorkspace } from "../../utils/workspace.js";
import { uuidv7 } from "../../utils/uuid.js";
import { parsePiJsonl, parsePiStreamLine, isPiUnknownSessionError } from "./parse.js";

const PI_SESSIONS_DIR = path.join(os.homedir(), ".pi", "sessions");

function parseModelProvider(model: string | null): string | null {
  if (!model) return null;
  const trimmed = model.trim();
  if (!trimmed.includes("/")) return null;
  return trimmed.slice(0, trimmed.indexOf("/")).trim() || null;
}

function parseModelId(model: string | null): string | null {
  if (!model) return null;
  const trimmed = model.trim();
  if (!trimmed.includes("/")) return trimmed || null;
  return trimmed.slice(trimmed.indexOf("/") + 1).trim() || null;
}

function buildSessionPath(runId: string): string {
  const safeTimestamp = new Date().toISOString().replace(/[:.]/g, "-");
  return path.join(PI_SESSIONS_DIR, `${safeTimestamp}-${runId}.jsonl`);
}

export async function executePiProvider(ctx: ExecutionContext): Promise<ExecutionResult> {
  const runId = ctx.runId ?? uuidv7();
  let cwd = ctx.cwd ?? process.cwd();
  const model = ctx.model ?? ctx.config?.model ?? "";
  const config = ctx.config ?? {};
  const startedAt = new Date().toISOString();

  // 1. Resolve binary
  ctx.onLifecycle?.({ phase: "preparing", step: "binary" });
  let resolvedBinary;
  try {
    resolvedBinary = await findBinary("pi", config.command);
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

  // 3. Build env
  const env = buildEnv(ctx.env);
  ensurePathInEnv(env);

  // 3. Resolve instructions — Pi uses native --append-system-prompt flag,
  // but we still validate the file exists early so failures are clear.
  ctx.onLifecycle?.({ phase: "preparing", step: "instructions" });
  if (config.instructionsFile) await resolveInstructions(config.instructionsFile);

  // 4. Inject skills into ~/.pi/agent/skills/
  ctx.onLifecycle?.({ phase: "preparing", step: "skills" });
  let piSkillsDir: string | null = null;
  if (config.skillDirs && config.skillDirs.length > 0) {
    try {
      piSkillsDir = await injectHomeSkills(config.skillDirs, "pi");
    } catch {
      // Non-fatal
    }
  }

  // 4. Ensure sessions directory exists
  await fs.mkdir(PI_SESSIONS_DIR, { recursive: true });

  // 5. Determine session resume
  const sessionParams = ctx.sessionParams ?? null;
  const existingSessionId = (() => {
    if (!sessionParams) return null;
    const id =
      (sessionParams["sessionId"] as string | undefined) ??
      (sessionParams["session_id"] as string | undefined);
    if (!id || typeof id !== "string") return null;
    const sessionCwd = sessionParams["cwd"] as string | undefined;
    if (sessionCwd && path.resolve(sessionCwd) !== path.resolve(cwd)) return null;
    return id;
  })();
  const canResume = existingSessionId !== null;
  const sessionPath = canResume ? existingSessionId! : buildSessionPath(runId);

  // Create session file if new
  if (!canResume) {
    try {
      await fs.writeFile(sessionPath, "", { flag: "wx" });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
        // Non-fatal, Pi may handle it
      }
    }
  }

  // 6. Parse model into provider/modelId
  const provider = parseModelProvider(model || null);
  const modelId = parseModelId(model || null);

  // 7. Build args
  const buildArgs = (sessionFile: string): string[] => {
    const args = [...resolvedBinary.prefixArgs, "--mode", "rpc"];
    if (provider) args.push("--provider", provider);
    if (modelId) args.push("--model", modelId);
    if (config.thinking) args.push("--thinking", config.thinking);
    args.push("--tools", "read,bash,edit,write,grep,find,ls");
    args.push("--session", sessionFile);
    if (piSkillsDir) args.push("--skill", piSkillsDir);
    if (config.instructionsFile) args.push("--append-system-prompt", config.instructionsFile);
    if (config.extraArgs) args.push(...config.extraArgs);
    return args;
  };

  // 8. Build RPC stdin
  const rpcStdin = JSON.stringify({ type: "prompt", message: ctx.prompt }) + "\n";

  // 9. Run attempt
  const runAttempt = async (sessionFile: string) => {
    const args = buildArgs(sessionFile);
    let stdoutBuffer = "";

    ctx.onLifecycle?.({ phase: "spawning" });
    const proc = await runChildProcess({
      runId,
      command: resolvedBinary.bin,
      args,
      cwd,
      env,
      stdin: rpcStdin,
      timeoutSec: config.timeoutSec,
      graceSec: config.graceSec,
      onStart: (pid) => {
        ctx.onLifecycle?.({ phase: "running", pid });
        ctx.onStart?.(pid);
      },
      signal: ctx.signal,
      onOutput: async (stream, chunk) => {
        if (stream === "stderr") {
          if (ctx.onOutput) {
            try { await ctx.onOutput(stream, chunk); } catch { /* swallow */ }
          }
          return;
        }

        // Buffer stdout by lines for JSONL parsing
        stdoutBuffer += chunk;
        const lines = stdoutBuffer.split("\n");
        stdoutBuffer = lines.pop() || "";

        for (const line of lines) {
          if (!line) continue;
          if (ctx.onOutput) {
            try { await ctx.onOutput(stream, line + "\n"); } catch { /* swallow */ }
          }
          if (ctx.onEvent) {
            const event = parsePiStreamLine(line);
            if (event) {
              try { await ctx.onEvent(event); } catch { /* swallow */ }
            }
          }
        }
      },
    });

    // Flush remaining buffer
    if (stdoutBuffer) {
      if (ctx.onOutput) {
        try { await ctx.onOutput("stdout", stdoutBuffer); } catch { /* swallow */ }
      }
      if (ctx.onEvent) {
        const event = parsePiStreamLine(stdoutBuffer);
        if (event) {
          try { await ctx.onEvent(event); } catch { /* swallow */ }
        }
      }
    }

    return proc;
  };

  // 10. Initial attempt
  let proc = await runAttempt(sessionPath);
  let clearSession = false;
  let finalSessionPath = sessionPath;

  // 11. Check for unknown session — retry once with new session
  if (
    canResume &&
    !proc.timedOut &&
    (proc.exitCode ?? 0) !== 0 &&
    isPiUnknownSessionError(proc.stdout, proc.stderr)
  ) {
    finalSessionPath = buildSessionPath(runId + "-retry");
    try {
      await fs.writeFile(finalSessionPath, "", { flag: "wx" });
    } catch {
      // Non-fatal
    }
    proc = await runAttempt(finalSessionPath);
    clearSession = true;
  }

  // 12. Parse result
  const parsed = parsePiJsonl(proc.stdout);
  const processErrorCode = deriveErrorCode(proc);

  let errorCode = processErrorCode;
  if (!errorCode && parsed.errorMessage) {
    errorCode = "execution_error";
  }

  const errorMessage = (() => {
    if (proc.timedOut) return `Timed out after ${config.timeoutSec ?? 0}s`;
    if (parsed.errorMessage) return parsed.errorMessage;
    if ((proc.exitCode ?? 0) !== 0 && !parsed.summary) {
      const stderrLine = proc.stderr.split(/\r?\n/).map((l) => l.trim()).find(Boolean);
      return stderrLine ?? `Pi exited with code ${proc.exitCode ?? -1}`;
    }
    return null;
  })();

  // Always return the current session path so callers can continue.
  // clearSession tells callers the OLD session was invalid, but we still
  // provide the NEW session handle from the retry.
  const resultSessionParams = { sessionId: finalSessionPath, cwd };

  const completedAt = new Date().toISOString();
  const resolvedModel = model || null;
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
    costUsd: parsed.usage?.costUsd ?? null,
    model: resolvedModel,
    summary: parsed.summary,
    sessionParams: resultSessionParams,
    sessionDisplayId: finalSessionPath,
    clearSession,
    billingType: "api",
    raw: null,
    workspace,
  };
}
