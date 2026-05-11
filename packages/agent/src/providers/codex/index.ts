import type { ProviderModule, SessionContext, AgentSession } from "../../types.js";
import { executeCodexProvider } from "./execute.js";
import { createCodexSession } from "./session.js";
import { codexSessionCodec } from "./codec.js";
import { resolveAuthForProvider } from "../../utils/auth.js";
import { codexTranscriptOps } from "./transcript.js";

export const codexProvider: ProviderModule = {
  type: "codex",
  capabilities: {
    sessions: true,
    modelDiscovery: false,
    quotaProbing: false,
    mcp: false,
    skills: true,
    instructions: true,
    workspace: true,
    planMode: true,
  },
  execute: executeCodexProvider,
  createSession: (ctx: SessionContext): Promise<AgentSession> => createCodexSession(ctx),
  resolveAuth: (ctx) => resolveAuthForProvider("codex", ctx),
  sessionCodec: codexSessionCodec,
  transcript: codexTranscriptOps,
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
