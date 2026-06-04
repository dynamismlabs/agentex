import type { ProviderModule } from "../../types.js";
import { acpProvider } from "../acp/index.js";
import { resolveAuthForProvider } from "../../utils/auth.js";

/**
 * Gemini via the Agent Client Protocol (`gemini --acp`). Requires a recent
 * `@google/gemini-cli` on PATH; Gemini handles its own Google auth (GEMINI_API_KEY,
 * GOOGLE_API_KEY, or an OAuth login).
 *
 * Replaces the previous one-shot `--output-format stream-json` adapter: the ACP
 * base gives gemini real sessions, streaming, tool-call correlation, permission
 * bridging (via `onUserInputRequest`), and mode discovery — none of which the
 * stub parser had.
 */
const gemini: ProviderModule = acpProvider({ id: "gemini", command: ["gemini", "--acp"] });

// Keep gemini's richer auth reporting (API key / OAuth presence) rather than the
// generic ACP binary-only check.
gemini.resolveAuth = (ctx) => resolveAuthForProvider("gemini", ctx);

export const geminiProvider = gemini;
