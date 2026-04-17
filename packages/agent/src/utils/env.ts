import process from "node:process";

const BASE_ALLOW_LIST = [
  "PATH", "HOME", "TMPDIR", "TEMP", "TMP", "USER", "LOGNAME", "LANG", "LC_ALL",
  // Windows essentials
  "SystemRoot", "WINDIR", "COMSPEC", "PATHEXT", "APPDATA", "LOCALAPPDATA", "USERPROFILE",
];

/** Auth env vars that providers need for API-key auth and billing detection. */
const AUTH_ALLOW_LIST = [
  // Claude / Anthropic
  "ANTHROPIC_API_KEY", "ANTHROPIC_BEDROCK_BASE_URL",
  // AWS (Bedrock)
  "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "AWS_REGION", "AWS_PROFILE",
  // Codex / OpenAI
  "OPENAI_API_KEY",
  // Gemini / Google
  "GEMINI_API_KEY", "GOOGLE_API_KEY",
  // Cursor
  "CURSOR_API_KEY",
];

const SENSITIVE_PATTERNS = /KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL|AUTH/i;

const ESSENTIAL_PATHS_UNIX = ["/usr/local/bin", "/usr/bin", "/bin"];

export function buildEnv(callerEnv?: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of BASE_ALLOW_LIST) {
    const val = process.env[key];
    if (val !== undefined) env[key] = val;
  }
  for (const key of AUTH_ALLOW_LIST) {
    const val = process.env[key];
    if (val !== undefined) env[key] = val;
  }
  if (callerEnv) Object.assign(env, callerEnv);
  return env;
}

export function redactEnvForLogs(env: Record<string, string>): Record<string, string> {
  const redacted: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    redacted[key] = SENSITIVE_PATTERNS.test(key) ? "[REDACTED]" : value;
  }
  return redacted;
}

export function ensurePathInEnv(env: Record<string, string>): void {
  const isWin = process.platform === "win32";
  const sep = isWin ? ";" : ":";
  const essentials = isWin ? [] : ESSENTIAL_PATHS_UNIX;
  const current = env["PATH"] ?? env["Path"] ?? "";
  const parts = current.split(sep);
  for (const p of essentials) {
    if (!parts.includes(p)) parts.push(p);
  }
  env["PATH"] = parts.join(sep);
}
