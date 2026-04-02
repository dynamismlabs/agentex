import type { ProviderModule, ProviderModel, SessionContext, AgentSession } from "../../types.js";
import { executeClaudeProvider } from "./execute.js";
import { createClaudeSession } from "./session.js";
import { testClaudeEnvironment } from "./test.js";
import { claudeSessionCodec } from "./codec.js";
import { findBinary } from "../../utils/binary.js";
import { buildEnv, ensurePathInEnv } from "../../utils/env.js";
import { runChildProcess } from "../../utils/process.js";

async function listModels(): Promise<ProviderModel[]> {
  try {
    const resolved = await findBinary("claude");
    const env = buildEnv();
    ensurePathInEnv(env);
    const proc = await runChildProcess({
      runId: "list-models",
      command: resolved.bin,
      args: [...resolved.prefixArgs, "--list-models"],
      cwd: process.cwd(),
      env,
      timeoutSec: 10,
    });

    if ((proc.exitCode ?? 1) === 0 && proc.stdout.trim()) {
      return proc.stdout
        .trim()
        .split(/\r?\n/)
        .filter((line) => line.trim())
        .map((line) => {
          const id = line.trim();
          return { id, name: id, provider: "anthropic" };
        });
    }
  } catch {
    // Fallback to hardcoded list
  }

  return [
    { id: "claude-sonnet-4-20250514", name: "Claude Sonnet 4", provider: "anthropic" },
    { id: "claude-opus-4-20250514", name: "Claude Opus 4", provider: "anthropic" },
    { id: "claude-haiku-3-5-20241022", name: "Claude Haiku 3.5", provider: "anthropic" },
  ];
}

export const claudeProvider: ProviderModule = {
  type: "claude",
  execute: executeClaudeProvider,
  createSession: (ctx: SessionContext): Promise<AgentSession> => createClaudeSession(ctx),
  testEnvironment: testClaudeEnvironment,
  sessionCodec: claudeSessionCodec,
  listModels,
};
