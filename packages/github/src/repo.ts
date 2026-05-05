import { mapAndThrow } from "./error-mapping.js";
import { ghExec } from "./internal/gh-exec.js";
import type {
  CheckRun,
  CreateIssueOptions,
  CreatePROptions,
  IssueDetail,
  IssueId,
  IssueSummary,
  ListIssueOptions,
  ListPROptions,
  MergePROptions,
  PRDetail,
  PRId,
  PRSummary,
  RepoOps,
} from "./types.js";

const PR_SUMMARY_FIELDS = [
  "number",
  "title",
  "state",
  "url",
  "isDraft",
  "headRefName",
  "baseRefName",
  "author",
  "createdAt",
  "updatedAt",
].join(",");

const PR_DETAIL_FIELDS = [
  "number",
  "title",
  "body",
  "state",
  "url",
  "isDraft",
  "headRefName",
  "baseRefName",
  "author",
  "createdAt",
  "updatedAt",
  "reviews",
  "comments",
  "statusCheckRollup",
].join(",");

const ISSUE_SUMMARY_FIELDS = [
  "number",
  "title",
  "state",
  "url",
  "author",
  "labels",
  "assignees",
  "createdAt",
  "updatedAt",
].join(",");

const ISSUE_DETAIL_FIELDS = [
  "number",
  "title",
  "body",
  "state",
  "url",
  "author",
  "labels",
  "assignees",
  "createdAt",
  "updatedAt",
  "comments",
].join(",");

const CHECK_FIELDS = ["name", "conclusion", "status", "url"].join(",");

function asGhId(id: PRId | IssueId): string {
  return String(id);
}

function parseNumberFromUrl(url: string): number {
  const m = url.match(/\/pull\/(\d+)(?:\/|$)/) ?? url.match(/\/issues\/(\d+)(?:\/|$)/);
  if (!m || !m[1]) {
    throw new Error(`gh: could not parse issue/PR number from URL: ${url}`);
  }
  return parseInt(m[1], 10);
}

function pickHttpsLine(stdout: string): string {
  const trimmed = stdout.trim();
  const httpsLine = trimmed.split("\n").find((l) => l.startsWith("https://"));
  return httpsLine ?? trimmed;
}

async function ghJson<T>(args: readonly string[], cwd: string): Promise<T> {
  const r = await ghExec(args, { cwd });
  if (r.exitCode !== 0) mapAndThrow(args, r);
  return JSON.parse(r.stdout) as T;
}

async function ghVoid(
  args: readonly string[],
  cwd: string,
  opts: { input?: string } = {},
): Promise<void> {
  const r = await ghExec(args, { cwd, ...(opts.input !== undefined ? { input: opts.input } : {}) });
  if (r.exitCode !== 0) mapAndThrow(args, r);
}

export function makeRepoOps(repoPath: string): RepoOps {
  if (typeof repoPath !== "string" || repoPath.length === 0) {
    throw new Error("github.repo: path must be a non-empty string");
  }

  async function createPR(opts: CreatePROptions): Promise<PRSummary> {
    if (!opts.base || !opts.head || !opts.title) {
      throw new Error("github.repo.createPR: base, head, and title are required");
    }

    // Pipe the body via stdin (--body-file -) so we don't hit the OS arg-length
    // limit on long bodies (E2BIG; ~256KB on macOS, ~128KB on Linux). gh
    // accepts `--body-file -` as "read from stdin" for create / comment ops.
    const args = [
      "pr",
      "create",
      "--base",
      opts.base,
      "--head",
      opts.head,
      "--title",
      opts.title,
      "--body-file",
      "-",
    ];
    if (opts.draft) args.push("--draft");
    for (const r of opts.reviewers ?? []) args.push("--reviewer", r);
    for (const l of opts.labels ?? []) args.push("--label", l);

    const result = await ghExec(args, { cwd: repoPath, input: opts.body });
    if (result.exitCode !== 0) mapAndThrow(args, result);

    // `gh pr create` prints the URL on success; we re-read with --json to
    // return a fully-typed PRSummary rather than a partial.
    const url = pickHttpsLine(result.stdout);
    const number = parseNumberFromUrl(url);

    return ghJson<PRSummary>(
      ["pr", "view", String(number), "--json", PR_SUMMARY_FIELDS],
      repoPath,
    );
  }

  async function listPRs(opts: ListPROptions = {}): Promise<PRSummary[]> {
    const args = ["pr", "list", "--json", PR_SUMMARY_FIELDS];
    if (opts.state) args.push("--state", opts.state);
    if (opts.head) args.push("--head", opts.head);
    if (opts.base) args.push("--base", opts.base);
    if (opts.author) args.push("--author", opts.author);
    args.push("--limit", "200");
    return ghJson<PRSummary[]>(args, repoPath);
  }

  async function getPR(id: PRId): Promise<PRDetail> {
    return ghJson<PRDetail>(["pr", "view", asGhId(id), "--json", PR_DETAIL_FIELDS], repoPath);
  }

  async function commentOnPR(id: PRId, body: string): Promise<void> {
    if (!body) {
      throw new Error("github.repo.commentOnPR: body must be a non-empty string");
    }
    // Pipe via stdin (--body-file -) — see createPR for rationale.
    await ghVoid(["pr", "comment", asGhId(id), "--body-file", "-"], repoPath, { input: body });
  }

  async function requestReviewers(id: PRId, reviewers: string[]): Promise<void> {
    if (!Array.isArray(reviewers) || reviewers.length === 0) {
      throw new Error("github.repo.requestReviewers: reviewers must be a non-empty array");
    }
    const args = ["pr", "edit", asGhId(id)];
    for (const r of reviewers) args.push("--add-reviewer", r);
    await ghVoid(args, repoPath);
  }

  async function merge(id: PRId, opts: MergePROptions = {}): Promise<void> {
    const args = ["pr", "merge", asGhId(id)];
    const method = opts.method ?? "merge";
    if (method === "squash") args.push("--squash");
    else if (method === "rebase") args.push("--rebase");
    else args.push("--merge");
    if (opts.deleteBranch) args.push("--delete-branch");
    await ghVoid(args, repoPath);
  }

  async function openInBrowser(id: PRId): Promise<void> {
    await ghVoid(["pr", "view", asGhId(id), "--web"], repoPath);
  }

  async function listChecks(id: PRId): Promise<CheckRun[]> {
    return ghJson<CheckRun[]>(
      ["pr", "checks", asGhId(id), "--json", CHECK_FIELDS],
      repoPath,
    );
  }

  async function listIssues(opts: ListIssueOptions = {}): Promise<IssueSummary[]> {
    const args = ["issue", "list", "--json", ISSUE_SUMMARY_FIELDS, "--limit", "200"];
    if (opts.state) args.push("--state", opts.state);
    if (opts.labels && opts.labels.length > 0) args.push("--label", opts.labels.join(","));
    if (opts.assignee) args.push("--assignee", opts.assignee);
    return ghJson<IssueSummary[]>(args, repoPath);
  }

  async function getIssue(id: IssueId): Promise<IssueDetail> {
    return ghJson<IssueDetail>(
      ["issue", "view", asGhId(id), "--json", ISSUE_DETAIL_FIELDS],
      repoPath,
    );
  }

  async function createIssue(opts: CreateIssueOptions): Promise<IssueSummary> {
    if (!opts.title) {
      throw new Error("github.repo.createIssue: title is required");
    }
    // Pipe body via stdin (--body-file -) — see createPR for rationale.
    const args = ["issue", "create", "--title", opts.title, "--body-file", "-"];
    for (const l of opts.labels ?? []) args.push("--label", l);
    for (const a of opts.assignees ?? []) args.push("--assignee", a);

    const result = await ghExec(args, { cwd: repoPath, input: opts.body });
    if (result.exitCode !== 0) mapAndThrow(args, result);

    const url = pickHttpsLine(result.stdout);
    const number = parseNumberFromUrl(url);

    return ghJson<IssueSummary>(
      ["issue", "view", String(number), "--json", ISSUE_SUMMARY_FIELDS],
      repoPath,
    );
  }

  async function commentOnIssue(id: IssueId, body: string): Promise<void> {
    if (!body) {
      throw new Error("github.repo.commentOnIssue: body must be a non-empty string");
    }
    await ghVoid(
      ["issue", "comment", asGhId(id), "--body-file", "-"],
      repoPath,
      { input: body },
    );
  }

  return {
    createPR,
    listPRs,
    getPR,
    commentOnPR,
    requestReviewers,
    merge,
    openInBrowser,
    listChecks,
    listIssues,
    getIssue,
    createIssue,
    commentOnIssue,
  };
}
