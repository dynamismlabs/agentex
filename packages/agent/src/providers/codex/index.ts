import type { ProviderModule, SessionContext, AgentSession } from "../../types.js";
import { executeCodexProvider } from "./execute.js";
import { createCodexSession, codexGoalCapability } from "./session.js";
import { codexSessionCodec } from "./codec.js";
import { resolveAuthForProvider } from "../../utils/auth.js";
import { codexTranscriptOps } from "./transcript.js";
import { listCodexModes } from "./modes.js";

export const codexProvider: ProviderModule = {
  type: "codex",
  capabilities: {
    sessions: true,
    modelDiscovery: false,
    quotaProbing: false,
    mcp: false,
    skills: true,
    skillInventory: "local-discovery",
    skillInvocation: "expanded-prompt",
    instructions: true,
    workspace: true,
    planMode: true,
    concurrentSend: true,
    cancelQueuedMessage: false,
    stopTask: false,
    modes: true,
    goals: codexGoalCapability,
  },
  execute: executeCodexProvider,
  createSession: (ctx: SessionContext): Promise<AgentSession> => createCodexSession(ctx),
  resolveAuth: (ctx) => resolveAuthForProvider("codex", ctx),
  sessionCodec: codexSessionCodec,
  transcript: codexTranscriptOps,
  listModes: listCodexModes,
};

export {
  getCodexTranscriptPath,
  readCodexTranscript,
  peekCodexTranscript,
  readCodexCwd,
  codexTranscriptOps,
  parseCodexLine,
  resolveCodexHome,
} from "./transcript.js";
export type {
  GetCodexTranscriptPathOptions,
  CodexTranscriptLocation,
  ReadCodexTranscriptOptions,
  CodexTranscriptYield,
  CodexTranscriptLine,
  CodexPeekResult,
} from "./transcript.js";
