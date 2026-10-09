import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { record } from "../utils/jsonl-lines.js";

export class NativeTelemetryError extends Error {
  constructor(readonly kind: "unsupported" | "timeout" | "aborted" | "closed", message: string) { super(message); }
}

/** Short-lived, non-inference control transport for explicit probes and capacity reads. */
export class NativeTelemetryRpc {
  private readonly proc: ChildProcess;
  private pending = new Map<string | number, { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void }>();
  private buffer = "";
  private ended = false;
  private closePromise?: Promise<void>;
  private readonly onAbort = () => {
    this.end(new NativeTelemetryError("aborted", "Native telemetry read cancelled"));
    void this.close();
  };
  constructor(command: string, args: string[], cwd: string, env: Record<string, string>, private readonly protocol: "codex" | "claude", private readonly signal?: AbortSignal) {
    if (signal?.aborted) throw new NativeTelemetryError("aborted", "Native telemetry read cancelled");
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
          if (error !== undefined) {
            // Never forward native errors, which can include auth details.
            const unsupported = record(response.error)?.code === -32601 || (typeof error === "string"
              && /method.*not found|unknown (?:request|subtype|method)|unsupported|not supported|unrecognized/i.test(error));
            pending.reject(new NativeTelemetryError(unsupported ? "unsupported" : "closed", unsupported ? "Native telemetry request is unsupported" : "Native telemetry request failed"));
          }
          else pending.resolve(record(this.protocol === "codex" ? response.result : response.response) ?? {});
        } catch { /* Non-JSON/noise is not telemetry. */ }
      }
    });
    this.proc.once("error", () => this.end());
    this.proc.once("exit", () => this.end());
    signal?.addEventListener("abort", this.onAbort, { once: true });
    if (signal?.aborted) this.onAbort();
  }
  request(method: string, params: Record<string, unknown> = {}, timeoutMs = 10_000): Promise<Record<string, unknown>> {
    if (this.ended) return Promise.reject(new NativeTelemetryError("closed", "Native telemetry transport closed"));
    const id = this.protocol === "codex" ? ++this.sequence : randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id); reject(new NativeTelemetryError("timeout", "Native telemetry request timed out"));
      }, timeoutMs);
      timer.unref();
      this.pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
      const payload = this.protocol === "codex" ? { id, method, params }
        : { type: "control_request", request_id: id, request: { subtype: method, ...params } };
      const failWrite = (error?: Error | null) => {
        if (!error) return;
        this.pending.get(id)?.reject(new NativeTelemetryError("closed", "Native telemetry transport write failed")); this.pending.delete(id);
      };
      try { this.proc.stdin!.write(JSON.stringify(payload) + "\n", failWrite); }
      catch { failWrite(new Error("write failed")); }
    });
  }
  private sequence = 0;
  private end(error = new NativeTelemetryError("closed", "Native telemetry transport closed")): void {
    this.ended = true;
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.signal?.removeEventListener("abort", this.onAbort);
    this.end();
    if (this.proc.exitCode !== null || this.proc.signalCode !== null) return this.closePromise = Promise.resolve();
    return this.closePromise = new Promise<void>((resolve) => {
      let killWait: ReturnType<typeof setTimeout> | undefined;
      const timer = setTimeout(() => { this.proc.kill("SIGKILL"); killWait = setTimeout(resolve, 1000); killWait.unref(); }, 1000);
      timer.unref();
      this.proc.once("exit", () => { clearTimeout(timer); clearTimeout(killWait); resolve(); });
      this.proc.stdin!.end();
      this.proc.kill("SIGTERM");
    });
  }
}
