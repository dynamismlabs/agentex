/** Explicit opt-in smoke check: native account controls only, never inference. */
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { getProvider } from "../src/registry.js";

if (!process.argv.includes("--live")) throw new Error("Pass --live to read native provider rate limits without inference");
const selected = process.argv.includes("--claude") ? ["claude"] : process.argv.includes("--codex") ? ["codex"] : ["claude", "codex"];
const cwd = await mkdtemp(join(tmpdir(), "agentex-sessionless-smoke-"));
const claudeHome = resolve(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"));
const codexHome = resolve(process.env.CODEX_HOME ?? join(homedir(), ".codex"));
// Capture history/session artifacts only. Native debug logs or account caches
// are not conversations; no credential/config contents are read or printed.
const roots = [join(claudeHome, "projects"), join(claudeHome, "sessions"), join(claudeHome, "transcripts"),
  join(codexHome, "sessions"), join(codexHome, "archived_sessions")];
async function artifacts(provider: string) {
  const result = new Map<string, { size: number; mtimeMs: number }>();
  async function walk(path: string) {
    for (const entry of await readdir(path, { withFileTypes: true }).catch(() => [])) {
      const file = join(path, entry.name);
      if (entry.isDirectory()) await walk(file);
      else if (entry.isFile()) { const info = await stat(file); result.set(file, { size: info.size, mtimeMs: info.mtimeMs }); }
    }
  }
  for (const root of provider === "claude" ? roots.slice(0, 3) : roots.slice(3)) await walk(root);
  for (const file of provider === "codex" ? [join(codexHome, "history.jsonl"), join(codexHome, "session_index.jsonl")] : []) {
    try { const info = await stat(file); result.set(file, { size: info.size, mtimeMs: info.mtimeMs }); } catch { /* Not created yet. */ }
  }
  return result;
}
try {
  for (const provider of selected) {
    const before = await artifacts(provider); const started = Date.now();
    const result = await getProvider(provider).readRateLimits!({ cwd, timeoutMs: 30_000,
      env: { ...(process.env.CODEX_HOME ? { CODEX_HOME: codexHome } : {}),
        ...(process.env.CLAUDE_CONFIG_DIR ? { CLAUDE_CONFIG_DIR: claudeHome } : {}) } });
    const after = await artifacts(provider);
    const created = [...after.keys()].filter((path) => !before.has(path));
    const changed = [...before].filter(([path, info]) => { const now = after.get(path); return now && (now.size !== info.size || now.mtimeMs !== info.mtimeMs); });
    console.log(JSON.stringify({ provider, status: result.status, support: result.support, mode: result.value?.mode,
      buckets: result.value?.snapshot.buckets.length, durationMs: Date.now() - started, createdHistoryFiles: created.length, changedHistoryFiles: changed.length,
      ...(result.reason ? { reason: result.reason } : {}) }));
    if (created.length || changed.length) throw new Error("History artifacts changed during the read; rerun with other native sessions idle to distinguish concurrent writes");
    if (!result.value || result.value.mode !== "replace") throw new Error("No native authoritative rate-limit observation; check runtime/auth support");
  }
} finally { await rm(cwd, { recursive: true, force: true }); }
