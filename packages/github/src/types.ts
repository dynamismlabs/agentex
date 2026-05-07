/**
 * Types are a typed mirror of `gh ... --json <fields>` output. Where `gh`
 * returns enums, we narrow to the strings it actually emits.
 */

export type PRState = "OPEN" | "CLOSED" | "MERGED";
export type IssueState = "OPEN" | "CLOSED";
export type CheckConclusion =
  | "SUCCESS"
  | "FAILURE"
  | "NEUTRAL"
  | "CANCELLED"
  | "TIMED_OUT"
  | "ACTION_REQUIRED"
  | "STALE"
  | "STARTUP_FAILURE"
  | "SKIPPED"
  | "PENDING"
  | "";

/**
 * Identifier accepted by every PR/issue operation: a number, a string number
 * (`"42"`), or a full URL (`"https://github.com/owner/repo/pull/42"`). `gh`
 * itself accepts all three forms; we just thread them through.
 */
export type PRId = number | string;
export type IssueId = number | string;

export interface InstalledStatus {
  installed: boolean;
  version?: string;
  path?: string;
}

export interface AuthenticatedStatus {
  authenticated: boolean;
  user?: string;
  host?: string;
}

export interface PRSummary {
  number: number;
  title: string;
  state: PRState;
  url: string;
  isDraft: boolean;
  headRefName: string;
  baseRefName: string;
  author: { login: string };
  createdAt: string;
  updatedAt: string;
}

export interface PRReview {
  author: { login: string };
  state:
    | "APPROVED"
    | "CHANGES_REQUESTED"
    | "COMMENTED"
    | "PENDING"
    | "DISMISSED";
  body: string;
  submittedAt: string;
}

export interface PRComment {
  author: { login: string };
  body: string;
  createdAt: string;
}

export interface CheckRun {
  name: string;
  conclusion: CheckConclusion;
  status: "QUEUED" | "IN_PROGRESS" | "COMPLETED" | "PENDING" | "";
  url: string;
}

export interface PRDetail extends PRSummary {
  body: string;
  reviews: PRReview[];
  comments: PRComment[];
  statusCheckRollup: CheckRun[];
}

export interface IssueSummary {
  number: number;
  title: string;
  state: IssueState;
  url: string;
  author: { login: string };
  labels: Array<{ name: string }>;
  assignees: Array<{ login: string }>;
  createdAt: string;
  updatedAt: string;
}

export interface IssueDetail extends IssueSummary {
  body: string;
  comments: PRComment[];
}

export interface CreatePROptions {
  base: string;
  head: string;
  title: string;
  body: string;
  draft?: boolean;
  reviewers?: string[];
  labels?: string[];
}

export interface ListPROptions {
  state?: "open" | "closed" | "merged" | "all";
  /** Filter by head branch — typical use: `{ head: ws.git.branch }` to find PRs for the current worktree. */
  head?: string;
  /** Filter by base branch (e.g. `"main"`, `"develop"`). */
  base?: string;
  /** Filter by author login. */
  author?: string;
}

export interface MergePROptions {
  method?: "merge" | "squash" | "rebase";
  deleteBranch?: boolean;
}

export interface CreateIssueOptions {
  title: string;
  body: string;
  labels?: string[];
  assignees?: string[];
}

export interface ListIssueOptions {
  state?: "open" | "closed" | "all";
  labels?: string[];
  assignee?: string;
}

/**
 * Result of a `repo.raw` invocation. Aliased to the internal executor type so
 * the two stay in lockstep — if `gh-exec` ever surfaces additional fields
 * (signal, timedOut), `raw` callers see them automatically.
 */
export type RawResult = import("./internal/gh-exec.js").GhExecResult;

export interface RawOptions {
  /** Body piped to `gh` on stdin. Use with `--body-file -` for long inputs. */
  input?: string;
}

export interface RepoOps {
  // PRs
  createPR(opts: CreatePROptions): Promise<PRSummary>;
  listPRs(opts?: ListPROptions): Promise<PRSummary[]>;
  getPR(id: PRId): Promise<PRDetail>;
  commentOnPR(id: PRId, body: string): Promise<void>;
  requestReviewers(id: PRId, reviewers: string[]): Promise<void>;
  merge(id: PRId, opts?: MergePROptions): Promise<void>;
  openInBrowser(id: PRId): Promise<void>;

  // Checks
  listChecks(id: PRId): Promise<CheckRun[]>;

  // Issues
  listIssues(opts?: ListIssueOptions): Promise<IssueSummary[]>;
  getIssue(id: IssueId): Promise<IssueDetail>;
  createIssue(opts: CreateIssueOptions): Promise<IssueSummary>;
  commentOnIssue(id: IssueId, body: string): Promise<void>;

  /**
   * Escape hatch — invoke any `gh` subcommand against this repo's cwd. Returns
   * the raw `{ stdout, stderr, exitCode }` so the caller decides how to parse
   * and how to react to non-zero exits. Still throws `NotInstalledError` if
   * `gh` is missing on `$PATH`.
   *
   * Use the typed methods for routine ops — they handle long-body stdin
   * piping, JSON re-fetch, and error classification. Reach for `raw` when
   * you need a flag we haven't typed (e.g. `gh api`, `gh release`, custom
   * `gh pr edit` flags) or when an agent should drive `gh` directly.
   */
  raw(args: readonly string[], opts?: RawOptions): Promise<RawResult>;
}
