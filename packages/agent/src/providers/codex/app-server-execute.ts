import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ExecutionContext, ExecutionResult, ExecutionStatus, TurnResult } from "../../types.js";
import type { PreparedWorkspace } from "../../utils/workspace.js";
import { splitCodexExtraArgs } from "./mcp.js";
import type { CodexSandboxMode } from "./permissions.js";
import { startCodexSession, type CodexSessionImpl } from "./session.js";

/** What `executeCodexProvider` resolved before handing the run over. */
export interface CodexAppServerRun {
  runId: string;
  startedAt: string;
  /** The run's folder, after any workspace was prepared. */
  cwd: string;
  model: string | null;
  workspace: PreparedWorkspace | undefined;
  billingType: ExecutionResult["billingType"];
  /** The thread to resume, already checked against `cwd`. */
  resumeId: string | null;
}

/** `codex exec` flags (`extraArgs` after the subcommand), translated for app-server. */
export interface CodexExecArgs {
  model?: string;
  sandbox?: CodexSandboxMode;
  /** `--dangerously-bypass-approvals-and-sandbox`. */
  bypass?: boolean;
  images: string[];
  outputSchemaFile?: string;
  outputLastMessageFile?: string;
  ephemeral?: boolean;
  /** Flags app-server has no equivalent for. The run fails on these, before it starts. */
  unsupported: string[];
}

const SANDBOX_MODES: readonly string[] = ["read-only", "workspace-write", "danger-full-access"];

/**
 * Translate the `codex exec` flags a host passed in `extraArgs` (the ones
 * after the subcommand; `-c`, `--profile` and the like go before it either
 * way). `--model`, `--sandbox`, the bypass flag, `--image`, `--output-schema`,
 * `--output-last-message` and `--ephemeral` have app-server equivalents.
 * `--json`, `--color` and `--skip-git-repo-check` only shape exec's own
 * output or checks, so they're dropped. Anything else is unsupported.
 */
export function translateCodexExecArgs(runtimeArgs: string[]): CodexExecArgs {
  const result: CodexExecArgs = { images: [], unsupported: [] };
  for (let i = 0; i < runtimeArgs.length; i++) {
    const arg = runtimeArgs[i]!;
    const eq = arg.startsWith("--") ? arg.indexOf("=") : -1;
    const flag = eq > 0 ? arg.slice(0, eq) : arg;
    const inline = eq > 0 ? arg.slice(eq + 1) : undefined;
    const value = (): string | undefined => inline ?? runtimeArgs[++i];
    switch (flag) {
      case "-m": case "--model": result.model = value(); break;
      case "-s": case "--sandbox": {
        const mode = value();
        if (mode && SANDBOX_MODES.includes(mode)) result.sandbox = mode as CodexSandboxMode;
        else result.unsupported.push(`${flag} ${mode ?? ""}`.trim());
        break;
      }
      case "--dangerously-bypass-approvals-and-sandbox": result.bypass = true; break;
      case "-i": case "--image": { const file = value(); if (file) result.images.push(file); break; }
      case "--output-schema": result.outputSchemaFile = value(); break;
      case "-o": case "--output-last-message": result.outputLastMessageFile = value(); break;
      case "--ephemeral": result.ephemeral = true; break;
      case "--json": case "--skip-git-repo-check": break;
      case "--color": if (inline === undefined) i++; break;
      default: result.unsupported.push(arg);
    }
  }
  return result;
}

/**
 * A one-shot run that has `skillDirs`. `codex exec` finds skills only in
 * folders Codex scans for every session (the project's `.agents/skills`,
 * `~/.agents/skills`), so these runs use `codex app-server`, which takes skill
 * roots for its own process: the session `createSession` would give, for one
 * turn.
 *
 * It keeps what `codex exec` does: approvals `never`, since nobody is there
 * to answer one; the same sandbox (Codex's default for the folder, read-only
 * in plan mode, none with `skipPermissions`); live web search for `search`;
 * one `timeoutSec` and `signal` over the whole run, startup included; and
 * the exec flags `translateCodexExecArgs` knows. A flag it doesn't fails the
 * run before anything starts. Instructions go in as developer instructions
 * rather than ahead of the prompt, and a startup failure rejects after any
 * workspace is cleaned up, as it does for a session.
 */
export async function executeCodexOnAppServer(ctx: ExecutionContext, run: CodexAppServerRun): Promise<ExecutionResult> {
  const config = ctx.config ?? {};
  const finish = (fields: Partial<ExecutionResult> & Pick<ExecutionResult, "status">): ExecutionResult => {
    const completedAt = new Date().toISOString();
    if (fields.status === "completed") ctx.onLifecycle?.({ phase: "completed" });
    else if (fields.status === "aborted") ctx.onLifecycle?.({ phase: "cancelled" });
    else ctx.onLifecycle?.({ phase: "error", message: fields.errorMessage ?? "Unknown error" });
    return {
      runId: run.runId,
      exitCode: null,
      signal: null,
      startedAt: run.startedAt,
      completedAt,
      durationMs: new Date(completedAt).getTime() - new Date(run.startedAt).getTime(),
      errorMessage: null,
      errorCode: null,
      costUsd: null,
      model: run.model,
      summary: null,
      sessionParams: null,
      sessionDisplayId: null,
      clearSession: false,
      billingType: run.billingType,
      raw: null,
      ...(run.workspace ? { workspace: run.workspace } : {}),
      ...fields,
    };
  };

  // 1. The exec flags, before anything starts.
  let split: ReturnType<typeof splitCodexExtraArgs>;
  try {
    split = splitCodexExtraArgs(config.extraArgs);
  } catch (error) {
    await run.workspace?.cleanup({ deleteBranch: true }).catch(() => undefined);
    throw error;
  }
  const { configArgs, runtimeArgs } = split;
  const exec = translateCodexExecArgs(runtimeArgs);
  if (exec.unsupported.length > 0) {
    return finish({
      status: "failed",
      errorCode: "unsupported_args",
      errorMessage: `A Codex run with skillDirs runs on codex app-server, which has no equivalent for: ${exec.unsupported.join(", ")}. Remove them, or the skillDirs.`,
    });
  }
  let outputSchema: unknown;
  if (exec.outputSchemaFile) {
    try {
      outputSchema = JSON.parse(await fs.readFile(path.resolve(run.cwd, exec.outputSchemaFile), "utf8"));
    } catch (error) {
      return finish({
        status: "failed",
        errorCode: "unsupported_args",
        errorMessage: `--output-schema ${exec.outputSchemaFile}: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }
  const model = exec.model ?? run.model;

  // 2. One deadline and one cancel for the whole run, as codex exec has.
  const stop = new AbortController();
  let stoppedBy: "timeout" | "aborted" | null = null;
  const halt = (why: "timeout" | "aborted") => {
    stoppedBy ??= why;
    stop.abort();
  };
  const timer = config.timeoutSec && config.timeoutSec > 0
    ? setTimeout(() => halt("timeout"), config.timeoutSec * 1000)
    : null;
  const onAbort = () => halt("aborted");
  if (ctx.signal?.aborted) onAbort();
  else ctx.signal?.addEventListener("abort", onAbort, { once: true });
  const stopped = (): Pick<ExecutionResult, "status" | "errorCode" | "errorMessage"> => stoppedBy === "timeout"
    ? { status: "timeout", errorCode: "timeout", errorMessage: `Timed out after ${config.timeoutSec}s` }
    : { status: "aborted", errorCode: "aborted", errorMessage: "Run aborted" };

  try {
    // 3. Start the session.
    ctx.onLifecycle?.({ phase: "preparing", step: "skills" });
    ctx.onLifecycle?.({ phase: "spawning" });
    let session: CodexSessionImpl;
    try {
      session = await startCodexSession({
        cwd: run.cwd,
        ...(ctx.env ? { env: ctx.env } : {}),
        config: {
          ...config,
          workspace: undefined,
          ...(model ? { model } : {}),
          // Runtime flags were translated above. `--search` is a top-level
          // TUI flag app-server never receives; this is its config key.
          extraArgs: [...(config.search ? ["-c", 'web_search="live"'] : []), ...configArgs],
        },
        sessionParams: run.resumeId ? { sessionId: run.resumeId, cwd: run.cwd } : null,
        ...(ctx.onEvent ? { onEvent: ctx.onEvent } : {}),
        ...(ctx.onOutput ? { onOutput: ctx.onOutput } : {}),
      }, {
        approvalPolicy: "never",
        ...(exec.bypass ? { sandbox: "danger-full-access" as const } : exec.sandbox ? { sandbox: exec.sandbox } : {}),
        ...(exec.ephemeral ? { ephemeral: true } : {}),
        startupSignal: stop.signal,
      });
    } catch (error) {
      // Stopped while starting: a timeout or a cancel, reported like exec's.
      if (stoppedBy) return finish(stopped());
      ctx.onLifecycle?.({ phase: "error", message: error instanceof Error ? error.message : String(error) });
      await run.workspace?.cleanup({ deleteBranch: true }).catch(() => undefined);
      throw error;
    }

    if (session.pid != null) {
      ctx.onLifecycle?.({ phase: "running", pid: session.pid });
      ctx.onStart?.(session.pid);
    }

    // 4. One turn. The session is closed whatever happens to it.
    let turn: TurnResult;
    let threadId: string | null = null;
    try {
      const handle = await session.sendTurn(ctx.prompt, { signal: stop.signal }, {
        images: exec.images.map((image) => path.resolve(run.cwd, image)),
        ...(outputSchema !== undefined ? { outputSchema } : {}),
      });
      turn = await handle.result;
    } catch (error) {
      turn = {
        summary: null,
        costUsd: null,
        status: "failed",
        errorCode: "agent_error",
        errorMessage: error instanceof Error ? error.message : String(error),
      };
    } finally {
      threadId = session.sessionId;
      await session.close();
    }

    if (exec.outputLastMessageFile && turn.summary !== null) {
      await fs.writeFile(path.resolve(run.cwd, exec.outputLastMessageFile), turn.summary).catch(() => undefined);
    }

    const ids = {
      sessionParams: threadId ? { sessionId: threadId, cwd: run.cwd } : null,
      sessionDisplayId: threadId,
      // A thread app-server could not resume becomes a new one.
      clearSession: Boolean(run.resumeId && threadId && threadId !== run.resumeId),
    };
    const shared = {
      ...ids,
      ...(turn.usage ? { usage: turn.usage } : {}),
      costUsd: turn.costUsd,
      model,
      summary: turn.summary,
    };
    if (stoppedBy) return finish({ ...shared, ...stopped() });
    const status: ExecutionStatus = turn.status === "max_turns" || turn.status === "max_budget" ? "failed" : turn.status;
    if (status === "completed") return finish({ ...shared, status, exitCode: 0 });
    return finish({
      ...shared,
      status,
      errorCode: turn.errorCode ?? (status === "failed" ? turn.status : status),
      errorMessage: turn.errorMessage ?? "Codex turn failed",
    });
  } finally {
    if (timer) clearTimeout(timer);
    ctx.signal?.removeEventListener("abort", onAbort);
  }
}
