// Functions
export { getProvider, listProviders, registerProvider } from "./registry.js";
export { renderTemplate } from "./utils/template.js";
export { redactEnvForLogs } from "./utils/env.js";
export { parseAskUserQuestion } from "./utils/ask-user-question.js";
export { aggregateUsage } from "./types.js";
export { resolveInstructions } from "./utils/instructions.js";
export { getRuntimeHomeEnvVar, getDefaultRuntimeHome } from "./utils/runtime-homes.js";
export {
  detectAuth,
  resolveAuthForProvider,
  hasSubscription,
  hasApiKey,
  hasBedrock,
} from "./utils/auth.js";
export type { ResolvedAuth } from "./utils/auth.js";
export { prepareWorkspace } from "./utils/workspace.js";
export type { WorkspaceOptions, PreparedWorkspace, DiffOptions } from "./utils/workspace.js";
export { withTempConfig } from "./utils/runtime-config.js";
export type { TempConfigResult, TempConfigOptions } from "./utils/runtime-config.js";
export { executeAll } from "./utils/execute-all.js";
export type { ExecuteAllOptions, ExecuteAllTask } from "./utils/execute-all.js";

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

// Types
export type {
  ProviderModule,
  ProviderCapabilities,
  ExecutionContext,
  ExecutionResult,
  ExecutionStatus,
  ProviderConfig,
  McpServerConfig,
  StreamEvent,
  SessionCodec,
  SessionState,
  TokenUsage,
  LifecycleEvent,
  QuotaStatus,
  QuotaContext,
  EnvironmentTestContext,
  EnvironmentTestResult,
  EnvironmentCheck,
  AuthMethod,
  AuthSource,
  AuthOption,
  AuthReport,
  AuthResolveContext,
  ProviderModel,
  SessionContext,
  AgentSession,
  TurnResult,
  UserInputRequest,
  UserInputResponse,
  ElicitationRequest,
  ElicitationResponse,
  HookCallbackRequest,
  HookCallbackResponse,
} from "./types.js";

export type {
  AskUserQuestion,
  QuestionOption,
} from "./utils/ask-user-question.js";

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
