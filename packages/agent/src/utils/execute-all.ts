import type { ExecutionContext, ExecutionResult, ProviderModule } from "../types.js";
import { getProvider } from "../registry.js";

export interface ExecuteAllOptions {
  /** Abort all remaining executions if any one fails. Default: false. */
  cancelOnFailure?: boolean;
  /** External signal to cancel all executions. */
  signal?: AbortSignal;
}

export interface ExecuteAllTask {
  provider: string | ProviderModule;
  ctx: ExecutionContext;
}

/**
 * Run multiple agent executions concurrently with shared cancellation.
 *
 * Returns results in the same order as the input tasks. If `cancelOnFailure`
 * is true, remaining tasks are aborted as soon as any task returns a
 * non-completed status.
 */
export async function executeAll(
  tasks: ExecuteAllTask[],
  options?: ExecuteAllOptions,
): Promise<ExecutionResult[]> {
  if (tasks.length === 0) return [];

  const controller = new AbortController();

  // Chain external signal
  if (options?.signal) {
    if (options.signal.aborted) {
      controller.abort(options.signal.reason);
    } else {
      const onAbort = () => controller.abort(options.signal!.reason);
      options.signal.addEventListener("abort", onAbort, { once: true });
      // Clean up listener when our controller aborts (avoid leak)
      controller.signal.addEventListener("abort", () => {
        options.signal!.removeEventListener("abort", onAbort);
      }, { once: true });
    }
  }

  const promises = tasks.map(async (task): Promise<ExecutionResult> => {
    const provider = typeof task.provider === "string"
      ? getProvider(task.provider)
      : task.provider;

    // Merge signals: task's own signal + shared controller signal
    const taskSignal = task.ctx.signal
      ? AbortSignal.any([task.ctx.signal, controller.signal])
      : controller.signal;

    const result = await provider.execute({
      ...task.ctx,
      signal: taskSignal,
    });

    if (options?.cancelOnFailure && result.status !== "completed") {
      controller.abort("cancelOnFailure");
    }

    return result;
  });

  return Promise.all(promises);
}
