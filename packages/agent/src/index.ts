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
export {
  translateEndpoint,
  CODEX_CUSTOM_PROVIDER_ID,
  CODEX_CUSTOM_KEY_ENV,
} from "./utils/endpoint.js";
export type { EndpointTranslation } from "./utils/endpoint.js";
export { parseAskUserQuestion } from "./utils/ask-user-question.js";
export { parseExitPlanMode } from "./utils/exit-plan-mode.js";
export { aggregateUsage } from "./types.js";
export {
  resolveInstructions,
  installInstructions,
  removeInstructions,
  resolveInstructionTargets,
  upsertManagedBlock,
  stripManagedBlock,
} from "./utils/instructions.js";
export type {
  InstallInstructionsOptions,
  InstructionStatus,
  InstructionInstallEntry,
  InstructionInstallResult,
  InstructionTarget,
  RemoveInstructionsOptions,
  InstructionRemoveStatus,
  InstructionRemoveEntry,
  InstructionRemoveResult,
  ManagedBlockOptions,
} from "./utils/instructions.js";
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
  getClaudeTaskDetails,
  classifyClaudeAuthFromResult,
  CLAUDE_LOGIN_COMMAND,
} from "./providers/claude/parse.js";
export type {
  ClaudeTaskDetails,
  ClaudeTaskUsage,
  ClaudeTaskStatus,
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
export { codexLineToStreamEvents } from "./providers/codex/transcript-normalize.js";
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
  ProviderRuntimeContext,
  ProviderRuntimeReport,
  CapabilityStatus,
  AgentMode,
  ListModesOptions,
  ExecutionContext,
  ExecutionResult,
  ExecutionStatus,
  ProviderConfig,
  ProviderEndpointConfig,
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
  BackgroundTaskType,
  BackgroundTaskPhase,
  BackgroundTaskStatus,
  BinaryStatus,
  ProviderModel,
  ListModelsOptions,
  ProviderAuthMethod,
  ProviderAuthFlow,
  UpstreamProvider,
  UpstreamProviderManager,
  SessionContext,
  AgentSession,
  SendHandle,
  SendOptions,
  CancelResult,
  StopTaskResult,
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
  GoalStatus,
  GoalBlockedReason,
  GoalSource,
  GoalCapability,
  GoalState,
  GoalOptions,
  SetGoalResult,
  ClearGoalResult,
  GoalSentinel,
  GoalSentinelVerdict,
  GoalSentinelContext,
} from "./types.js";

// Persisted session discovery. Runtime errors are exported from the
// `@agentex/agent/history` subpath to keep the root barrel lazy.
export type {
  SavedHistoryArchiveState,
  SavedHistoryDiscoverOptions,
  SavedHistoryEvent,
  SavedHistoryOps,
  SavedHistoryProbeOptions,
  SavedHistoryProbeResult,
  SavedHistoryReadOptions,
  SavedHistorySession,
  SavedHistoryUserEvent,
  SavedHistoryYield,
  LocalHistoryArchiveState,
  LocalHistoryDiscoverOptions,
  LocalHistoryErrorCode,
  LocalHistoryEvent,
  LocalHistoryFingerprintOptions,
  LocalHistoryOps,
  LocalHistoryProbeOptions,
  LocalHistoryProbeResult,
  LocalHistoryReadOptions,
  LocalHistorySession,
  LocalHistorySourceFingerprint,
  LocalHistoryUserEvent,
  LocalHistoryYield,
} from "./history/index.js";

// Goals
export {
  GoalController,
  EMULATED_GOAL_CAPABILITY,
  GOAL_OBJECTIVE_MAX,
  CODEX_GOAL_TOOLS,
  isTerminalGoalStatus,
  goalStateFromEvent,
  latestGoalFromEvents,
  normalizeClaudeGoalAttachment,
  normalizeCodexGoalStatus,
  normalizeCodexGoalRecord,
  createDefaultSentinel,
  parseAssessment,
} from "./goals/index.js";
export type {
  GoalControllerDeps,
  GoalStatusEvent,
  NormalizedGoalFields,
} from "./goals/index.js";

// Durable sessions
export {
  SESSION_RECORD_VERSION,
  MalformedSessionRecordError,
  createSessionRecord,
  isSessionRecord,
  assertSessionRecord,
} from "./sessions/index.js";
export type { CreateSessionRecordInput } from "./sessions/index.js";
export type {
  SessionRecord,
  LastTurnStatus,
  CatchUpYield,
  CatchUpOptions,
  AttachOptions,
  SessionAttachment,
  HistoryCheckpoint,
  HistorySource,
  HistoryCatchUpYield,
  HistoryCatchUpOptions,
  HistoryAttachment,
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
