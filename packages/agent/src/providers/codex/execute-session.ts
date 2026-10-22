import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { AgentSession, ExecutionContext, ExecutionResult, TurnResult } from "../../types.js";
import { ServiceTierConfigurationError } from "../../types.js";
import { buildEnv } from "../../utils/env.js";
import { findBinary } from "../../utils/binary.js";
import { detectAuth } from "../../utils/auth.js";
import { prepareWorkspace, type PreparedWorkspace } from "../../utils/workspace.js";
import { uuidv7 } from "../../utils/uuid.js";
import { codexSessionCodec } from "./codec.js";
import { startCodexSession } from "./session.js";

/** A bounded single turn over app-server. Native `exec resume` restores the
 * persisted tier over -c, so explicit tier selection must use this protocol. */
export async function executeCodexSession(ctx: ExecutionContext): Promise<ExecutionResult> {
  const config = ctx.config ?? {};
  const startedAt = new Date().toISOString();
  const runId = ctx.runId ?? uuidv7();
  const restored = codexSessionCodec.deserialize(ctx.sessionParams);
  let cwd = ctx.cwd ?? (typeof restored?.["cwd"] === "string" ? restored["cwd"] : process.cwd());
  let workspace: PreparedWorkspace | undefined;
  let session: AgentSession | undefined;
  let turn: TurnResult | undefined;
  let error: unknown;
  let binaryMissing = false;
  let raw: Record<string, unknown> | null = null;
  let model = ctx.model ?? config.model ?? null;
  const abort = new AbortController();
  let timedOut = false;
  const onAbort = () => abort.abort();
  ctx.signal?.addEventListener("abort", onAbort, { once: true });
  if (ctx.signal?.aborted) abort.abort();
  const timer = config.timeoutSec && config.timeoutSec > 0 ? setTimeout(() => { timedOut = true; abort.abort(); }, config.timeoutSec * 1000) : undefined;
  timer?.unref();
  try {
    if (abort.signal.aborted) throw new Error("Execution cancelled");
    ctx.onLifecycle?.({ phase: "preparing", step: "binary" });
    try { await findBinary("codex", config.command); }
    catch (caught) { binaryMissing = true; throw caught; }
    if (config.workspace) {
      ctx.onLifecycle?.({ phase: "preparing", step: "workspace" });
      workspace = await prepareWorkspace(cwd, config.workspace);
      cwd = workspace.cwd;
    }
    // Match native exec's cross-directory guard, including prepared worktrees.
    // Never claim a new cwd while continuing a thread bound to another checkout.
    const savedCwd = restored?.["cwd"];
    const resumeParams = typeof savedCwd === "string" && resolve(savedCwd) !== resolve(cwd) ? null : ctx.sessionParams;
    session = await startCodexSession({
      cwd, env: ctx.env, sessionParams: resumeParams, signal: abort.signal,
      config: { ...config, workspace: undefined, model: model ?? undefined,
        unattendedPermissionPolicy: config.unattendedPermissionPolicy ?? "deny",
        extraArgs: ["-c", 'approval_policy="never"', ...(config.search ? ["-c", 'web_search="live"'] : []), ...(config.extraArgs ?? [])] },
      onOutput: ctx.onOutput,
      onLifecycle: (event) => {
        ctx.onLifecycle?.(event);
        if (event.phase === "running") ctx.onStart?.(event.pid);
      },
      onEvent: async (event) => {
        if (event.type === "system" && event.model) model = event.model;
        if (event.type === "result") raw = event.raw;
        await ctx.onEvent?.(event);
      },
    }, { approvalPolicy: "never" });
    turn = await (await session.send(ctx.prompt)).result;
  } catch (caught) {
    error = caught;
  } finally {
    clearTimeout(timer);
    ctx.signal?.removeEventListener("abort", onAbort);
    await session?.close();
  }
  if (error instanceof ServiceTierConfigurationError && !abort.signal.aborted) {
    await workspace?.cleanup({ deleteBranch: true }).catch(() => {});
    throw error;
  }
  const status = timedOut ? "timeout" : abort.signal.aborted ? "aborted"
    : error || turn?.status !== "completed" ? "failed" : "completed";
  const errorMessage = timedOut ? `Timed out after ${config.timeoutSec}s` : status === "aborted" ? "Execution cancelled"
    : error instanceof Error ? error.message : turn?.errorMessage ?? null;
  const errorCode = timedOut ? "timeout" : status === "aborted" ? "aborted"
    : binaryMissing ? "binary_not_found" : turn?.errorCode ?? (error ? "execution_error" : null);
  const completedAt = new Date().toISOString();
  const sessionId = session?.sessionId ?? null;
  const env = buildEnv(ctx.env);
  const subscription = await stat(join(env["CODEX_HOME"] ?? join(homedir(), ".codex"), "auth.json")).then(s => s.isFile(), () => false);
  const billingType = config.endpoint?.baseUrl ? "api" : subscription ? "subscription" : detectAuth("codex", env).billingType;
  if (status === "completed") ctx.onLifecycle?.({ phase: "completed" });
  else if (status === "aborted") ctx.onLifecycle?.({ phase: "cancelled" });
  else ctx.onLifecycle?.({ phase: "error", message: errorMessage ?? "Execution failed" });
  return { runId, exitCode: binaryMissing ? null : status === "completed" ? 0 : status === "failed" ? 1 : null,
    signal: abort.signal.aborted ? "SIGTERM" : null, status, startedAt, completedAt,
    durationMs: Date.parse(completedAt) - Date.parse(startedAt), errorMessage, errorCode,
    usage: turn?.usage, costUsd: turn?.costUsd ?? null, model, summary: turn?.summary ?? null,
    sessionParams: sessionId ? { sessionId, cwd } : null, sessionDisplayId: sessionId,
    clearSession: Boolean(restored?.["sessionId"] && sessionId && restored["sessionId"] !== sessionId),
    billingType, raw, workspace, serviceTier: turn?.serviceTier ?? session?.serviceTier };
}
