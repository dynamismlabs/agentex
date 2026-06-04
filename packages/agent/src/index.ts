// Functions
export { getProvider, listProviders, registerProvider } from "./registry.js";
export {
  defineDerivedProvider,
  loadProvidersFromConfig,
  registerAcpFactory,
  MalformedProviderConfigError,
} from "./derived.js";
export type { DerivedProviderConfig, AcpFactory } from "./derived.js";
export { acpProvider } from "./providers/acp/index.js";
export type { AcpProviderConfig } from "./providers/acp/index.js";
export type { AcpTransformers } from "./providers/acp/session.js";
export {
  runHttpAgent,
  httpAgentProvider,
  httpAgentSessionCodec,
} from "./providers/_shared/http-agent.js";
export type { HttpAgentOptions } from "./providers/_shared/http-agent.js";
export { renderTemplate } from "./utils/template.js";
export { redactEnvForLogs } from "./utils/env.js";
export { parseAskUserQuestion } from "./utils/ask-user-question.js";
export { parseExitPlanMode } from "./utils/exit-plan-mode.js";
export { aggregateUsage } from "./types.js";
export { resolveInstructions } from "./utils/instructions.js";
export { getRuntimeHomeEnvVar, getDefaultRuntimeHome } from "./utils/runtime-homes.js";
export { findBinary, ensureCommandResolvable, clearBinaryCache } from "./utils/binary.js";
export type { ResolvedBinary } from "./utils/binary.js";
export {
  detectAuth,
  resolveAuthForProvider,
  clearAuthCache,
  hasSubscription,
  hasApiKey,
  hasBedrock,
  isLoggedIn,
  loginCommandFor,
} from "./utils/auth.js";
export type { ResolvedAuth } from "./utils/auth.js";
export { prepareWorkspace } from "./utils/workspace.js";
export type { WorkspaceOptions, PreparedWorkspace, DiffOptions } from "./utils/workspace.js";
export { withTempConfig } from "./utils/runtime-config.js";
export type { TempConfigResult, TempConfigOptions } from "./utils/runtime-config.js";
export { executeAll } from "./utils/execute-all.js";
export type { ExecuteAllOptions, ExecuteAllTask } from "./utils/execute-all.js";
export {
  getClaudeUnknownDetails,
  classifyClaudeAuthFromResult,
  CLAUDE_LOGIN_COMMAND,
} from "./providers/claude/parse.js";
export {
  getClaudeTranscriptPath,
  findClaudeTranscriptBySessionId,
  readClaudeTranscript,
  peekClaudeTranscript,
  claudeTranscriptOps,
  sanitizeProjectPath,
  resolveClaudeHome,
  canonicalizeCwd,
  MAX_SANITIZED_LENGTH,
} from "./providers/claude/transcript.js";
export type {
  GetClaudeTranscriptPathOptions,
  ClaudeTranscriptLocation,
  FindClaudeTranscriptOptions,
  FoundClaudeTranscript,
  ReadClaudeTranscriptOptions,
  ClaudeTranscriptYield,
  ClaudePeekResult,
} from "./providers/claude/transcript.js";
export {
  getCodexTranscriptPath,
  readCodexTranscript,
  peekCodexTranscript,
  readCodexCwd,
  codexTranscriptOps,
  parseCodexLine,
  resolveCodexHome,
} from "./providers/codex/transcript.js";
export type {
  GetCodexTranscriptPathOptions,
  CodexTranscriptLocation,
  ReadCodexTranscriptOptions,
  CodexTranscriptYield,
  CodexTranscriptLine,
  CodexPeekResult,
} from "./providers/codex/transcript.js";

// Skills
export {
  installSkills,
  removeSkills,
  listInstalledSkills,
  resolveSkillsHome,
  resolveSkillsWorkspace,
  resolveNativeSkillsHome,
  resolveNativeSkillsWorkspace,
  ensureSkillSymlink,
} from "./utils/skills.js";
export {
  commandInventoryFromEvent,
  discoverSkillCommands,
  reconcileSkillCommands,
  formatSlashInvocation,
  invokeSkill,
  buildExpandedSkillPrompt,
} from "./utils/skill-commands.js";

// Types
export type {
  ProviderModule,
  ProviderCapabilities,
  AgentMode,
  ListModesOptions,
  ExecutionContext,
  ExecutionResult,
  ExecutionStatus,
  ProviderConfig,
  McpServerConfig,
  StreamEvent,
  SessionCodec,
  SessionState,
  TokenUsage,
  ModelUsage,
  RateLimitInfo,
  BaseStreamEventFields,
  LifecycleEvent,
  QuotaStatus,
  QuotaContext,
  AuthMethod,
  AuthSource,
  AuthOption,
  AuthReport,
  AuthResolveContext,
  AuthIdentity,
  AuthRequiredReason,
  BinaryStatus,
  ProviderModel,
  SessionContext,
  AgentSession,
  SendHandle,
  SendOptions,
  CancelResult,
  TurnResult,
  UserInputRequest,
  UserInputResponse,
  ElicitationRequest,
  ElicitationResponse,
  HookCallbackRequest,
  HookCallbackResponse,
  TranscriptOps,
  TranscriptYield,
  TranscriptPeek,
  FoundTranscript,
} from "./types.js";

export type {
  AskUserQuestion,
  QuestionOption,
} from "./utils/ask-user-question.js";

export type { ExitPlanModeRequest } from "./utils/exit-plan-mode.js";

export type {
  SkillRuntime,
  SkillLocation,
  SkillChannel,
  InstallSkillsOptions,
  SkillInstallEntry,
  SkillInstallResult,
  RemoveSkillsOptions,
  SkillRemoveEntry,
  SkillRemoveResult,
  InstalledSkill,
} from "./utils/skills.js";

export type {
  SkillCommandSource,
  SkillCommandExecution,
  SkillCommandDescriptor,
  RuntimeCommandInventory,
  SkillCommandDiagnostic,
  DiscoverSkillCommandsOptions,
  DiscoverSkillCommandsResult,
  ReconcileSkillCommandsOptions,
  InvokeSkillOptions,
} from "./utils/skill-commands.js";
