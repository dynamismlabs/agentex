import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** Detect replacement, login, logout and in-place writes without reading tokens. */
export async function fileIdentity(path: string): Promise<unknown[]> {
  try {
    const info = await stat(path);
    return [path, info.ino, info.size, info.mtimeMs, info.ctimeMs];
  } catch { return [path, null]; }
}

export async function nativeAuthFileIdentity(provider: string, cwd: string, env: Record<string, string | undefined>): Promise<unknown[][]> {
  if (provider !== "codex" && provider !== "claude") return [];
  const userHome = env.HOME ?? env.USERPROFILE ?? homedir();
  const home = resolve(cwd, env[provider === "codex" ? "CODEX_HOME" : "CLAUDE_CONFIG_DIR"] ?? join(userHome, `.${provider}`));
  const paths = provider === "codex" ? [join(home, "auth.json")]
    : [join(home, ".credentials.json"), resolve(cwd, userHome, ".claude.json")];
  return Promise.all(paths.map(fileIdentity));
}
