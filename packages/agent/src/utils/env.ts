import process from "node:process";

const BASE_ALLOW_LIST = [
  "PATH", "HOME", "TMPDIR", "TEMP", "TMP", "USER", "LOGNAME", "LANG", "LC_ALL",
  // Windows essentials
  "SystemRoot", "WINDIR", "COMSPEC", "PATHEXT", "APPDATA", "LOCALAPPDATA", "USERPROFILE",
];

const SENSITIVE_PATTERNS = /KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL|AUTH/i;

const ESSENTIAL_PATHS_UNIX = ["/usr/local/bin", "/usr/bin", "/bin"];

export function buildEnv(callerEnv?: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of BASE_ALLOW_LIST) {
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
