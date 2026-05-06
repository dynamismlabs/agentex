import * as path from "node:path";
import { watch as chokidarWatch } from "chokidar";
import type {
  WatchEvent,
  WatchEventKind,
  WatchHandler,
  WatchOptions,
  WatchSubscription,
} from "./types.js";

const DEBOUNCE_MS = 100;

/**
 * Recursively watch `workspacePath`, batching events through a ~100ms debounce
 * and routing them to the handler.
 *
 * Returns `{ ready, dispose }`:
 *  - `ready` resolves once the underlying recursive scan has finished
 *    indexing the workspace; events for changes after that point are
 *    guaranteed to be delivered.
 *  - `dispose()` stops the watcher (idempotent). Any pending events in the
 *    debounce buffer are dropped without delivery.
 *
 * `.git/` is always ignored. Errors from the underlying watcher and exceptions
 * thrown by `handler` route to `opts.onError`; if no handler is supplied, they
 * are logged via `console.error` and the watcher continues.
 */
export function watchWorkspace(
  workspacePath: string,
  handler: WatchHandler,
  opts: WatchOptions = {},
): WatchSubscription {
  const onError = opts.onError ?? defaultOnError;

  const watcher = chokidarWatch(workspacePath, {
    ignored: (p: string) => {
      const rel = path.relative(workspacePath, p);
      if (rel === "" || rel.startsWith("..")) return false;
      const segments = rel.split(path.sep);
      return segments.includes(".git");
    },
    persistent: true,
    ignoreInitial: true,
    awaitWriteFinish: false,
    ignorePermissionErrors: true,
  });

  let buffer: WatchEvent[] = [];
  let timer: NodeJS.Timeout | null = null;
  let disposed = false;

  function flush(): void {
    timer = null;
    if (disposed) return;
    if (buffer.length === 0) return;
    const events = buffer;
    buffer = [];
    try {
      handler(events);
    } catch (err) {
      onError(err);
    }
  }

  function schedule(kind: WatchEventKind, p: string): void {
    if (disposed) return;
    buffer.push({ kind, path: p });
    if (timer !== null) return;
    timer = setTimeout(flush, DEBOUNCE_MS);
  }

  watcher.on("add", (p) => schedule("add", p));
  watcher.on("addDir", (p) => schedule("add", p));
  watcher.on("change", (p) => schedule("modify", p));
  watcher.on("unlink", (p) => schedule("remove", p));
  watcher.on("unlinkDir", (p) => schedule("remove", p));
  watcher.on("error", (err) => onError(err));

  const ready = new Promise<void>((resolve) => {
    watcher.once("ready", () => resolve());
  });

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    void watcher.close();
  }

  return { ready, dispose };
}

function defaultOnError(err: unknown): void {
  // eslint-disable-next-line no-console
  console.error("[@agentex/workspace] watch error:", err);
}
