import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { record } from "../utils/jsonl-lines.js";

/** Short-lived, non-inference native control transport used only for explicit capability probes. */
export class NativeTelemetryRpc {
  private readonly proc: ChildProcess;
  private pending = new Map<string | number, { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void }>();
  private buffer = "";
  private ended = false;
  constructor(command: string, args: string[], cwd: string, env: Record<string, string>, private readonly protocol: "codex" | "claude") {
    this.proc = spawn(command, args, { cwd, env, stdio: ["pipe", "pipe", "ignore"] });
    this.proc.stdin!.on("error", () => this.end());
    this.proc.stdout!.setEncoding("utf8");
    this.proc.stdout!.on("data", (chunk: string) => {
      this.buffer += chunk;
      const lines = this.buffer.split("\n"); this.buffer = lines.pop() ?? "";
      for (const line of lines) {
        try {
          const native = record(JSON.parse(line));
          if (!native) continue;
          const response = this.protocol === "codex" ? native : record(native.response);
          if (!response) continue;
          const id = this.protocol === "codex" ? response.id : response.request_id;
          if (typeof id !== "string" && typeof id !== "number") continue;
          const pending = this.pending.get(id);
          if (!pending) continue;
          this.pending.delete(id);
          const error = this.protocol === "codex" ? record(response.error)?.message : response.subtype === "error" ? response.error : undefined;
          if (error !== undefined) pending.reject(new Error(typeof error === "string" ? error : "Native telemetry request failed"));
          else pending.resolve(record(this.protocol === "codex" ? response.result : response.response) ?? {});
        } catch { /* Non-JSON/noise is not telemetry. */ }
      }
    });
    this.proc.once("error", () => this.end());
    this.proc.once("exit", () => this.end());
  }
  request(method: string, params: Record<string, unknown> = {}, timeoutMs = 10_000): Promise<Record<string, unknown>> {
    if (this.ended) return Promise.reject(new Error("Native telemetry transport closed"));
    const id = this.protocol === "codex" ? ++this.sequence : randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id); reject(new Error("Native telemetry request timed out"));
      }, timeoutMs);
      timer.unref();
      this.pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
      const payload = this.protocol === "codex" ? { id, method, params }
        : { type: "control_request", request_id: id, request: { subtype: method, ...params } };
      this.proc.stdin!.write(JSON.stringify(payload) + "\n", (error) => {
        if (error) { this.pending.get(id)?.reject(new Error("Native telemetry transport write failed")); this.pending.delete(id); }
      });
    });
  }
  private sequence = 0;
  private end(): void {
    this.ended = true;
    for (const pending of this.pending.values()) pending.reject(new Error("Native telemetry transport closed"));
    this.pending.clear();
  }
  async close(): Promise<void> {
    this.end();
    if (this.proc.exitCode !== null || this.proc.signalCode !== null) return;
    this.proc.stdin!.end();
    this.proc.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => { this.proc.kill("SIGKILL"); resolve(); }, 1000);
      timer.unref();
      this.proc.once("exit", () => { clearTimeout(timer); resolve(); });
    });
  }
}
