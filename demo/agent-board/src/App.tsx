import { AppProvider, useApp } from "./AppContext";
import Header from "./components/Header";
import Toolbar from "./components/Toolbar";
import TaskList from "./components/TaskList";
import KanbanBoard from "./components/KanbanBoard";
import NotesPanel from "./components/NotesPanel";
import DecisionsPanel from "./components/DecisionsPanel";
import AgentConsole from "./components/AgentConsole";
import StatusBar from "./components/StatusBar";
import SettingsModal from "./components/SettingsModal";
import AddTaskModal from "./components/AddTaskModal";
import TaskDetailModal from "./components/TaskDetailModal";
import TerminalPanel from "./components/TerminalPanel";

function TasksView() {
  const { activeView } = useApp();
  return activeView === "list" ? <TaskList /> : <KanbanBoard />;
}

function LeftPanel() {
  const { activeTab } = useApp();
  return (
    <div className={`flex-1 border-r border-border min-w-0 bg-background ${activeTab === "terminal" ? "overflow-hidden" : "overflow-y-auto custom-scrollbar"}`}>
      {activeTab === "tasks" ? (
        <TasksView />
      ) : activeTab === "notes" ? (
        <NotesPanel />
      ) : activeTab === "terminal" ? (
        <TerminalPanel />
      ) : (
        <DecisionsPanel />
      )}
    </div>
  );
}

function Layout() {
  return (
    <div className="flex flex-col h-screen bg-background text-text-primary overflow-hidden">
      <Header />
      <Toolbar />
      <div className="flex flex-1 overflow-hidden relative">
        <LeftPanel />
        <AgentConsole />
      </div>
      <StatusBar />
      <SettingsModal />
      <AddTaskModal />
      <TaskDetailModal />
    </div>
  );
}

export default function App() {
  return (
    <AppProvider>
      <Layout />
    </AppProvider>
  );
}
