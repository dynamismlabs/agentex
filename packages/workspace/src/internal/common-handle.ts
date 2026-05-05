import { createContextDir } from "../context.js";
import { copyFilesFromSource, linkPathsFromSource } from "../from-source.js";
import { createPortAllocator } from "../ports.js";
import { runWorkspaceScript } from "../scripts.js";
import { readTree } from "../tree.js";
import { watchWorkspace } from "../watch.js";
import { SourceNotProvidedError } from "../errors.js";
import type {
  ContextDir,
  FromSourceWarnings,
  PortAllocator,
  RunHandle,
  TreeNode,
  WatchHandler,
  WatchOptions,
  WatchSubscription,
} from "../types.js";

export interface CommonHandleProps {
  readonly path: string;
  readonly source: string | undefined;
  readonly context: ContextDir;
  readonly ports: PortAllocator;
  readonly fromSourceWarnings: FromSourceWarnings;
  copyFromSource(globs: readonly string[]): Promise<void>;
  linkFromSource(paths: readonly string[]): Promise<void>;
  runScript(name: string): Promise<RunHandle>;
  tree(): Promise<TreeNode>;
  watch(handler: WatchHandler, opts?: WatchOptions): WatchSubscription;
}

/**
 * Build the common surface every Workspace handle exposes. Bare and git
 * factories layer their own discriminator + flavor-specific fields on top.
 *
 * `requireSource: true` (git) makes `copyFromSource` / `linkFromSource` always
 * succeed when the source is set — they don't throw `SourceNotProvidedError`
 * because git always has a source. `requireSource: false` (bare) gates those
 * methods on a runtime check.
 */
export function makeCommonHandle(opts: {
  path: string;
  source: string | undefined;
  requireSource: boolean;
}): CommonHandleProps {
  const fromSourceWarnings: FromSourceWarnings = { skippedOutsideSparse: [] };
  const ports = createPortAllocator();
  const context = createContextDir(opts.path);

  function ensureSource(): string {
    if (opts.source === undefined) throw new SourceNotProvidedError();
    return opts.source;
  }

  return {
    path: opts.path,
    source: opts.source,
    context,
    ports,
    fromSourceWarnings,
    async copyFromSource(globs) {
      const source = opts.requireSource ? (opts.source as string) : ensureSource();
      await copyFilesFromSource({
        source,
        workspacePath: opts.path,
        patterns: globs,
        warnings: fromSourceWarnings,
      });
    },
    async linkFromSource(paths) {
      const source = opts.requireSource ? (opts.source as string) : ensureSource();
      await linkPathsFromSource({
        source,
        workspacePath: opts.path,
        paths,
        warnings: fromSourceWarnings,
      });
    },
    async runScript(name) {
      return runWorkspaceScript({
        workspacePath: opts.path,
        source: opts.source,
        ports,
        name,
      });
    },
    async tree() {
      return readTree(opts.path);
    },
    watch(handler, watchOpts) {
      return watchWorkspace(opts.path, handler, watchOpts);
    },
  };
}
