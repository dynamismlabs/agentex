import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { Plus, X, TerminalSquare } from "lucide-react";
import { useApp } from "../AppContext";

interface TerminalTab {
  id: string;
  label: string;
  cwd?: string;
  command?: string[];
}

let nextId = 1;

export default function TerminalPanel() {
  const { pendingTerminalTab, clearPendingTerminalTab } = useApp();
  const [tabs, setTabs] = useState<TerminalTab[]>([
    { id: `term_${nextId++}`, label: "Terminal 1" },
  ]);
  const [activeId, setActiveId] = useState(tabs[0]!.id);

  // Consume pending terminal tab requests from other components
  useEffect(() => {
    if (!pendingTerminalTab) return;
    const id = `term_${nextId++}`;
    const tab: TerminalTab = {
      id,
      label: pendingTerminalTab.label,
      cwd: pendingTerminalTab.cwd,
      command: pendingTerminalTab.command,
    };
    setTabs((prev) => [...prev, tab]);
    setActiveId(id);
    clearPendingTerminalTab();
  }, [pendingTerminalTab, clearPendingTerminalTab]);

  function addTab() {
    const id = `term_${nextId++}`;
    const tab: TerminalTab = { id, label: `Terminal ${nextId - 1}` };
    setTabs((prev) => [...prev, tab]);
    setActiveId(id);
  }

  function closeTab(id: string) {
    setTabs((prev) => {
      const next = prev.filter((t) => t.id !== id);
      if (next.length === 0) {
        const fresh: TerminalTab = { id: `term_${nextId++}`, label: `Terminal ${nextId - 1}` };
        next.push(fresh);
      }
      if (activeId === id) {
        setActiveId(next[next.length - 1]!.id);
      }
      return next;
    });
  }

  return (
    <div className="flex flex-col h-full bg-background">
      {/* Tab bar */}
      <div className="flex items-center border-b border-border bg-surface shrink-0">
        <div className="flex-1 flex items-center overflow-x-auto hide-scrollbar">
          {tabs.map((tab) => (
            <div
              key={tab.id}
              className={`group flex items-center gap-1.5 px-3 py-2 text-xs font-medium border-r border-border cursor-pointer transition-colors ${
                activeId === tab.id
                  ? "bg-background text-text-primary"
                  : "text-text-tertiary hover:text-text-secondary hover:bg-surface-hover"
              }`}
              onClick={() => setActiveId(tab.id)}
            >
              <TerminalSquare size={12} />
              <span>{tab.label}</span>
              <button
                className="ml-1 p-0.5 rounded opacity-0 group-hover:opacity-100 hover:bg-surface-hover transition-all"
                onClick={(e) => {
                  e.stopPropagation();
                  closeTab(tab.id);
                }}
              >
                <X size={10} />
              </button>
            </div>
          ))}
        </div>
        <button
          className="p-2 text-text-tertiary hover:text-text-secondary hover:bg-surface-hover transition-colors shrink-0"
          onClick={addTab}
          title="New terminal"
        >
          <Plus size={14} />
        </button>
      </div>

      {/* Terminal instances */}
      <div className="flex-1 relative min-h-0">
        {tabs.map((tab) => (
          <div
            key={tab.id}
            className="absolute inset-0"
            style={{ visibility: activeId === tab.id ? "visible" : "hidden" }}
          >
            <TerminalInstance id={tab.id} cwd={tab.cwd} command={tab.command} />
          </div>
        ))}
      </div>
    </div>
  );
}

function TerminalInstance({ id, cwd, command }: { id: string; cwd?: string; command?: string[] }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const [status, setStatus] = useState<"connecting" | "connected" | "disconnected">("connecting");

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const term = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: "'SF Mono', 'Fira Code', 'Cascadia Code', Menlo, monospace",
      theme: {
        background: "#09090b",
        foreground: "#e4e4e7",
        cursor: "#22d3ee",
        selectionBackground: "#27272a",
        black: "#09090b",
        red: "#ef4444",
        green: "#22c55e",
        yellow: "#eab308",
        blue: "#3b82f6",
        magenta: "#a855f7",
        cyan: "#22d3ee",
        white: "#e4e4e7",
        brightBlack: "#52525b",
        brightRed: "#f87171",
        brightGreen: "#4ade80",
        brightYellow: "#facc15",
        brightBlue: "#60a5fa",
        brightMagenta: "#c084fc",
        brightCyan: "#67e8f9",
        brightWhite: "#fafafa",
      },
    });

    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(container);

    // Small delay to let the DOM settle before fitting
    requestAnimationFrame(() => fit.fit());

    termRef.current = term;
    fitRef.current = fit;

    // Connect WebSocket
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const params = new URLSearchParams({ id, cols: String(term.cols), rows: String(term.rows) });
    if (cwd) params.set("cwd", cwd);
    if (command) params.set("command", JSON.stringify(command));
    const ws = new WebSocket(`${protocol}//${location.host}/ws/terminal?${params}`);
    wsRef.current = ws;

    ws.onopen = () => setStatus("connected");

    ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        switch (msg.type) {
          case "output":
            term.write(msg.data);
            break;
          case "exit":
            term.write(`\r\n\x1b[90m[Process exited with code ${msg.exitCode}]\x1b[0m\r\n`);
            setStatus("disconnected");
            break;
          case "ready":
            break;
        }
      } catch {
        // ignore
      }
    };

    ws.onclose = () => setStatus("disconnected");
    ws.onerror = () => setStatus("disconnected");

    // Browser → PTY
    term.onData((data) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "input", data }));
      }
    });

    // Handle resize
    const ro = new ResizeObserver(() => {
      fit.fit();
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
      }
    });
    ro.observe(container);

    return () => {
      ro.disconnect();
      ws.close();
      term.dispose();
      termRef.current = null;
      wsRef.current = null;
      fitRef.current = null;
    };
  }, [id, cwd, command]);

  return (
    <div className="h-full flex flex-col">
      {status === "disconnected" && (
        <div className="px-3 py-1.5 text-xs text-text-tertiary bg-surface border-b border-border flex items-center gap-2">
          <span className="w-2 h-2 rounded-full bg-red-500" />
          Disconnected
        </div>
      )}
      <div ref={containerRef} className="flex-1 min-h-0 p-1" />
    </div>
  );
}
