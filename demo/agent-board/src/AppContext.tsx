import {
  createContext,
  useContext,
  useState,
  useEffect,
  useRef,
  useCallback,
  type ReactNode,
} from "react";
import type { AppState } from "../types";
import { api } from "./api";

const DEFAULT_STATE: AppState = {
  agents: [],
  tasks: [],
  goals: [],
  areas: [],
  decisions: [],
  notes: [],
  notifications: [],
  activity: [],
  settings: {
    heartbeatEnabled: false,
    heartbeatMode: "auto",
    heartbeatIntervalSec: 30,
    model: "claude-sonnet-4-6",
    maxTurns: 10,
    timeoutSec: 300,
    editorCommand: "code",
    executionMode: "execute",
  },
};

type ConsoleListener = (agentId: string, event: unknown) => void;

export interface TerminalTabRequest {
  label: string;
  cwd?: string;
  command?: string[];
}

interface AppContextType {
  state: AppState;
  setState: React.Dispatch<React.SetStateAction<AppState>>;
  activeTab: string;
  setActiveTab: (tab: string) => void;
  activeView: string;
  setActiveView: (view: string) => void;
  activeAgentId: string;
  setActiveAgentId: (id: string) => void;
  settingsOpen: boolean;
  setSettingsOpen: (open: boolean) => void;
  addTaskOpen: boolean;
  setAddTaskOpen: (open: boolean) => void;
  selectedTaskId: string | null;
  setSelectedTaskId: (id: string | null) => void;
  refreshState: () => Promise<void>;
  subscribeConsole: (fn: ConsoleListener) => () => void;
  getConsoleBuffer: (agentId: string) => unknown[];
  initConsoleBuffer: (agentId: string, events: unknown[]) => void;
  openTerminalTab: (req: TerminalTabRequest) => void;
  pendingTerminalTab: TerminalTabRequest | null;
  clearPendingTerminalTab: () => void;
}

const AppContext = createContext<AppContextType | null>(null);

export function useApp() {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error("useApp must be within AppProvider");
  return ctx;
}

export function AppProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AppState>(DEFAULT_STATE);
  const [activeTab, setActiveTab] = useState("tasks");
  const [activeView, setActiveView] = useState("list");
  const [activeAgentId, setActiveAgentId] = useState("agent-1");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [addTaskOpen, setAddTaskOpen] = useState(false);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [pendingTerminalTab, setPendingTerminalTab] = useState<TerminalTabRequest | null>(null);

  const openTerminalTab = useCallback((req: TerminalTabRequest) => {
    setPendingTerminalTab(req);
    setActiveTab("terminal");
  }, []);

  const clearPendingTerminalTab = useCallback(() => {
    setPendingTerminalTab(null);
  }, []);

  // Console buffers – kept outside React state for performance
  const consoleBuffers = useRef<Record<string, unknown[]>>({});
  const consoleListeners = useRef(new Set<ConsoleListener>());

  const subscribeConsole = useCallback((fn: ConsoleListener) => {
    consoleListeners.current.add(fn);
    return () => {
      consoleListeners.current.delete(fn);
    };
  }, []);

  const getConsoleBuffer = useCallback((agentId: string) => {
    return consoleBuffers.current[agentId] || [];
  }, []);

  const initConsoleBuffer = useCallback((agentId: string, events: unknown[]) => {
    consoleBuffers.current[agentId] = events;
  }, []);

  const appendConsoleEvent = useCallback((agentId: string, event: unknown) => {
    const buf = consoleBuffers.current[agentId] || [];
    buf.push(event);
    if (buf.length > 500) buf.shift();
    consoleBuffers.current[agentId] = buf;
    consoleListeners.current.forEach((fn) => fn(agentId, event));
  }, []);

  const refreshState = useCallback(async () => {
    const data = await api<AppState>("GET", "/api/state");
    setState(data);
  }, []);

  // Initial load + SSE connection
  useEffect(() => {
    let es: EventSource;
    let retryTimeout: number;

    function connect() {
      es = new EventSource("/api/events");
      es.onmessage = (e) => {
        const msg = JSON.parse(e.data);
        switch (msg.type) {
          case "state_sync":
            setState(msg.data);
            break;
          case "agent_output":
            appendConsoleEvent(msg.agentId, msg.event);
            break;
          case "agent_status":
            setState((prev) => ({
              ...prev,
              agents: prev.agents.map((a) =>
                a.id === msg.agentId
                  ? {
                      ...a,
                      status: msg.status,
                      currentTaskId: msg.taskId,
                      lastActiveAt:
                        msg.status === "working"
                          ? new Date().toISOString()
                          : a.lastActiveAt,
                      ...(msg.sessionParams !== undefined ? { sessionParams: msg.sessionParams } : {}),
                    }
                  : a,
              ),
            }));
            break;
          case "task_update":
            setState((prev) => {
              const idx = prev.tasks.findIndex(
                (t) => t.id === msg.task.id,
              );
              const tasks = [...prev.tasks];
              if (idx >= 0) tasks[idx] = msg.task;
              else tasks.push(msg.task);
              return { ...prev, tasks };
            });
            break;
          case "notification":
            setState((prev) => ({
              ...prev,
              notifications: [msg.data, ...prev.notifications],
            }));
            break;
        }
      };
      es.onerror = () => {
        es.close();
        retryTimeout = window.setTimeout(connect, 3000);
      };
    }

    refreshState();
    connect();

    return () => {
      es?.close();
      clearTimeout(retryTimeout);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <AppContext.Provider
      value={{
        state,
        setState,
        activeTab,
        setActiveTab,
        activeView,
        setActiveView,
        activeAgentId,
        setActiveAgentId,
        settingsOpen,
        setSettingsOpen,
        addTaskOpen,
        setAddTaskOpen,
        selectedTaskId,
        setSelectedTaskId,
        refreshState,
        subscribeConsole,
        getConsoleBuffer,
        initConsoleBuffer,
        openTerminalTab,
        pendingTerminalTab,
        clearPendingTerminalTab,
      }}
    >
      {children}
    </AppContext.Provider>
  );
}
