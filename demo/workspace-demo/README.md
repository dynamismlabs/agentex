# `@agentex/workspace` + `@agentex/github` lifecycle demo

A single script that walks every primitive of both packages against a freshly
created scratch source repo + bare remote in `/tmp` (so the workspace half
needs **no real GitHub auth and no existing repo on disk**).

The `@agentex/github` half is gated on env vars so you can scale up the
exposure as you want:
- nothing set → preflight only (`checkInstalled` / `checkAuthenticated`)
- `GH_DEMO_REPO=owner/name` → also runs read-only ops (`listPRs`, `listIssues`, `getPR`, `listChecks`)
- `GH_DEMO_CREATE_PR=1` (with `GH_DEMO_REPO` set) → also creates a real **draft** PR + cleans it up

## Run it

```bash
# Workspace lifecycle only — fully self-contained
npx tsx demo/workspace-demo/run.ts

# Same, but skip archive + cleanup so you can poke at the scratch source repo
# and worktree on disk. Prints the paths and ready-to-paste inspection commands.
KEEP_DEMO=1 npx tsx demo/workspace-demo/run.ts

# + read-only github ops against your sandbox repo
GH_DEMO_REPO=your-org/your-sandbox-repo npx tsx demo/workspace-demo/run.ts

# + actually create a draft PR and clean it up
GH_DEMO_REPO=your-org/your-sandbox-repo \
GH_DEMO_CREATE_PR=1 \
  npx tsx demo/workspace-demo/run.ts
```

### Inspecting the worktree-of-parent relationship (`KEEP_DEMO=1`)

The demo always prints a "Verifying the worktree-of-parent relationship" section
that shows:
- `<worktree>/.git` is a *file* (worktree pointer), not a directory, with its
  `gitdir:` line resolved to `<source>/.git/worktrees/<name>`.
- `git -C <source> worktree list` includes the worktree.
- Both source and worktree see the same branches (same git object database).
- A commit made in the worktree appears in `git -C <source> log` for the same
  branch.

With `KEEP_DEMO=1`, the script then **skips** `workspace.archive` and the tmp
cleanup, so you can poke at it yourself:

```bash
cat /tmp/agentex-demo-XXXX/ws-feature/.git
git -C /tmp/agentex-demo-XXXX/source worktree list
git -C /tmp/agentex-demo-XXXX/source log --oneline -5 feature/demo
ls -la /tmp/agentex-demo-XXXX/ws-feature/.context

# When you're done:
rm -rf /tmp/agentex-demo-XXXX
```

## What it covers

### `@agentex/workspace`

- Scratch source repo + bare remote built fresh in `/tmp`
- `workspace.create({ kind: "git", ... })` with the full handle introspection
- Declarative `agentex.workspace.json` — `fromSource.copy` + `link` auto-applied
- `ws.context` — lazy `.context/` dir, `write` / `attach` (with collision suffix) / `list`
- `ws.ports` — `allocate(3)`, `held()`, `release(...)`
- `ws.runScript("run")` — long-running subprocess, output stream drained, then `kill()` tears down the process group
- `ws.git.status()` walked through clean → dirty → committed (ahead) → pushed
- `ws.git.shortstat("base")` and `ws.git.diff("base")` (untracked files surface as synthetic `"added"` entries)
- `ws.git.checkpoint` / `restore` / `checkpoints` / `deleteCheckpoint` (per-worktree refs, auto-cleaned by archive)
- `ws.tree()` (sorted recursive walk; `.git/` skipped)
- `ws.watch(handler)` with `await sub.ready` and `sub.dispose()`
- `ws.git.mergeFrom("develop")` — local merge of another branch into current
- `ws.git.push()` (auto-set-upstream on first push)
- `ws.git.raw(["log", "--oneline", "-3"])` — escape hatch
- `workspace.detectKind` / `detectDefaultBranch`
- `workspace.open(path)` round-trips to an equivalent handle
- A short bare-workspace pass (`workspace.create({ kind: "bare" })`)
- `workspace.archive(path)` with the dirty-check + per-worktree checkpoint auto-cleanup

### `@agentex/github`

- `github.checkInstalled()` / `github.checkAuthenticated()` (always)
- `github.repo(path).listPRs({ state })` and `listIssues({ state })`
- `getPR(number)` for a real PR's full detail
- `listChecks(number)` for that PR
- (optional) full PR write flow: `createPR` (draft, with a long body that exercises the `--body-file -`/stdin path), `listPRs({ head })`, `commentOnPR`, then close + delete branch + archive

## Cleanup

The script removes its `/tmp` scratch dir on success. If anything errors mid-way,
the scratch dir is left in place and printed for inspection.

For the GitHub write flow, the demo:
1. Always creates the PR as a **draft** (so it doesn't notify reviewers).
2. Closes the PR + deletes the remote branch + archives the local worktree at the end.
3. If something errors before cleanup, you may need to close the draft PR manually — the URL is printed.
