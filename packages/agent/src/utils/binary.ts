import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { execFile } from "node:child_process";

export interface ResolvedBinary {
  bin: string;
  prefixArgs: string[];
}

const cache = new Map<string, ResolvedBinary>();

const COMMON_PATHS_UNIX: Record<string, string[]> = {
  claude: [
    path.join(os.homedir(), ".local", "bin", "claude"),
    "/usr/local/bin/claude",
    path.join(os.homedir(), ".npm-global", "bin", "claude"),
  ],
  codex: [
    path.join(os.homedir(), ".local", "bin", "codex"),
    "/usr/local/bin/codex",
    path.join(os.homedir(), ".npm-global", "bin", "codex"),
  ],
  gemini: [
    path.join(os.homedir(), ".local", "bin", "gemini"),
    "/usr/local/bin/gemini",
    path.join(os.homedir(), ".npm-global", "bin", "gemini"),
  ],
  agent: [
    path.join(os.homedir(), ".local", "bin", "agent"),
    "/usr/local/bin/agent",
    path.join(os.homedir(), ".npm-global", "bin", "agent"),
  ],
  opencode: [
    path.join(os.homedir(), ".local", "bin", "opencode"),
    "/usr/local/bin/opencode",
    path.join(os.homedir(), ".npm-global", "bin", "opencode"),
  ],
  pi: [
    path.join(os.homedir(), ".local", "bin", "pi"),
    "/usr/local/bin/pi",
    path.join(os.homedir(), ".npm-global", "bin", "pi"),
  ],
};

function getCommonPathsWindows(name: string): string[] {
  const appData = process.env["APPDATA"] ?? "";
  const localAppData = process.env["LOCALAPPDATA"] ?? "";
  const userProfile = process.env["USERPROFILE"] ?? "";
  return [
    path.join(appData, "npm", `${name}.cmd`),
    path.join(localAppData, "pnpm", `${name}.cmd`),
    path.join(userProfile, ".local", "bin", `${name}.exe`),
  ];
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

function runWhich(name: string): Promise<string | null> {
  const cmd = process.platform === "win32" ? "where" : "which";
  return new Promise((resolve) => {
    const child = execFile(cmd, [name], { timeout: 5000 }, (err, stdout) => {
      if (err) {
        resolve(null);
        return;
      }
      const result = stdout.trim().split("\n")[0]?.trim();
      resolve(result ?? null);
    });
    child.on("error", () => resolve(null));
  });
}

export async function resolveWindowsCmdShim(cmdPath: string): Promise<ResolvedBinary | null> {
  try {
    const content = await fs.readFile(cmdPath, "utf-8");
    // Match patterns like: "%dp0%\node_modules\...\.js" or "%~dp0\...\entry.js"
    const match = content.match(/%(?:~dp0|dp0)[\\\/]([^\s"]+\.js)/i);
    if (match?.[1]) {
      const dir = path.dirname(cmdPath);
      const jsPath = path.resolve(dir, match[1]);
      if (await fileExists(jsPath)) {
        return { bin: "node", prefixArgs: [jsPath] };
      }
    }
  } catch {
    // Not a .cmd shim or can't read
  }
  return null;
}

export async function findBinary(name: string, configOverride?: string): Promise<ResolvedBinary> {
  // 1. Config override
  if (configOverride) {
    if (await fileExists(configOverride)) {
      return { bin: configOverride, prefixArgs: [] };
    }
    throw new Error(
      `Configured binary path "${configOverride}" does not exist. ` +
      `Verify the path is correct.`
    );
  }

  // Check cache
  const cached = cache.get(name);
  if (cached) return cached;

  // 2. Platform-specific common paths
  const isWin = process.platform === "win32";
  const commonPaths = isWin
    ? getCommonPathsWindows(name)
    : (COMMON_PATHS_UNIX[name] ?? []);

  for (const p of commonPaths) {
    if (await fileExists(p)) {
      if (isWin && p.endsWith(".cmd")) {
        const resolved = await resolveWindowsCmdShim(p);
        if (resolved) {
          cache.set(name, resolved);
          return resolved;
        }
      }
      const result: ResolvedBinary = { bin: p, prefixArgs: [] };
      cache.set(name, result);
      return result;
    }
  }

  // 3. PATH via which/where
  const whichResult = await runWhich(name);
  if (whichResult) {
    if (isWin && whichResult.endsWith(".cmd")) {
      const resolved = await resolveWindowsCmdShim(whichResult);
      if (resolved) {
        cache.set(name, resolved);
        return resolved;
      }
    }
    const result: ResolvedBinary = { bin: whichResult, prefixArgs: [] };
    cache.set(name, result);
    return result;
  }

  const installHints: Record<string, string> = {
    claude: "Install: npm install -g @anthropic-ai/claude-code",
    codex: "Install: npm install -g @openai/codex",
    gemini: "Install: npm install -g @anthropic-ai/claude-code (Gemini CLI)",
    agent: "Install the Cursor CLI agent",
    opencode: "Install: npm install -g opencode-ai",
    pi: "Install: npm install -g @mariozechner/pi-coding-agent",
  };
  throw new Error(
    `Could not find "${name}" binary. Searched common install paths and PATH. ` +
    (installHints[name] ?? `Ensure "${name}" is installed and on your PATH.`)
  );
}

export async function ensureCommandResolvable(command: string): Promise<ResolvedBinary> {
  // If it's a path (contains separator), check existence directly
  if (command.includes(path.sep) || command.includes("/")) {
    if (await fileExists(command)) {
      return { bin: command, prefixArgs: [] };
    }
    throw new Error(`Command not found: "${command}"`);
  }
  // Otherwise treat as a binary name
  return findBinary(command);
}

export function clearBinaryCache(): void {
  cache.clear();
}
