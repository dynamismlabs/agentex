import { observeExecution } from "../../telemetry/integration.js";
import type { ExecutionContext, ExecutionResult, ExecutionStatus, StreamEvent } from "../../types.js";
import { detectAuth } from "../../utils/auth.js";
import { buildEnv, ensurePathInEnv } from "../../utils/env.js";
import { resolveInstructions } from "../../utils/instructions.js";
import { injectHomeSkills } from "../../utils/skills.js";
import { uuidv7 } from "../../utils/uuid.js";
import { prepareWorkspace, type PreparedWorkspace } from "../../utils/workspace.js";
import { AgyConnection, firstAgyErrorLine, interruptAgyTurn, type AgyTurnOutcome } from "./connection.js";
import {
  AgyStreamParser,
  agyUsageRecord,
  classifyAgyFailure,
  mapAgyExecutionStatus,
} from "./parse.js";
import { AGY_SIGN_IN_MESSAGE, buildAgyArgs, findAgyBinary, readAgyResumeId } from "./runtime.js";

/**
 * One-shot Antigravity run: start `agy` in stream-json mode, write the prompt
 * as a single NDJSON message, close stdin, and wait for the process to exit.
 * The prompt travels over stdin, so it is never size-limited by argv or
 * visible in `ps`.
 */
export function executeAntigravityProvider(ctx: ExecutionContext): Promise<ExecutionResult> {
  return observeExecution(ctx, { context: false, rates: false }, executeAntigravityProviderInner);
}

async function executeAntigravityProviderInner(ctx: ExecutionContext): Promise<ExecutionResult> {
  const runId = ctx.runId ?? uuidv7();
  const startedAt = new Date().toISOString();
  const startMs = Date.now();
  const config = ctx.config ?? {};
  const requestedModel = ctx.model ?? config.model ?? null;
  let cwd = ctx.cwd ?? process.cwd();

  const finish = (fields: Partial<ExecutionResult> & Pick<ExecutionResult, "status">): ExecutionResult => ({
    runId,
    exitCode: null,
    signal: null,
    startedAt,
    completedAt: new Date().toISOString(),
    durationMs: Date.now() - startMs,
    errorMessage: null,
    errorCode: null,
    costUsd: null,
    model: requestedModel,
    summary: null,
    sessionParams: null,
    sessionDisplayId: null,
    clearSession: false,
    billingType: null,
    ...fields,
  });

  ctx.onLifecycle?.({ phase: "preparing", step: "binary" });
  let binary;
  try {
    binary = await findAgyBinary({ cwd, ...(ctx.env ? { env: ctx.env } : {}), config });
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : "Antigravity CLI (agy) not found";
    ctx.onLifecycle?.({ phase: "error", message: errorMessage });
    return finish({ status: "failed", errorMessage, errorCode: "binary_not_found", model: null });
  }

  let workspace: PreparedWorkspace | undefined;
  if (config.workspace) {
    ctx.onLifecycle?.({ phase: "preparing", step: "workspace" });
    workspace = await prepareWorkspace(cwd, config.workspace);
    cwd = workspace.cwd;
  }

  ctx.onLifecycle?.({ phase: "preparing", step: "auth" });
  const env = buildEnv(ctx.env);
  ensurePathInEnv(env);
  const billingType = detectAuth("antigravity", env).billingType;

  const resumeId = readAgyResumeId(ctx.sessionParams, cwd);

  ctx.onLifecycle?.({ phase: "preparing", step: "instructions" });
  // agy has no system-prompt flag, so instructions ride on the message, once
  // per process like a system prompt. Sending them on resumes too means a
  // conversation agy could not find (it starts a new one) never loses them.
  const instructions = await resolveInstructions(config.instructionsFile);
  const prompt = instructions ? `${instructions}\n\n${ctx.prompt}` : ctx.prompt;

  if (config.skillDirs && config.skillDirs.length > 0) {
    ctx.onLifecycle?.({ phase: "preparing", step: "skills" });
    try {
      await injectHomeSkills(config.skillDirs, "antigravity");
    } catch {
      // Non-fatal
    }
  }

  const parser = new AgyStreamParser({
    includePartialMessages: config.includePartialMessages,
    conversationId: resumeId,
  });
  const assistantText: string[] = [];
  const onEvent = async (event: StreamEvent): Promise<void> => {
    if (event.type === "assistant") assistantText.push(event.text);
    await ctx.onEvent?.(event);
  };

  ctx.onLifecycle?.({ phase: "spawning" });
  const connection = new AgyConnection({
    command: binary.bin,
    args: [...binary.prefixArgs, ...buildAgyArgs(config, { resumeId, model: requestedModel })],
    cwd,
    env,
    parser,
    onEvent,
    ...(ctx.onOutput ? { onOutput: ctx.onOutput } : {}),
  });
  if (connection.pid != null) {
    ctx.onLifecycle?.({ phase: "running", pid: connection.pid });
    ctx.onStart?.(connection.pid);
  }

  const pending = connection.nextTurn();
  connection.write(prompt);
  connection.endInput();

  // Guards cover the whole run, including agy finishing background work
  // after it delivers the answer.
  let timer: ReturnType<typeof setTimeout> | null = null;
  const guards: Promise<"timeout" | "aborted">[] = [];
  if (config.timeoutSec && config.timeoutSec > 0) {
    guards.push(new Promise((resolve) => { timer = setTimeout(() => resolve("timeout"), config.timeoutSec! * 1000); }));
  }
  let onAbort: (() => void) | null = null;
  if (ctx.signal) {
    const signal = ctx.signal;
    guards.push(new Promise((resolve) => {
      if (signal.aborted) resolve("aborted");
      onAbort = () => resolve("aborted");
      signal.addEventListener("abort", onAbort, { once: true });
    }));
  }

  let stopped: "timeout" | "aborted" | null = null;
  let outcome: AgyTurnOutcome | null;
  const first = await Promise.race([pending, ...guards]);
  if (first === "timeout" || first === "aborted") {
    stopped = first;
    outcome = await interruptAgyTurn(connection, pending, config.graceSec);
    // The run is over either way; never leave the process behind.
    await connection.terminate(config.graceSec);
  } else {
    outcome = first;
    if (!outcome.exited) {
      const ended = await Promise.race([connection.exited().then(() => "exited" as const), ...guards]);
      if (ended !== "exited") {
        // The answer arrived, but agy was still finishing background work when
        // the run was stopped. Report the stop; keep the answer.
        stopped = ended;
        await connection.terminate(config.graceSec, 0);
      }
    }
  }
  if (timer) clearTimeout(timer);
  if (onAbort && ctx.signal) ctx.signal.removeEventListener("abort", onAbort);
  // Exit status is final only once the process has gone.
  await connection.waitForExit(1000);

  const result = outcome?.result ?? null;
  const authRequired = connection.authRequired;
  const agyError = connection.agyError;
  const stderr = connection.stderr;
  const exitCode = connection.exit?.code ?? null;
  const exitSignal = connection.exit?.signal ?? null;

  let status: ExecutionStatus;
  let errorCode: string | null = null;
  let errorMessage: string | null = null;
  if (stopped) {
    status = stopped;
    errorCode = stopped;
    errorMessage = stopped === "timeout" ? `Timed out after ${config.timeoutSec ?? 0}s` : "Run aborted";
  } else if (result) {
    status = mapAgyExecutionStatus(result.status);
    if (status !== "completed") {
      errorCode = status === "aborted" ? "aborted" : authRequired ? "auth_required" : classifyAgyFailure(result, agyError);
      errorMessage = errorCode === "auth_required"
        ? AGY_SIGN_IN_MESSAGE
        : result.error ?? agyError?.message ?? `Antigravity run ended with ${result.status}`;
    }
  } else if (authRequired) {
    status = "failed";
    errorCode = "auth_required";
    errorMessage = AGY_SIGN_IN_MESSAGE;
  } else {
    status = "failed";
    errorCode = exitCode === 0 ? "incomplete_turn" : "agent_error";
    errorMessage = agyError?.message
      ?? firstAgyErrorLine(stderr)
      ?? `Antigravity CLI exited with code ${exitCode ?? "null"} without a result`;
  }

  if (status === "completed") ctx.onLifecycle?.({ phase: "completed" });
  else if (status === "aborted") ctx.onLifecycle?.({ phase: "cancelled" });
  else ctx.onLifecycle?.({ phase: "error", message: errorMessage ?? "Unknown error" });

  const conversationId = parser.conversationId;
  const model = parser.model ?? requestedModel;
  const usage = agyUsageRecord(result?.turnUsage ?? null, model);
  return finish({
    exitCode,
    signal: exitSignal,
    status,
    errorMessage,
    errorCode,
    ...(usage ? { usage } : {}),
    model,
    summary: result?.response.trim() || assistantText.join("\n\n").trim() || null,
    sessionParams: conversationId ? { sessionId: conversationId, cwd } : null,
    sessionDisplayId: conversationId,
    // A --conversation id agy could not find starts a new conversation.
    clearSession: Boolean(resumeId && conversationId && conversationId !== resumeId),
    billingType,
    numTurns: result?.numTurns ?? null,
    ...(result?.deniedActions?.length ? { permissionDenials: result.deniedActions } : {}),
    raw: result?.raw ?? null,
    ...(workspace ? { workspace } : {}),
  });
}
