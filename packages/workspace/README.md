# `@agentex/workspace`

Isolation and lifecycle primitives for agent workspaces — the git/process/filesystem work that every "spawn an agent against a repo" tool reinvents.

Two flavors, both first-class:

- **Bare workspace** — an isolated directory. Right shape for drafting, research, planning, marketing folders, scratch work.
- **Git workspace** — a [`git worktree`](https://git-scm.com/docs/git-worktree) of a source repo, with branch lifecycle, structured diff, per-worktree checkpoints, status, commit/push, `pullLatestBase`, `mergeFrom`, and a `raw` escape hatch.

The library owns no state, picks no defaults, and ships no UI or transports. Consumers (Conductor-style apps, CI runners, productivity tools, CLIs) supply paths and names; the library does the work.

## Install

```bash
pnpm add @agentex/workspace
```

Peer requirements: `git` on `$PATH`. macOS or Linux (see [Platform](#platform)).

## Quick start

```ts
import { workspace } from "@agentex/workspace";

const ws = await workspace.create({
  kind: "git",
  source: "/abs/path/to/repo",
  baseBranch: "main",
  path: "/abs/path/to/workspace",
  branch: "agent/task-42",
});

if (ws.kind !== "git") throw new Error("expected git workspace");

await ws.runScript("setup");           // pnpm install, etc.
// ... agent does work ...
await ws.git.commit("agent: done");
await ws.git.push();
const pr = /* @agentex/github */;      // see that package
await workspace.archive(ws.path);      // dirty-checked teardown
```

## See it work end-to-end

There's a runnable demo that walks every primitive against a fresh scratch repo + bare remote in `/tmp` (no real GitHub needed):

```bash
npx tsx demo/workspace-demo/run.ts                 # runs lifecycle, archives, cleans up
KEEP_DEMO=1 npx tsx demo/workspace-demo/run.ts     # skips archive + cleanup so you can poke
```

See [`demo/workspace-demo/README.md`](../../demo/workspace-demo/README.md) for what each section exercises.

## API surface

### Top-level

```ts
import { workspace } from "@agentex/workspace";

await workspace.create(opts)            // CreateOptions → Workspace
await workspace.open(path, opts?)       // OpenOptions → Workspace (re-hydrate from disk)
await workspace.archive(path, opts?)    // ArchiveOptions; status-checked teardown by default
await workspace.detectKind(path)        // → "bare" | "git"
await workspace.detectDefaultBranch(path, remote = "origin")
                                        // → string (resolves remote/HEAD → main → master → init.defaultBranch)
```

### Common surface (both bare + git workspaces)

```ts
ws.kind                                 // "bare" | "git"
ws.path                                 // absolute path
ws.source                               // bare: string | undefined; git: string

ws.context                              // ContextDir — agent's freeform side-channel
  .dir                                  //   <workspace>/.context (lazy)
  .read(rel)                            //   read a file relative to .context/
  .write(rel, body)                     //   creates .context/ on first write
  .attach(srcPath)                      //   copy into .context/attachments/ with collision-suffix
  .list(subdir?)                        //   list contents (returns [] if .context/ doesn't exist)

ws.ports                                // PortAllocator — free TCP port probing
  .allocate(count)                      //   → number[] (probes via net.createServer)
  .release(port)
  .held()                               //   → number[]

ws.fromSourceWarnings                   // FromSourceWarnings
  .skippedOutsideSparse                 //   paths skipped because dest dir is outside the worktree's sparse-checkout

await ws.copyFromSource(globs)          // cp -f from source/<glob> → workspace/<rel>
await ws.linkFromSource(paths)          // ln -sf source/<path> → workspace/<path>
                                        // (refuses to delete a real dir at dest — throws LinkDestinationConflictError)

await ws.runScript(name)                // → RunHandle { pid, output: ReadableStream<Uint8Array>, kill(signal?) }
                                        //   long-lived subprocess in its own process group
await ws.tree()                         // → TreeNode (sorted, .git/ skipped at every depth)
ws.watch(handler, opts?)                // → WatchSubscription { ready: Promise<void>, dispose() }
                                        //   chokidar-backed, ~100ms debounce, .git/ ignored
```

### Git capability (`ws.git`, present only when `ws.kind === "git"`)

```ts
ws.git.branch                           // string — current branch
ws.git.base                             // string — base branch the workspace was created from
ws.git.baseSha                          // string — captured atomically at create time
ws.git.baseShaIsFreshlyDerived?         // true if baseSha was derived at open time (not the original)

await ws.git.status()                   // → WorkspaceStatus { dirty, untracked[], modified[], staged[], ahead, behind }
await ws.git.shortstat(vs)              // → { files, additions, deletions } (vs: DiffSpec)
await ws.git.diff(vs)                   // → StructuredDiff { files: [{ path, status, oldPath?, hunks }] }

await ws.git.commit(message)            // git add -A + commit -m (snapshots EVERYTHING)
await ws.git.push()                     // auto-set-upstream on first push
await ws.git.pullLatestBase({ strategy?: "merge" | "rebase" })
                                        // fetch base from origin → integrate; throws MergeConflictError on conflict

await ws.git.checkpoint(label)          // create per-worktree ref (refs/worktree/agentex/checkpoints/<label>)
await ws.git.restore(label)             // git reset --hard back
await ws.git.checkpoints()              // → string[]
await ws.git.deleteCheckpoint(label)    // no-op if missing

await ws.git.checkout(ref)              // switch to a branch / tag / SHA
await ws.git.mergeFrom(ref, opts?)      // merge another local ref INTO the current branch
                                        // same conflict semantics as pullLatestBase

await ws.git.addRemote(name, url)       // throws RemoteAlreadyExistsError if name taken
await ws.git.setOrigin(url)             // idempotent upsert: create or set-url

await ws.git.raw(["log", "--oneline"])  // escape hatch — args array, never shell-interpolated
                                        // → { stdout, stderr, exitCode } (non-zero NOT thrown)
```

`vs: DiffSpec` is `"base"` (compare against `baseSha`) or `{ checkpoint: "<label>" }`.

## Driving commit/push/merge buttons

`ws.git.status()` gives you exactly what you need to decide which button to render:

```ts
const status = await ws.git.status();
const showCommit = status.dirty;
const showPush   = !status.dirty && status.ahead > 0;
// for merge: combine with a PR check from @agentex/github (see that package)
```

## `agentex.workspace.json` (declarative config)

Drop this at the root of your source repo (committed — shared with the team) or at the workspace path (per-workspace overrides). The library auto-applies it during `workspace.create`.

```jsonc
{
  "scripts": {
    "setup":   "pnpm install",
    "run":     "pnpm dev --port $AGENTEX_PORT",
    "archive": "rm -rf .cache"
  },
  "fromSource": {
    "copy": ["**/.env*", ".vercel/project.json"],
    "link": ["apps/web/.env.local", "storage", ".cache"]
  }
}
```

- `scripts.<name>` — arbitrary names. Three are conventional: `setup`, `run`, `archive` (the last one is auto-run by `workspace.archive` as a one-shot teardown command).
- `fromSource.copy` — globs (picomatch dialect, dot-aware) copied source → workspace.
- `fromSource.link` — exact paths symlinked source → workspace. Replaces existing symlinks/files; **refuses to delete a real directory** (throws `LinkDestinationConflictError`).

Workspace-side `agentex.workspace.json` overrides source-side per top-level key. Skip auto-application with `workspace.create({ ..., applyFromSource: false })`.

Invalid JSON anywhere throws `MalformedConfigError(path, cause)`.

## Typed errors

All thrown from operations that hit a documented failure mode — branch on them, don't parse messages.

| Error | Thrown by | Carries |
|---|---|---|
| `WorkspaceNotFoundError` | `open` | `path` |
| `BranchExistsError` | `create({kind:"git"})` | `branch` |
| `NotAGitRepoError` | `create({kind:"git"})` when `source` isn't a git repo | `path` |
| `DirtyWorktreeError` | `archive` (without `force`) | `status: WorkspaceStatus` |
| `MergeConflictError` | `pullLatestBase`, `mergeFrom` | `files: string[]` |
| `NoDefaultBranchError` | `detectDefaultBranch` | `path`, `remote` |
| `SourceNotProvidedError` | `copyFromSource` / `linkFromSource` on a bare ws without `source` | — |
| `SourceFileMissingError` | `copyFromSource` / `linkFromSource` | `path` |
| `LinkDestinationConflictError` | `linkFromSource` when dest is a real dir | `dest` |
| `ScriptNotFoundError` | `runScript` | `script`, `available[]` |
| `EmptyScriptError` | `runScript` when entry is empty/whitespace | `script` |
| `ArchiveScriptFailedError` | `archive` when the configured archive hook exits non-zero | `script`, `exitCode`, `signal`, `stderr` |
| `MalformedConfigError` | any config-loading path | `path`, `cause: SyntaxError` |
| `RemoteAlreadyExistsError` | `addRemote` | `remote` |

## Platform

macOS and Linux. Run-script process-group teardown uses `detached: true` (POSIX `setsid`) and `kill(-pid)` (POSIX process-group signal); both are no-ops or wrong on Windows. The `package.json` declares `"os": ["darwin", "linux"]` so `npm install` fails fast in a Windows environment.

## Notes

### `runScript` and `AGENTEX_PORT`

`runScript` reads the *currently held* port from `ws.ports.held()[0]` and exposes it to the script as `$AGENTEX_PORT`. Allocate first, then run:

```ts
const [first] = await ws.ports.allocate(1);
const handle = await ws.runScript("dev"); // script sees AGENTEX_PORT=<first>
```

For multi-service setups, allocate the range once and let scripts pick offsets:

```ts
const [web, api, worker] = await ws.ports.allocate(3); // [3001, 3002, 3003]
// scripts can use $AGENTEX_PORT, $((AGENTEX_PORT + 1)), $((AGENTEX_PORT + 2))
```

If you call `runScript` before any `allocate`, the script runs without `AGENTEX_PORT` set in its environment.

### `ws.git.commit` snapshots everything

`ws.git.commit(message)` is `git add -A` + `git commit -m <message>` — it commits **all** worktree changes including untracked files and deletions. Right shape for "agent finished a task; snapshot it." If you need staged-only commits, drop to `ws.git.raw(["commit", "-m", message])`.

### `linkFromSource` is stricter than literal `ln -sf`

It replaces existing symlinks and files (`ln -sf` semantics) but **refuses to recursively delete a real (non-symlink) directory** — that throws `LinkDestinationConflictError`. Modern `ln -sf` itself errors in that case; older versions silently nuked the directory. We always refuse so you don't lose data on a re-run.

### Checkpoints are per-worktree

Stored under `refs/worktree/agentex/checkpoints/<label>` (git's per-worktree ref namespace). Invisible to sibling worktrees of the same source, never pushed by the default refspec, and **automatically removed by `git worktree remove`** so they don't accumulate across `workspace.archive` calls.

### `PortAllocator` is in-memory

The allocator's "held" set lives for the lifetime of the `Workspace` instance. Persistence across process restarts is the consumer's responsibility — re-allocate after `workspace.open`, or maintain your own free-port set in your app DB.

### `.context/` is gitignored per-worktree

On `workspace.create({ kind: "git" })`, the library appends `.context/` to the worktree's per-worktree `.git/info/exclude`. So `git status` stays clean, checkpoints don't include it, and the user's tracked `.gitignore` is untouched.

## Spec

See [`internal-docs/prd-workspace.md`](../../internal-docs/prd-workspace.md) for the full design rationale, decision log, and out-of-scope list.

## License

MIT.
