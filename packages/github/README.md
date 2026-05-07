# `@agentex/github`

A thin, typed wrapper over the [`gh`](https://cli.github.com/) CLI for PRs, issues, and status checks. Pairs with [`@agentex/workspace`](../workspace) — workspace owns git plumbing, this package owns the GitHub host API.

This is a **wrapper, not an abstraction**. We don't model GitHub semantics beyond what `gh` exposes. If `gh` doesn't have a flag for it, this package doesn't have a method for it.

## Install

```bash
pnpm add @agentex/github
```

`gh` is consumer-installed (`brew install gh`, etc.) — never bundled. Calling any operation when `gh` is missing throws `NotInstalledError`.

## Quick start

```ts
import { github } from "@agentex/github";

// Preflight (recommended on app start)
const installed = await github.checkInstalled();
const authed    = await github.checkAuthenticated();
if (!installed.installed || !authed.authenticated) {
  // Show a non-blocking banner; everything else still works.
}

// Repo-scoped operations (cwd-bound)
const repo = github.repo("/abs/path/to/repo");

const pr = await repo.createPR({
  base: "main",
  head: "agent/task-42",
  title: "Implement foo",
  body: "<long markdown body>",
  draft: true,
});

const checks = await repo.listChecks(pr.number);
```

Typically used right after `@agentex/workspace`'s `ws.git.push()`:

```ts
await ws.git.push();
const pr = await github.repo(ws.path).createPR({
  base: ws.git.base,
  head: ws.git.branch,
  title: task.title,
  body: task.summary,
});
db.tasks.update(task.id, { prNumber: pr.number, prUrl: pr.url });
```

## See it work

The companion demo at [`demo/workspace-demo/run.ts`](../../demo/workspace-demo/run.ts) exercises this package against your real `gh` install:

```bash
# Always-on: preflight against your local gh
npx tsx demo/workspace-demo/run.ts

# + read-only ops against a sandbox repo
GH_DEMO_REPO=your-org/your-sandbox-repo npx tsx demo/workspace-demo/run.ts

# + actually create + clean up a draft PR (with a long body that exercises stdin)
GH_DEMO_REPO=your-org/your-sandbox-repo \
GH_DEMO_CREATE_PR=1 \
  npx tsx demo/workspace-demo/run.ts
```

## API surface

### Top-level (stateless preflight)

```ts
import { github } from "@agentex/github";

await github.checkInstalled()
  // → { installed: boolean, version?: string, path?: string }

await github.checkAuthenticated()
  // → { authenticated: boolean, user?: string, host?: string }
```

### Repo-scoped (`github.repo(path)`)

The instance carries `cwd`, so you don't pass a repo path to every call.

Every PR/issue id parameter accepts a `PRId = number | string` (or `IssueId`) — a number, a string number (`"42"`), or a full URL (`"https://github.com/owner/repo/pull/42"`). `gh` itself accepts all three; we just thread them through.

```ts
const repo = github.repo("/abs/path/to/repo");

// Pull requests
await repo.createPR({ base, head, title, body, draft?, reviewers?, labels? })
  // → PRSummary (re-fetched via `gh pr view --json` for a fully-typed return)

await repo.listPRs({ state?, head?, base?, author? })
  // → PRSummary[]
  // head/base/author all wire through to `gh pr list --head/--base/--author`

await repo.getPR(id)                        // → PRDetail (body + reviews + comments + statusCheckRollup)

await repo.commentOnPR(id, body)
await repo.requestReviewers(id, ["alice", "bob"])
await repo.merge(id, { method?: "merge" | "squash" | "rebase", deleteBranch?: boolean })
await repo.openInBrowser(id)                // gh pr view --web

// Status checks
await repo.listChecks(id)                   // → CheckRun[] (name, conclusion, status, url)

// Issues
await repo.listIssues({ state?, labels?, assignee? })   // → IssueSummary[]
await repo.getIssue(id)                                  // → IssueDetail
await repo.createIssue({ title, body, labels?, assignees? })
                                                         // → IssueSummary
await repo.commentOnIssue(id, body)

// Escape hatch — any gh subcommand
await repo.raw(args, { input? })
  // → { stdout, stderr, exitCode }
```

### Escape hatch: `repo.raw`

The typed methods cover routine ops. For anything we haven't typed (`gh api`, `gh release`, custom flags) — or when an agent should drive `gh` directly — use `raw`:

```ts
// gh api passthrough
const { stdout } = await repo.raw(["api", "user", "--jq", ".login"]);

// long-body op via stdin (same E2BIG-safe pattern as createPR)
await repo.raw(
  ["pr", "edit", "42", "--body-file", "-"],
  { input: agentWrittenLongBody },
);
```

`raw` returns `{ stdout, stderr, exitCode }` so the caller decides how to parse and how to react to non-zero exits. It still throws `NotInstalledError` if `gh` is missing, but it does **not** map other failures to typed errors — that's the typed methods' job.

### Common patterns

**Find the open PR for a branch:**
```ts
const [openPR] = await repo.listPRs({ state: "open", head: ws.git.branch });
```

**Connect work to a PR (consumer-side):**
```ts
const pr = await repo.createPR({...});
db.tasks.update(taskId, { prNumber: pr.number, prUrl: pr.url });

// Later, refresh:
const detail = await repo.getPR(taskRow.prNumber);
const checks = await repo.listChecks(taskRow.prNumber);
```

**Pull issues into your task tracker:**
```ts
const issues = await repo.listIssues({ state: "open", labels: ["bug"] });
for (const issue of issues) {
  const detail = await repo.getIssue(issue.number);
  await db.tasks.create({
    title: issue.title,
    description: detail.body,
    sourceIssueUrl: issue.url,
  });
}
```

## Typed errors

| Error | Thrown when |
|---|---|
| `NotInstalledError` | `gh` is not on `$PATH` (any operation) |
| `NotAuthenticatedError` | `gh auth status` reports no credentials, or stderr matches "not authenticated" patterns |
| `RateLimitedError` | stderr contains "rate limit" / "API rate limit exceeded" |
| `RepoNotFoundError` | stderr contains "could not resolve" / "repository not found" |
| `BranchNotFoundError` | stderr indicates a missing branch (e.g. "must first push the current branch") |
| `GhCommandError` | fallback for any other non-zero `gh` exit (carries `args`, `exitCode`, `stdout`, `stderr`) |

Each typed error exposes the raw `gh` stderr both as `.stderr` and via the standard `Error#cause` slot, so generic log-aggregation tools that follow `cause` pick it up.

## Platform

macOS and Linux. The package declares `"os": ["darwin", "linux"]` for parity with `@agentex/workspace` (which depends on POSIX process-group semantics).

## Notes

### Long bodies are piped via stdin

`createPR`, `createIssue`, `commentOnPR`, and `commentOnIssue` all pass their `body` to `gh` as `--body-file -` with the body written to stdin, rather than `--body <text>`. This avoids the OS arg-length limit (`E2BIG` — ~128KB on Linux, ~256KB on macOS), so agent-written PR descriptions and design-doc-sized issue bodies don't truncate.

### `createPR` returns a fully-typed `PRSummary`

`gh pr create` only prints the new PR's URL. We follow up with `gh pr view --json <fields>` to return a typed `PRSummary` (number, title, state, url, isDraft, headRefName, baseRefName, author, createdAt, updatedAt). Costs one extra round-trip; saves the consumer from re-fetching themselves.

### Test-only executor injection

The package exports `_setGhExecutor(fn)` / `_resetGhExecutor()` (underscore-prefixed) so tests can stub `gh` without spawning real subprocesses. Don't use these in app code — they're an internal seam for unit tests.

## Spec

See [`internal-docs/prd-github.md`](../../internal-docs/prd-github.md) for the full design rationale and the multi-forge / GitLab future-work notes.

## License

MIT.
