import { checkAuthenticated, checkInstalled } from "./preflight.js";
import { makeRepoOps } from "./repo.js";

export const github = {
  checkInstalled,
  checkAuthenticated,
  /** Build a repo-scoped operations bundle bound to `cwd = path`. */
  repo: makeRepoOps,
} as const;

export {
  BranchNotFoundError,
  GhCommandError,
  NotAuthenticatedError,
  NotInstalledError,
  RateLimitedError,
  RepoNotFoundError,
} from "./errors.js";

export type {
  AuthenticatedStatus,
  CheckConclusion,
  CheckRun,
  CreateIssueOptions,
  CreatePROptions,
  InstalledStatus,
  IssueDetail,
  IssueId,
  IssueState,
  IssueSummary,
  ListIssueOptions,
  ListPROptions,
  MergePROptions,
  PRComment,
  PRDetail,
  PRId,
  PRReview,
  PRState,
  PRSummary,
  RawOptions,
  RawResult,
  RepoOps,
} from "./types.js";

export {
  _resetGhExecutor,
  _setGhExecutor,
} from "./internal/gh-exec.js";
export type { GhExecResult, GhExecutor } from "./internal/gh-exec.js";
