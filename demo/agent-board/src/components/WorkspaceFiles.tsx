import { useState, useRef, useEffect } from "react";
import ReactMarkdown from "react-markdown";
import { api } from "../api";
import {
  FolderOpen,
  FileText,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  Eye,
  Code,
  GitCompareArrows,
  Folder,
  Copy,
  Check,
  RefreshCw,
} from "lucide-react";

type ViewMode = "file" | "diff";

export default function WorkspaceFiles({
  taskId,
  defaultOpen = false,
}: {
  taskId: string;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const [files, setFiles] = useState<{ path: string; size: number }[] | null>(
    null,
  );
  const [rootPath, setRootPath] = useState<string>("");
  const [activeFile, setActiveFile] = useState<string | null>(null);
  const [content, setContent] = useState<string>("");
  const [loadingContent, setLoadingContent] = useState(false);
  const [previewMode, setPreviewMode] = useState(false);
  const [viewMode, setViewMode] = useState<ViewMode>("file");
  const [diff, setDiff] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const fileCache = useRef<Record<string, string>>({});

  function fetchFiles() {
    setFiles(null);
    setDiff(null);
    fileCache.current = {};
    api<{ root: string; files: { path: string; size: number }[] }>(
      "GET",
      `/api/tasks/${taskId}/files`,
    ).then((res) => {
      setRootPath(res.root);
      setFiles(res.files);
      if (res.files.length > 0) loadFile(res.files[0].path);
      else setActiveFile(null);
    });
  }

  useEffect(() => {
    if (!open) return;
    fetchFiles();
  }, [open, taskId]);

  function copyPath(filePath: string) {
    const abs = rootPath ? `${rootPath}/${filePath}` : filePath;
    navigator.clipboard.writeText(abs);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  async function loadFile(filePath: string) {
    setActiveFile(filePath);
    setPreviewMode(false);
    setViewMode("file");
    if (fileCache.current[filePath]) {
      setContent(fileCache.current[filePath]);
      return;
    }
    setLoadingContent(true);
    const res = await api<{ content: string }>(
      "GET",
      `/api/tasks/${taskId}/files/${filePath}`,
    );
    const c = res.content ?? "";
    fileCache.current[filePath] = c;
    setContent(c);
    setLoadingContent(false);
  }

  async function toggleDiff() {
    if (viewMode === "diff") {
      setViewMode("file");
      return;
    }
    setViewMode("diff");
    if (diff !== null) return;
    const res = await api<{ diff: string }>(
      "GET",
      `/api/tasks/${taskId}/diff`,
    );
    setDiff(res.diff ?? "");
  }

  async function openInEditor() {
    await api("POST", `/api/tasks/${taskId}/open-editor`);
  }

  async function openInFinder() {
    await api("POST", `/api/tasks/${taskId}/open-finder`);
  }

  const isMarkdown =
    activeFile?.endsWith(".md") || activeFile?.endsWith(".mdx");

  return (
    <div className={defaultOpen ? "" : "mt-3"}>
      {!defaultOpen && (
        <button
          className="flex items-center gap-2 text-xs text-text-secondary hover:text-text-primary transition-colors"
          onClick={() => setOpen((o) => !o)}
        >
          {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          <FolderOpen size={14} />
          <span className="font-medium">Workspace Files</span>
          {files && files.length > 0 && (
            <span className="text-text-tertiary">({files.length})</span>
          )}
        </button>
      )}

      {open && (
        <div
          className={`border border-border rounded-lg overflow-hidden ${defaultOpen ? "" : "mt-2"}`}
        >
          {files === null ? (
            <div className="px-3 py-2 text-xs text-text-tertiary">
              Loading...
            </div>
          ) : files.length === 0 ? (
            <div className="px-3 py-2 text-xs text-text-tertiary">
              No files in workspace
            </div>
          ) : (
            <>
              {/* Toolbar: file tabs + actions */}
              <div className="flex items-center border-b border-border bg-background/50">
                <div className="flex-1 flex items-center overflow-x-auto hide-scrollbar">
                  {files.map((f) => (
                    <button
                      key={f.path}
                      className={`flex items-center gap-1.5 px-3 py-2 text-xs font-mono whitespace-nowrap border-r border-border transition-colors ${
                        viewMode === "file" && activeFile === f.path
                          ? "bg-surface text-text-primary"
                          : "text-text-tertiary hover:text-text-secondary hover:bg-surface-hover"
                      }`}
                      onClick={() => loadFile(f.path)}
                    >
                      <FileText size={12} className="shrink-0" />
                      {f.path}
                    </button>
                  ))}
                </div>
                <div className="flex items-center gap-1 px-2 shrink-0 border-l border-border">
                  <button
                    className={`p-1.5 rounded transition-colors ${viewMode === "diff" ? "text-primary bg-primary/10" : "text-text-tertiary hover:text-text-secondary"}`}
                    onClick={toggleDiff}
                    title="Show diff"
                  >
                    <GitCompareArrows size={14} />
                  </button>
                  {viewMode === "file" && isMarkdown && (
                    <button
                      className={`p-1.5 rounded transition-colors ${previewMode ? "text-primary bg-primary/10" : "text-text-tertiary hover:text-text-secondary"}`}
                      onClick={() => setPreviewMode((p) => !p)}
                      title={previewMode ? "Show raw" : "Preview markdown"}
                    >
                      {previewMode ? <Code size={14} /> : <Eye size={14} />}
                    </button>
                  )}
                  <button
                    className="p-1.5 text-text-tertiary hover:text-text-secondary rounded transition-colors"
                    onClick={openInFinder}
                    title="Reveal in Finder"
                  >
                    <Folder size={14} />
                  </button>
                  {viewMode === "file" && activeFile && (
                    <button
                      className={`p-1.5 rounded transition-colors ${copied ? "text-emerald-400" : "text-text-tertiary hover:text-text-secondary"}`}
                      onClick={() => copyPath(activeFile)}
                      title="Copy file path"
                    >
                      {copied ? <Check size={14} /> : <Copy size={14} />}
                    </button>
                  )}
                  <button
                    className="p-1.5 text-text-tertiary hover:text-text-secondary rounded transition-colors"
                    onClick={() => fetchFiles()}
                    title="Refresh files"
                  >
                    <RefreshCw size={14} />
                  </button>
                  <button
                    className="p-1.5 text-text-tertiary hover:text-text-secondary rounded transition-colors"
                    onClick={openInEditor}
                    title="Open in editor"
                  >
                    <ExternalLink size={14} />
                  </button>
                </div>
              </div>

              {/* Content area */}
              <div className="bg-[#0a0a0c] max-h-[400px] overflow-auto">
                {viewMode === "diff" ? (
                  diff === null ? (
                    <div className="px-3 py-2 text-xs text-text-tertiary">
                      Loading diff...
                    </div>
                  ) : diff === "" ? (
                    <div className="px-3 py-4 text-xs text-text-tertiary text-center">
                      No changes — all files are new
                    </div>
                  ) : (
                    <DiffView diff={diff} />
                  )
                ) : loadingContent ? (
                  <div className="px-3 py-2 text-xs text-text-tertiary">
                    Loading...
                  </div>
                ) : previewMode && isMarkdown ? (
                  <div className="p-4 prose prose-invert prose-zinc prose-sm max-w-none">
                    <ReactMarkdown>{content}</ReactMarkdown>
                  </div>
                ) : (
                  <pre className="p-3 text-xs font-mono text-text-secondary overflow-x-auto leading-relaxed whitespace-pre-wrap">
                    {content}
                  </pre>
                )}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function DiffView({ diff }: { diff: string }) {
  const lines = diff.split("\n");
  return (
    <pre className="p-3 text-xs font-mono leading-relaxed whitespace-pre-wrap">
      {lines.map((line, i) => {
        let cls = "text-text-secondary";
        if (line.startsWith("+++") || line.startsWith("---")) {
          cls = "text-text-tertiary font-semibold";
        } else if (line.startsWith("@@")) {
          cls = "text-purple-400";
        } else if (line.startsWith("+")) {
          cls = "text-emerald-400 bg-emerald-400/10";
        } else if (line.startsWith("-")) {
          cls = "text-red-400 bg-red-400/10";
        } else if (line.startsWith("diff ")) {
          cls = "text-primary font-semibold border-t border-border pt-2 mt-2";
        }
        return (
          <div key={i} className={cls}>
            {line}
          </div>
        );
      })}
    </pre>
  );
}
