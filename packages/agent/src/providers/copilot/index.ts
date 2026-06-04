import { acpProvider } from "../acp/index.js";

/**
 * GitHub Copilot CLI via the Agent Client Protocol (`copilot --acp`). Copilot
 * handles its own GitHub auth.
 *
 * Adding Copilot is the whole point of the ACP tier — it's a handful of lines
 * because the ACP base does the work (sessions, streaming, tool-call
 * correlation, permission bridging, mode discovery).
 *
 * NOTE: Copilot also exposes an "allow-all" approval mode through an ACP
 * `setSessionConfigOption` (distinct from `setSessionMode`). Fully surfacing it
 * would need a config-option transformer hook (future work); the standard
 * mode + permission flow works today.
 */
export const copilotProvider = acpProvider({
  id: "copilot",
  command: ["copilot", "--acp"],
});
