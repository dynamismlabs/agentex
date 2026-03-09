import { exec } from "node:child_process";
import { renderGatewayTemplate } from "../utils/template.js";
import type { HookConfig, GatewayEventPayload, Logger } from "../types.js";

export function executeHook(
  hookConfig: HookConfig,
  payload: GatewayEventPayload,
  log: Logger,
): void {
  const templateData: Record<string, unknown> = {
    type: payload.type,
    seq: payload.seq,
    ts: payload.ts,
    sessionKey: payload.sessionKey,
    ...payload.data,
  };

  let command: string;
  try {
    command = renderGatewayTemplate(hookConfig.command, templateData);
  } catch (err) {
    log.error("Hook template rendering failed", err);
    return;
  }

  try {
    exec(command, (error) => {
      if (error) {
        log.error("Hook command failed: %s", error.message);
      }
    });
  } catch (err) {
    log.error("Hook execution failed", err);
  }
}
