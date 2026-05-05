// Top-level API
export { workspace } from "./workspace.js";

// Errors
export {
  ArchiveScriptFailedError,
  BranchExistsError,
  DirtyWorktreeError,
  EmptyScriptError,
  LinkDestinationConflictError,
  MalformedConfigError,
  MergeConflictError,
  NoDefaultBranchError,
  NotAGitRepoError,
  RemoteAlreadyExistsError,
  ScriptNotFoundError,
  SourceFileMissingError,
  SourceNotProvidedError,
  WorkspaceNotFoundError,
} from "./errors.js";

// Types
export type {
  ArchiveOptions,
  BareWorkspace,
  ContextDir,
  CreateBareOptions,
  CreateGitOptions,
  CreateOptions,
  DiffSpec,
  Disposer,
  FromSourceWarnings,
  GitCapability,
  GitRawResult,
  GitWorkspace,
  OpenOptions,
  PortAllocator,
  PullLatestBaseOptions,
  RunHandle,
  ShortStat,
  StructuredDiff,
  StructuredDiffFile,
  StructuredDiffHunk,
  StructuredDiffLine,
  TreeNode,
  WatchEvent,
  WatchEventKind,
  WatchHandler,
  WatchOptions,
  WatchSubscription,
  Workspace,
  WorkspaceKind,
  WorkspaceStatus,
} from "./types.js";

export type { FromSourceConfig, WorkspaceConfig } from "./config.js";
