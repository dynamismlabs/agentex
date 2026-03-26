import { useState, useEffect, useCallback } from "react";
import { api } from "../api";
import { Download, Trash2, RefreshCw, Package, CheckCircle, AlertCircle, FolderSymlink, Globe, FolderOpen } from "lucide-react";

interface InstalledSkill {
  name: string;
  sourcePath: string | null;
  isSymlink: boolean;
}

interface AvailableSkill {
  name: string;
  sourcePath: string;
}

interface AvailableResponse {
  skills: AvailableSkill[];
  cwd: string;
}

interface InstallResult {
  installed: number;
  skipped: number;
  conflicts: number;
  errors: number;
}

interface RemoveResult {
  removed: number;
}

type Location = "workspace" | "global";

const WORKSPACE_RUNTIMES = ["claude", "codex", "gemini", "cursor", "opencode", "pi"] as const;
const GLOBAL_RUNTIMES = ["gemini", "cursor", "opencode", "pi"] as const;

const RUNTIME_LABELS: Record<string, string> = {
  claude: "Claude",
  codex: "Codex",
  gemini: "Gemini",
  cursor: "Cursor",
  opencode: "OpenCode",
  pi: "Pi",
};

const WORKSPACE_PATHS: Record<string, string> = {
  claude: ".claude/skills/",
  codex: ".agents/skills/",
  gemini: ".gemini/skills/",
  cursor: ".cursor/skills/",
  opencode: ".claude/skills/",
  pi: ".pi/agent/skills/",
};

const GLOBAL_PATHS: Record<string, string> = {
  gemini: "~/.gemini/skills/",
  cursor: "~/.cursor/skills/",
  opencode: "~/.claude/skills/",
  pi: "~/.pi/agent/skills/",
};

export default function SkillsPanel() {
  const [location, setLocation] = useState<Location>("workspace");
  const [installed, setInstalled] = useState<Record<string, InstalledSkill[]>>({});
  const [availableResp, setAvailableResp] = useState<AvailableResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [lastResult, setLastResult] = useState<{ type: "install" | "remove"; data: InstallResult | RemoveResult } | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [skills, avail] = await Promise.all([
        api<Record<string, InstalledSkill[]>>("GET", `/api/skills?location=${location}`),
        api<AvailableResponse>("GET", "/api/skills/available"),
      ]);
      setInstalled(skills);
      setAvailableResp(avail);
    } catch {
      // ignore
    }
    setLoading(false);
  }, [location]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  async function handleInstall() {
    setActionLoading("install");
    setLastResult(null);
    try {
      const result = await api<InstallResult>("POST", "/api/skills/install", { location });
      setLastResult({ type: "install", data: result });
      await refresh();
    } catch {
      // ignore
    }
    setActionLoading(null);
  }

  async function handleRemove() {
    setActionLoading("remove");
    setLastResult(null);
    try {
      const result = await api<RemoveResult>("POST", "/api/skills/remove", { location });
      setLastResult({ type: "remove", data: result });
      await refresh();
    } catch {
      // ignore
    }
    setActionLoading(null);
  }

  const runtimes = location === "workspace" ? WORKSPACE_RUNTIMES : GLOBAL_RUNTIMES;
  const pathMap = location === "workspace" ? WORKSPACE_PATHS : GLOBAL_PATHS;

  const totalInstalled = Object.values(installed).reduce(
    (sum, skills) => sum + skills.length,
    0,
  );

  return (
    <div className="p-6 max-w-3xl mx-auto">
      {/* Header */}
      <div className="flex items-center gap-3 mb-6">
        <div className="p-2 bg-primary/10 text-primary rounded-xl">
          <Package size={22} />
        </div>
        <div>
          <h2 className="text-lg font-semibold text-text-primary">Skills Management</h2>
          <p className="text-sm text-text-tertiary">
            Install and manage agent skills across runtimes
          </p>
        </div>
      </div>

      {/* Location toggle */}
      <div className="flex items-center gap-3 mb-6">
        <div className="flex bg-background p-1 rounded-lg border border-border">
          <button
            className={`flex items-center gap-2 px-3.5 py-1.5 rounded-md text-sm font-medium transition-all duration-200 ${
              location === "workspace"
                ? "bg-surface text-text-primary shadow-sm"
                : "text-text-secondary hover:text-text-primary hover:bg-surface/50"
            }`}
            onClick={() => { setLocation("workspace"); setLastResult(null); }}
          >
            <FolderOpen size={14} className={location === "workspace" ? "text-primary" : ""} />
            Workspace
          </button>
          <button
            className={`flex items-center gap-2 px-3.5 py-1.5 rounded-md text-sm font-medium transition-all duration-200 ${
              location === "global"
                ? "bg-surface text-text-primary shadow-sm"
                : "text-text-secondary hover:text-text-primary hover:bg-surface/50"
            }`}
            onClick={() => { setLocation("global"); setLastResult(null); }}
          >
            <Globe size={14} className={location === "global" ? "text-primary" : ""} />
            Global
          </button>
        </div>
        <span className="text-xs text-text-tertiary font-mono truncate">
          {location === "workspace" ? availableResp?.cwd ?? "" : "~/"}
        </span>
      </div>

      {/* Action buttons */}
      <div className="flex gap-3 mb-6">
        <button
          className="flex items-center gap-2 px-4 py-2.5 bg-primary hover:bg-primary-hover text-black rounded-xl text-sm font-medium shadow-sm transition-colors disabled:opacity-50"
          onClick={handleInstall}
          disabled={actionLoading !== null}
        >
          {actionLoading === "install" ? (
            <RefreshCw size={16} className="animate-spin" />
          ) : (
            <Download size={16} />
          )}
          Install Skills
        </button>
        <button
          className="flex items-center gap-2 px-4 py-2.5 bg-surface border border-border hover:bg-surface-hover text-text-primary rounded-xl text-sm font-medium transition-colors disabled:opacity-50"
          onClick={handleRemove}
          disabled={actionLoading !== null}
        >
          {actionLoading === "remove" ? (
            <RefreshCw size={16} className="animate-spin" />
          ) : (
            <Trash2 size={16} />
          )}
          Remove Skills
        </button>
        <button
          className="flex items-center gap-2 px-3 py-2.5 bg-surface border border-border hover:bg-surface-hover text-text-secondary rounded-xl text-sm transition-colors"
          onClick={refresh}
          title="Refresh"
        >
          <RefreshCw size={16} />
        </button>
      </div>

      {/* Result banner */}
      {lastResult && (
        <div
          className={`flex items-center gap-2 px-4 py-3 rounded-xl mb-6 text-sm font-medium ${
            lastResult.type === "install"
              ? "bg-emerald-500/10 text-emerald-400 border border-emerald-500/20"
              : "bg-amber-500/10 text-amber-400 border border-amber-500/20"
          }`}
        >
          {lastResult.type === "install" ? (
            <CheckCircle size={16} />
          ) : (
            <AlertCircle size={16} />
          )}
          {lastResult.type === "install"
            ? (() => {
                const d = lastResult.data as InstallResult;
                const parts: string[] = [];
                if (d.installed > 0) parts.push(`${d.installed} installed`);
                if (d.skipped > 0) parts.push(`${d.skipped} skipped`);
                if (d.conflicts > 0) parts.push(`${d.conflicts} conflicts`);
                if (d.errors > 0) parts.push(`${d.errors} errors`);
                return parts.join(", ") || "No changes";
              })()
            : `${(lastResult.data as RemoveResult).removed} removed`}
        </div>
      )}

      {/* Available skills */}
      <div className="mb-8">
        <h3 className="text-sm font-semibold text-text-secondary uppercase tracking-wider mb-3">
          Available Skills ({availableResp?.skills.length ?? 0})
        </h3>
        <div className="grid gap-2">
          {(availableResp?.skills ?? []).map((skill) => (
            <div
              key={skill.name}
              className="flex items-center gap-3 px-4 py-3 bg-surface border border-border rounded-xl"
            >
              <div className="p-1.5 bg-primary/10 text-primary rounded-lg">
                <Package size={14} />
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium text-text-primary">{skill.name}</div>
                <div className="text-xs text-text-tertiary font-mono truncate">
                  {skill.sourcePath}
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Installed per runtime */}
      <div>
        <h3 className="text-sm font-semibold text-text-secondary uppercase tracking-wider mb-3">
          Installed Per Runtime ({totalInstalled} total)
        </h3>

        {loading ? (
          <div className="flex items-center gap-2 text-text-tertiary text-sm py-4">
            <RefreshCw size={14} className="animate-spin" />
            Loading...
          </div>
        ) : (
          <div className="grid gap-4">
            {runtimes.map((runtime) => {
              const skills = installed[runtime] ?? [];
              const runtimePath = pathMap[runtime] ?? "";
              return (
                <div
                  key={runtime}
                  className="bg-surface border border-border rounded-xl overflow-hidden"
                >
                  <div className="flex items-center justify-between px-4 py-3 border-b border-border bg-surface-hover/30">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-semibold text-text-primary">
                        {RUNTIME_LABELS[runtime]}
                      </span>
                      <span className="text-xs text-text-tertiary font-mono">
                        {runtimePath}
                      </span>
                    </div>
                    <span
                      className={`text-xs font-medium px-2 py-0.5 rounded-full ${
                        skills.length > 0
                          ? "bg-emerald-500/10 text-emerald-400"
                          : "bg-zinc-500/10 text-text-tertiary"
                      }`}
                    >
                      {skills.length} skill{skills.length !== 1 ? "s" : ""}
                    </span>
                  </div>

                  {skills.length === 0 ? (
                    <div className="px-4 py-3 text-sm text-text-tertiary">
                      No skills installed
                    </div>
                  ) : (
                    <div className="divide-y divide-border">
                      {skills.map((skill) => (
                        <div
                          key={skill.name}
                          className="flex items-center gap-3 px-4 py-2.5"
                        >
                          <FolderSymlink
                            size={14}
                            className={
                              skill.isSymlink ? "text-primary" : "text-text-tertiary"
                            }
                          />
                          <span className="text-sm text-text-primary font-medium">
                            {skill.name}
                          </span>
                          {skill.isSymlink && (
                            <span className="text-xs text-text-tertiary font-mono truncate">
                              {skill.sourcePath}
                            </span>
                          )}
                          {skill.isSymlink ? (
                            <span className="ml-auto text-xs text-primary/70">symlink</span>
                          ) : (
                            <span className="ml-auto text-xs text-text-tertiary">directory</span>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
