import type {
  AdapterConfig,
  ExecutionContext,
  ExecutionResult,
  StreamEvent,
} from "@agentex/adapters";
import type { DispatchOptions } from "../types.js";
import { renderGatewayTemplate } from "../utils/template.js";

/**
 * Build the prompt string, optionally prepending a rendered system prompt template.
 */
function buildPrompt(opts: DispatchOptions): string {
  const { msg, agentConfig } = opts;
  let prompt = msg.text;

  if (agentConfig.systemPromptTemplate) {
    const rendered = renderGatewayTemplate(agentConfig.systemPromptTemplate, {
      channel: msg.channel,
      sender: { id: msg.senderId, name: msg.senderName ?? "" },
      chatType: msg.chatType,
      threadId: msg.threadId ?? "",
    });
    prompt = rendered + "\n" + prompt;
  }

  return prompt;
}

/**
 * Map AgentConfig fields to the AdapterConfig shape expected by adapters.
 */
function buildAdapterConfig(opts: DispatchOptions): AdapterConfig {
  const { agentConfig } = opts;
  const config: AdapterConfig = {};

  if (agentConfig.maxTurns != null) config.maxTurns = agentConfig.maxTurns;
  if (agentConfig.timeoutSec != null) config.timeoutSec = agentConfig.timeoutSec;
  if (agentConfig.skipPermissions != null) config.skipPermissions = agentConfig.skipPermissions;
  if (agentConfig.skillDirs != null) config.skillDirs = agentConfig.skillDirs;
  if (agentConfig.instructionsFile != null) config.instructionsFile = agentConfig.instructionsFile;
  if (agentConfig.mcpServers != null) config.mcpServers = agentConfig.mcpServers;

  return config;
}

/**
 * Dispatch an inbound message to the configured agent adapter for execution.
 *
 * Builds an {@link ExecutionContext} from the dispatch options, forwards all
 * stream events, extracts system-init events for session tracking, and
 * returns the adapter's {@link ExecutionResult}.
 */
export async function dispatchToAgent(
  opts: DispatchOptions,
): Promise<ExecutionResult> {
  const prompt = buildPrompt(opts);

  const ctx: ExecutionContext = {
    prompt,
    model: opts.agentConfig.model,
    cwd: opts.agentConfig.cwd,
    sessionParams: opts.session.sessionParams,
    config: buildAdapterConfig(opts),
    onEvent(event: StreamEvent) {
      // Extract system-init events to update session metadata
      if (event.type === "system" && event.subtype === "init") {
        opts.onSystemEvent(event.sessionId, event.model);
      }
      // Forward ALL events to the stream handler
      opts.onStreamEvent(event);
    },
    onOutput() {
      // No-op — stdout/stderr is not surfaced through the gateway
    },
  };

  return opts.adapter.execute(ctx);
}
