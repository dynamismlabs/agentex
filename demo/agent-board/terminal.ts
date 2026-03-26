// ---------------------------------------------------------------------------
// Agent Board – Terminal PTY server (WebSocket + node-pty)
// ---------------------------------------------------------------------------

import type { Server as HTTPServer } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import * as pty from "node-pty";

const DEFAULT_SHELL = process.env.SHELL || (process.platform === "win32" ? "powershell.exe" : "bash");

interface TerminalSession {
  pty: pty.IPty;
  ws: WebSocket;
}

const sessions = new Map<string, TerminalSession>();

export function setupTerminalWs(server: HTTPServer): void {
  const wss = new WebSocketServer({ server, path: "/ws/terminal" });

  wss.on("connection", (ws, req) => {
    const url = new URL(req.url || "/", `http://${req.headers.host}`);
    const id = url.searchParams.get("id") || `term_${Date.now()}`;
    const cwd = url.searchParams.get("cwd") || process.cwd();
    const cols = parseInt(url.searchParams.get("cols") || "120", 10);
    const rows = parseInt(url.searchParams.get("rows") || "30", 10);

    // Kill existing session with same id
    const existing = sessions.get(id);
    if (existing) {
      existing.pty.kill();
      sessions.delete(id);
    }

    // Optional custom command (JSON array, e.g. ["claude","--resume","abc123"])
    let spawnCmd = DEFAULT_SHELL;
    let spawnArgs: string[] = [];
    const commandParam = url.searchParams.get("command");
    if (commandParam) {
      try {
        const parsed = JSON.parse(commandParam) as string[];
        if (Array.isArray(parsed) && parsed.length > 0) {
          spawnCmd = parsed[0]!;
          spawnArgs = parsed.slice(1);
        }
      } catch {
        // Fall back to default shell
      }
    }

    let term: pty.IPty;
    try {
      term = pty.spawn(spawnCmd, spawnArgs, {
        name: "xterm-256color",
        cols,
        rows,
        cwd,
        env: process.env as Record<string, string>,
      });
    } catch (err) {
      console.error("Failed to spawn PTY:", err);
      ws.send(JSON.stringify({ type: "error", message: "Failed to spawn terminal" }));
      ws.close();
      return;
    }

    sessions.set(id, { pty: term, ws });

    // PTY → browser
    term.onData((data) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "output", data }));
      }
    });

    term.onExit(({ exitCode }) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "exit", exitCode }));
      }
      sessions.delete(id);
    });

    // Browser → PTY
    ws.on("message", (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        switch (msg.type) {
          case "input":
            term.write(msg.data);
            break;
          case "resize":
            if (msg.cols && msg.rows) {
              term.resize(msg.cols, msg.rows);
            }
            break;
        }
      } catch {
        // Ignore malformed messages
      }
    });

    ws.on("close", () => {
      term.kill();
      sessions.delete(id);
    });

    // Send ready signal
    ws.send(JSON.stringify({ type: "ready", id }));
  });
}
