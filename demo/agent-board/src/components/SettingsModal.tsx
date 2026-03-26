import { useApp } from "../AppContext";
import { api } from "../api";
import { Settings, X } from "lucide-react";

export default function SettingsModal() {
  const { state, setState, settingsOpen, setSettingsOpen } = useApp();
  if (!settingsOpen) return null;

  const s = state.settings;

  async function update(patch: Record<string, unknown>) {
    setState((prev) => ({
      ...prev,
      settings: { ...prev.settings, ...patch },
    }));
    await api("PATCH", "/api/settings", patch);
  }

  return (
    <div
      className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center animate-in fade-in duration-200"
      onClick={(e) => e.target === e.currentTarget && setSettingsOpen(false)}
    >
      <div className="bg-surface border border-border rounded-2xl p-6 w-[440px] max-w-[90vw] shadow-2xl animate-in zoom-in-95 duration-200">
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-2">
            <div className="p-1.5 bg-primary/10 text-primary rounded-lg">
              <Settings size={18} />
            </div>
            <h2 className="text-lg font-semibold text-text-primary">Settings</h2>
          </div>
          <button
            className="p-1.5 text-text-tertiary hover:text-text-primary hover:bg-surface-hover rounded-lg transition-colors"
            onClick={() => setSettingsOpen(false)}
          >
            <X size={18} />
          </button>
        </div>

        <div className="space-y-1">
          <Row label="Heartbeat">
            <button
              className={`w-11 h-6 rounded-full relative cursor-pointer border-none transition-colors duration-300 ${s.heartbeatEnabled ? "bg-primary" : "bg-zinc-700"
                }`}
              onClick={() => update({ heartbeatEnabled: !s.heartbeatEnabled })}
            >
              <span
                className={`absolute top-1 left-1 w-4 h-4 rounded-full bg-white transition-transform duration-300 shadow-sm ${s.heartbeatEnabled ? "translate-x-5" : ""
                  }`}
              />
            </button>
          </Row>

          <Row label="Mode">
            <select
              className="px-3 py-1.5 bg-background border border-border rounded-lg text-sm text-text-primary outline-none focus:border-primary focus:ring-1 focus:ring-primary/50 transition-all"
              value={s.heartbeatMode}
              onChange={(e) => update({ heartbeatMode: e.target.value })}
            >
              <option value="auto">Auto</option>
              <option value="manual">Manual</option>
            </select>
          </Row>

          <Row label="Interval (sec)">
            <input
              type="number"
              className="w-[80px] px-3 py-1.5 bg-background border border-border rounded-lg text-sm text-text-primary outline-none focus:border-primary focus:ring-1 focus:ring-primary/50 transition-all"
              value={s.heartbeatIntervalSec}
              min={5}
              max={300}
              onChange={(e) =>
                update({ heartbeatIntervalSec: +e.target.value })
              }
            />
          </Row>

          <div className="h-px bg-border my-4" />

          <Row label="Model">
            <input
              className="w-[220px] px-3 py-1.5 bg-background border border-border rounded-lg text-sm text-text-primary outline-none focus:border-primary focus:ring-1 focus:ring-primary/50 transition-all"
              value={s.model}
              onChange={(e) => update({ model: e.target.value })}
            />
          </Row>

          <Row label="Max turns">
            <input
              type="number"
              className="w-[80px] px-3 py-1.5 bg-background border border-border rounded-lg text-sm text-text-primary outline-none focus:border-primary focus:ring-1 focus:ring-primary/50 transition-all"
              value={s.maxTurns}
              min={1}
              max={100}
              onChange={(e) => update({ maxTurns: +e.target.value })}
            />
          </Row>

          <Row label="Timeout (sec)">
            <input
              type="number"
              className="w-[80px] px-3 py-1.5 bg-background border border-border rounded-lg text-sm text-text-primary outline-none focus:border-primary focus:ring-1 focus:ring-primary/50 transition-all"
              value={s.timeoutSec}
              min={30}
              max={3600}
              onChange={(e) => update({ timeoutSec: +e.target.value })}
            />
          </Row>

          <div className="h-px bg-border my-4" />

          <Row label="Editor">
            <select
              className="px-3 py-1.5 bg-background border border-border rounded-lg text-sm text-text-primary outline-none focus:border-primary focus:ring-1 focus:ring-primary/50 transition-all"
              value={["code", "cursor", "zed", "subl", "webstorm"].includes(s.editorCommand) ? s.editorCommand : "__custom"}
              onChange={(e) => {
                if (e.target.value !== "__custom") update({ editorCommand: e.target.value });
              }}
            >
              <option value="code">VS Code</option>
              <option value="cursor">Cursor</option>
              <option value="zed">Zed</option>
              <option value="subl">Sublime Text</option>
              <option value="webstorm">WebStorm</option>
              <option value="__custom">Custom</option>
            </select>
          </Row>
          {!["code", "cursor", "zed", "subl", "webstorm"].includes(s.editorCommand) && (
            <Row label="Custom command">
              <input
                className="w-[160px] px-3 py-1.5 bg-background border border-border rounded-lg text-sm text-text-primary outline-none focus:border-primary focus:ring-1 focus:ring-primary/50 transition-all font-mono"
                value={s.editorCommand}
                placeholder="e.g. nvim"
                onChange={(e) => update({ editorCommand: e.target.value })}
              />
            </Row>
          )}
        </div>

        <div className="flex justify-end mt-8">
          <button
            className="px-4 py-2 bg-surface-hover border border-border rounded-lg text-sm font-medium text-text-primary hover:bg-border transition-colors"
            onClick={() => setSettingsOpen(false)}
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
}

function Row({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between py-2.5">
      <span className="text-sm font-medium text-text-secondary">{label}</span>
      {children}
    </div>
  );
}
