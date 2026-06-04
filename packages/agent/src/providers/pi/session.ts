import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import type {
  AgentSession,
  CancelResult,
  SendHandle,
  SendOptions,
  SessionContext,
  SessionState,
  TurnResult,
} from "../../types.js";
import { findBinary } from "../../utils/binary.js";
import { buildEnv, ensurePathInEnv } from "../../utils/env.js";
import { uuidv7 } from "../../utils/uuid.js";
import { resolveInstructions } from "../../utils/instructions.js";
import { injectHomeSkills } from "../../utils/skills.js";
import { parsePiStreamLine } from "./parse.js";
import { piSessionCodec } from "./codec.js";

const PI_SESSIONS_DIR = path.join(os.homedir(), ".pi", "sessions");

function parseProviderModel(model: string | undefined): { provider: string | null; modelId: string | null } {
  const m = (model ?? "").trim();
  if (!m) return { provider: null, modelId: null };
  const idx = m.indexOf("/");
  if (idx < 0) return { provider: null, modelId: m };
  return { provider: m.slice(0, idx).trim() || null, modelId: m.slice(idx + 1).trim() || null };
}

function buildSessionPath(): string {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  return path.join(PI_SESSIONS_DIR, `${ts}-${uuidv7()}.jsonl`);
}

interface PendingTurn {
  resolve: (r: TurnResult) => void;
  settled: boolean;
  cleanup: () => void;
}

/** Create + connect a persistent `pi --mode rpc` session. */
export async function createPiSession(ctx: SessionContext): Promise<AgentSession> {
  const session = new PiSession(ctx);
  await session.connect();
  return session;
}

/** @internal Exported for unit testing — not part of the public API. */
export class PiSession implements AgentSession {
  private _state: SessionState = "idle";
  private proc: ChildProcess | null = null;
  private _sessionPath = "";
  private _lineBuffer = "";

  private _turnActive = false;
  private _turnText = "";
  private _pending: PendingTurn | null = null;
  private _inFlight: Promise<TurnResult> | null = null;
  private _draining = false;
  /** Serial dispatch so onEvent fires in order and a turn resolves after them. */
  private _eventChain: Promise<void> = Promise.resolve();
  /** Decided outcome of an interrupted turn, applied when its `agent_end` acks. */
  private _pendingStatus: TurnResult["status"] | null = null;
  private _pendingMessage: string | null = null;
  /** Force-resolve timer if pi never acks an abort with `agent_end`. */
  private _graceTimer: ReturnType<typeof setTimeout> | null = null;
  /** Count of `agent_end`s to swallow (from turns force-resolved before their ack). */
  private _staleEnds = 0;

  constructor(private readonly ctx: SessionContext) {}

  get sessionId(): string | null {
    return this._sessionPath || null;
  }
  get state(): SessionState {
    return this._state;
  }

  async connect(): Promise<void> {
    const config = this.ctx.config ?? {};
    const resolved = await findBinary("pi", config.command);
    const env = buildEnv(this.ctx.env);
    ensurePathInEnv(env);
    const cwd = this.ctx.cwd ?? process.cwd();

    if (config.instructionsFile) await resolveInstructions(config.instructionsFile);
    let skillsDir: string | null = null;
    if (config.skillDirs && config.skillDirs.length > 0) {
      try {
        skillsDir = await injectHomeSkills(config.skillDirs, "pi");
      } catch {
        /* non-fatal */
      }
    }
    await fs.mkdir(PI_SESSIONS_DIR, { recursive: true });

    // Resume an existing session file, or start a new one. Pi keys sessions by
    // file path; `--session <file>` resumes when the file exists, creates otherwise.
    const decoded = piSessionCodec.deserialize(this.ctx.sessionParams ?? null);
    const resumeId = typeof decoded?.["sessionId"] === "string" ? (decoded["sessionId"] as string) : null;
    this._sessionPath = resumeId || buildSessionPath();

    const { provider, modelId } = parseProviderModel(this.ctx.config?.model);
    const args = [...resolved.prefixArgs, "--mode", "rpc"];
    if (provider) args.push("--provider", provider);
    if (modelId) args.push("--model", modelId);
    if (config.thinking) args.push("--thinking", config.thinking);
    args.push("--tools", "read,bash,edit,write,grep,find,ls");
    args.push("--session", this._sessionPath);
    if (skillsDir) args.push("--skill", skillsDir);
    if (config.instructionsFile) args.push("--append-system-prompt", config.instructionsFile);
    if (config.extraArgs) args.push(...config.extraArgs);

    const proc = spawn(resolved.bin, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    this.proc = proc;

    proc.stdout!.setEncoding("utf-8");
    proc.stdout!.on("data", (chunk: string) => this.onStdout(chunk));
    proc.stderr!.setEncoding("utf-8");
    proc.stderr!.on("data", (chunk: string) => {
      if (this.ctx.onOutput) {
        try {
          void this.ctx.onOutput("stderr", chunk);
        } catch {
          /* swallow */
        }
      }
    });
    proc.on("exit", (code, signal) => {
      if (this._state !== "closed") {
        this._state = "closed";
        this.failPending(`pi process exited (code=${code}, signal=${signal})`);
      }
    });
    proc.on("error", (err) => {
      if (this._state !== "closed") {
        this._state = "closed";
        this.failPending(err instanceof Error ? err.message : String(err));
      }
    });

    if (this.ctx.signal) {
      if (this.ctx.signal.aborted) void this.close();
      else this.ctx.signal.addEventListener("abort", () => void this.close(), { once: true });
    }
  }

  // -------------------------------------------------------------------------
  // stdout → events (strict \n framing per pi's RPC contract)
  // -------------------------------------------------------------------------

  private onStdout(chunk: string): void {
    if (this.ctx.onOutput) {
      try {
        void this.ctx.onOutput("stdout", chunk);
      } catch {
        /* swallow */
      }
    }
    this._lineBuffer += chunk;
    const lines = this._lineBuffer.split("\n");
    this._lineBuffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.replace(/\r$/, "").trim();
      if (trimmed) this.handleLine(trimmed);
    }
  }

  private handleLine(line: string): void {
    // Command acks (`{"type":"response",...}`) aren't agent events — skip.
    let obj: unknown;
    try {
      obj = JSON.parse(line);
    } catch {
      return;
    }
    if (obj && typeof obj === "object" && (obj as Record<string, unknown>)["type"] === "response") return;

    const ev = parsePiStreamLine(line);
    if (!ev) return;

    // `agent_end` (mapped to "result") is a turn terminal. Swallow a stale end
    // from a turn that was already force-resolved (timed out and pi never acked
    // before the grace deadline) so it can't resolve the NEXT turn.
    if (ev.type === "result" && this._staleEnds > 0) {
      this._staleEnds--;
      return;
    }

    // Only accumulate/emit while a turn is active so stragglers from a finished
    // turn don't contaminate the next one's summary or event stream.
    if (!this._turnActive) return;

    if (ev.type === "assistant") this._turnText += ev.text;

    // Emit through the serial chain so handlers run in order.
    if (this.ctx.onEvent) {
      const handler = this.ctx.onEvent;
      this._eventChain = this._eventChain.then(() => handler(ev)).catch(() => {});
    }

    // agent_end → the turn is complete. If the turn was interrupted, apply the
    // decided status (timeout/aborted); otherwise it completed.
    if (ev.type === "result") {
      const status = this._pendingStatus ?? "completed";
      const message = this._pendingMessage ?? undefined;
      void this._eventChain.then(() => this.resolveTurn(status, message));
    }
  }

  private resolveTurn(status: TurnResult["status"], errorMessage?: string): void {
    const pending = this._pending;
    if (!pending || pending.settled) return;
    pending.settled = true;
    pending.cleanup();
    if (this._graceTimer) {
      clearTimeout(this._graceTimer);
      this._graceTimer = null;
    }
    const summary = this._turnText || null;
    // Reset per-turn accumulators here (not only in send()) so anything that
    // arrives between turns can't leak into the next turn's summary.
    this._turnText = "";
    this._turnActive = false;
    this._inFlight = null;
    this._pending = null;
    this._pendingStatus = null;
    this._pendingMessage = null;
    if (this._state !== "closed") this._state = "idle";
    pending.resolve({
      summary,
      costUsd: null,
      status,
      errorCode: status === "completed" ? null : status === "failed" ? "error" : status,
      errorMessage: errorMessage ?? null,
    });
  }

  private failPending(message: string): void {
    if (this._pending && !this._pending.settled) this.resolveTurn("failed", message);
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  async send(message: string, options?: SendOptions): Promise<SendHandle> {
    if (this._state === "closed") throw new Error("Session is closed");
    if (this._draining) throw new Error("Session is draining — no new sends accepted");
    if (this._turnActive) {
      throw new Error("Pi session is busy — a turn is already in progress (concurrentSend not supported)");
    }
    if (!this.proc?.stdin) throw new Error("Pi session is not connected");

    const uuid = uuidv7();
    this._turnActive = true;
    this._turnText = "";
    this._state = "thinking";

    const timeoutSec = options?.timeoutSec ?? this.ctx.config?.timeoutSec;
    const result = new Promise<TurnResult>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      const onAbort = (): void => this.onTurnInterrupt("aborted");
      const cleanup = (): void => {
        if (timer) clearTimeout(timer);
        options?.signal?.removeEventListener("abort", onAbort);
      };
      this._pending = { resolve, settled: false, cleanup };
      if (timeoutSec && timeoutSec > 0) {
        timer = setTimeout(() => this.onTurnInterrupt("timeout"), timeoutSec * 1000);
      }
      if (options?.signal) {
        if (options.signal.aborted) this.onTurnInterrupt("aborted");
        else options.signal.addEventListener("abort", onAbort, { once: true });
      }
    });
    this._inFlight = result;

    this.proc.stdin.write(JSON.stringify({ id: uuid, type: "prompt", message }) + "\n");
    return { uuid, result };
  }

  private onTurnInterrupt(status: "timeout" | "aborted"): void {
    if (!this._pending || this._pending.settled) return;
    // Decide the outcome, send `abort`, but keep the turn open until pi acks with
    // `agent_end` so the aborted turn's stragglers stay inside this turn (and
    // don't bleed into the next). Force-resolve after a grace deadline if pi
    // never acks — and then swallow the eventual stale `agent_end`.
    this._pendingStatus = status;
    this._pendingMessage = status === "timeout" ? "Turn exceeded its timeout" : "Turn aborted";
    void this.interrupt();
    if (this._graceTimer) clearTimeout(this._graceTimer);
    const graceMs = (this.ctx.config?.graceSec ?? 5) * 1000;
    this._graceTimer = setTimeout(() => {
      this._graceTimer = null;
      this._staleEnds++;
      this.resolveTurn(status, status === "timeout" ? "Turn exceeded its timeout" : "Turn aborted");
    }, graceMs);
  }

  async cancel(_uuid: string): Promise<CancelResult> {
    return { cancelled: false };
  }

  async interrupt(): Promise<void> {
    if (this.proc?.stdin && !this.proc.stdin.destroyed) {
      try {
        this.proc.stdin.write(JSON.stringify({ type: "abort" }) + "\n");
      } catch {
        /* best effort */
      }
    }
  }

  async drain(): Promise<void> {
    this._draining = true;
    if (this._inFlight) {
      try {
        await this._inFlight;
      } catch {
        /* ignore */
      }
    }
    await this.close();
  }

  async close(): Promise<void> {
    this._state = "closed";
    const proc = this.proc;
    this.proc = null;
    if (proc && !proc.killed) {
      try {
        proc.kill();
      } catch {
        /* ignore */
      }
    }
  }
}
