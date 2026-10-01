import type { ProviderModule } from "../../types.js";
import { acpProvider } from "../acp/index.js";
import { resolveAuthForProvider } from "../../utils/auth.js";

/**
 * Gemini via the Agent Client Protocol (`gemini --acp`). Requires a recent
 * `@google/gemini-cli` on PATH; Gemini handles its own Google auth (GEMINI_API_KEY,
 * GOOGLE_API_KEY, or an OAuth login).
 *
 * Since 2026-06-18 Gemini CLI no longer serves free, Google AI Pro, or Google
 * AI Ultra sign-ins ("This client is no longer supported for Gemini Code
 * Assist for individuals"); those accounts moved to the Antigravity CLI — use
 * the `antigravity` provider. Gemini CLI still works with a paid API key and
 * Gemini Code Assist Standard/Enterprise.
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
