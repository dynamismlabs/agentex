import type { ProviderModule, SessionContext, AgentSession } from "../../types.js";
import { codexSessionCodec } from "./codec.js";
import { resolveAuthForProvider } from "../../utils/auth.js";
import { codexTranscriptOps } from "./transcript.js";
import { codexGoalCapability } from "./goal-capability.js";

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
    durableSessions: true,
    durableHistory: true,
    localHistory: true,
    resume: true,
    modelVariants: false,
    permissionRequests: true,
    questionRequests: true,
    strictMcpIsolation: false,
    upstreamProviderDisconnect: false,
    sessionModelChange: true,
    sessionVariantChange: false,
    sessionEffortChange: true,
    sessionModeChange: false,
  },
  // Heavy machinery (execute.ts, session.ts, modes.ts, attach.ts) loads lazily
  // on first use — every ProviderModule method is already async.
  execute: async (ctx) => (await import("./execute.js")).executeCodexProvider(ctx),
  createSession: async (ctx: SessionContext): Promise<AgentSession> =>
    (await import("./session.js")).createCodexSession(ctx),
  resolveAuth: (ctx) => resolveAuthForProvider("codex", ctx),
  sessionCodec: codexSessionCodec,
  transcript: codexTranscriptOps,
  listModes: async (opts) => (await import("./modes.js")).listCodexModes(opts),
  attachSession: async (record, opts) =>
    (await import("./attach.js")).attachCodexSession(record, opts),
  attachHistory: async (record, opts) => {
    const [{ attachCodexSession }, { historyFromSessionAttachment }] = await Promise.all([
      import("./attach.js"),
      import("../../sessions/history.js"),
    ]);
    return historyFromSessionAttachment("codex", await attachCodexSession(record, opts));
  },
  localHistory: {
    probe: (options) => import("./history.js").then((module) => module.codexLocalHistory.probe(options)),
    discover: (options) => ({
      async *[Symbol.asyncIterator]() {
        const module = await import("./history.js");
        yield* module.codexLocalHistory.discover(options);
      },
    }),
    read: (session, options) => ({
      async *[Symbol.asyncIterator]() {
        const module = await import("./history.js");
        yield* module.codexLocalHistory.read(session, options);
      },
    }),
    fingerprint: (session, options) => import("./history.js")
      .then((module) => module.codexLocalHistory.fingerprint(session, options)),
  },
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
export { codexLineToStreamEvents } from "./transcript-normalize.js";
export type {
  GetCodexTranscriptPathOptions,
  CodexTranscriptLocation,
  ReadCodexTranscriptOptions,
  CodexTranscriptYield,
  CodexTranscriptLine,
  CodexPeekResult,
} from "./transcript.js";
