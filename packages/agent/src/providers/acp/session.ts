import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import { readFile, writeFile } from "node:fs/promises";
import type {
  AgentSession,
  AgentMode,
  CancelResult,
  SendHandle,
  SendOptions,
  SessionContext,
  SessionState,
  TurnResult,
} from "../../types.js";
import { buildEnv, ensurePathInEnv } from "../../utils/env.js";
import { uuidv7 } from "../../utils/uuid.js";
import { extractContentText, mapAcpStopReason, mapAcpUpdate } from "./parse.js";

// Type-only SDK imports — erased at runtime so the SDK is only loaded when a
// session is actually created (via the dynamic import in `connect`).
import type {
  Client,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionNotification,
} from "@agentclientprotocol/sdk";

/**
 * Optional hooks to absorb a specific ACP agent's quirks without forking the
 * base — Paseo's pattern (e.g. Copilot hides a deprecated "autopilot" mode and
 * exposes a synthetic "allow-all"). Keep the base generic; put weirdness here.
 */
export interface AcpTransformers {
  /** Rewrite the discovered mode list (filter, rename, add synthetic modes). */
  modes?: (modes: AgentMode[]) => AgentMode[];
  /** Map a requested mode id to the protocol mode id before `setSessionMode`. */
  modeId?: (modeId: string) => string;
}

/** What `acpProvider` hands a session: how to spawn + drive the agent. */
export interface AcpSessionDeps {
  /** Provider id (used for event `providerType`). */
  provider: string;
  /** Command to spawn: [binary, ...args]. e.g. ["gemini", "--acp"]. */
  command: string[];
  /** Environment overlay. */
  env?: Record<string, string>;
  /** Default mode id applied on session creation. */
  modeId?: string;
  /** Per-agent quirk transformers. */
  transformers?: AcpTransformers;
}

/** The slice of the ACP `ClientSideConnection` surface this session uses. */
interface AcpConnection {
  initialize(params: unknown): Promise<{
    protocolVersion?: number;
    agentCapabilities?: unknown;
    authMethods?: unknown;
  }>;
  newSession(params: unknown): Promise<{ sessionId: string; modes?: unknown; models?: unknown }>;
  loadSession(params: unknown): Promise<{ modes?: unknown; models?: unknown }>;
  prompt(params: unknown): Promise<{ stopReason?: string }>;
  cancel(params: unknown): Promise<void>;
  setSessionMode?(params: unknown): Promise<unknown>;
}

/** Reject if `p` doesn't settle within `ms` — bounds the handshake so a hung
 *  agent binary can't hang connect()/listModes() indefinitely. */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms),
    ),
  ]);
}

/** Resume session id from sessionParams (sessionId / session_id), or null. */
function readAcpResumeId(sp: Record<string, unknown> | null | undefined): string | null {
  if (!sp) return null;
  const id = sp["sessionId"] ?? sp["session_id"];
  return typeof id === "string" && id.length > 0 ? id : null;
}

const ACP_HANDSHAKE_TIMEOUT_MS = 30_000;

interface AcpSdk {
  ndJsonStream(
    output: WritableStream<Uint8Array>,
    input: ReadableStream<Uint8Array>,
  ): unknown;
  ClientSideConnection: new (toClient: (agent: unknown) => Client, stream: unknown) => AcpConnection;
  PROTOCOL_VERSION: number;
}

/** Spawn the agent, run the ACP handshake, and return a connected session. */
export async function createAcpSession(
  deps: AcpSessionDeps,
  ctx: SessionContext,
): Promise<AgentSession> {
  const session = new AcpSession(deps, ctx);
  await session.connect();
  return session;
}

class AcpSession implements AgentSession {
  private _state: SessionState = "idle";
  private _sessionId: string | null = null;
  private proc: ChildProcess | null = null;
  private connection: AcpConnection | null = null;

  /** A turn is in flight (ACP runs one prompt at a time). */
  private _turnActive = false;
  /** Accumulated assistant text for the current turn → TurnResult.summary. */
  private _turnText = "";
  private _inFlight: Promise<TurnResult> | null = null;
  private _draining = false;
  /** toolCallId → tool name, so tool_call_update can report a name. Cleared per turn. */
  private readonly _toolNames = new Map<string, string>();

  constructor(
    private readonly deps: AcpSessionDeps,
    private readonly ctx: SessionContext,
  ) {}

  get sessionId(): string | null {
    return this._sessionId;
  }
  get state(): SessionState {
    return this._state;
  }

  // -------------------------------------------------------------------------
  // Connect — spawn + initialize + newSession
  // -------------------------------------------------------------------------

  async connect(): Promise<void> {
    const acp = (await import("@agentclientprotocol/sdk")) as unknown as AcpSdk;

    const binary = this.ctx.config?.command ?? this.deps.command[0]!;
    const args = this.deps.command.slice(1);
    const env = buildEnv({ ...this.deps.env, ...this.ctx.env });
    ensurePathInEnv(env);

    const proc = spawn(binary, args, {
      cwd: this.ctx.cwd ?? process.cwd(),
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.proc = proc;

    proc.stderr?.setEncoding("utf-8");
    proc.stderr?.on("data", (chunk: string) => {
      if (this.ctx.onOutput) {
        try {
          void this.ctx.onOutput("stderr", chunk);
        } catch {
          /* swallow */
        }
      }
    });
    proc.on("exit", () => {
      if (this._state !== "closed") this._state = "closed";
    });
    // Catch spawn failures (ENOENT, EACCES) — an unhandled 'error' event would
    // otherwise crash the host process.
    proc.on("error", () => {
      if (this._state !== "closed") this._state = "closed";
    });

    if (!proc.stdin || !proc.stdout) throw new Error("Failed to open stdio on ACP agent process");

    // fs callbacks do unconfined disk I/O on agent-supplied paths — equivalent to
    // the agent's own filesystem access (it's a local subprocess with the user's
    // privileges), so this isn't a sandbox escape, just coordination.
    try {
      const writable = Writable.toWeb(proc.stdin) as unknown as WritableStream<Uint8Array>;
      const readable = Readable.toWeb(proc.stdout) as unknown as ReadableStream<Uint8Array>;
      const stream = acp.ndJsonStream(writable, readable);

      const client: Client = {
        requestPermission: (params) => this.handlePermission(params),
        sessionUpdate: (params) => this.handleSessionUpdate(params),
        readTextFile: async (params) => {
          const content = await readFile((params as { path: string }).path, "utf-8");
          return { content };
        },
        writeTextFile: async (params) => {
          await writeFile(
            (params as { path: string; content: string }).path,
            (params as { content: string }).content,
            "utf-8",
          );
          return {};
        },
      };

      this.connection = new acp.ClientSideConnection(() => client, stream);

      const initResult = await withTimeout(
        this.connection.initialize({
          protocolVersion: acp.PROTOCOL_VERSION,
          clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
        }),
        ACP_HANDSHAKE_TIMEOUT_MS,
        "acp initialize",
      );
      const agentCaps = (initResult as { agentCapabilities?: { loadSession?: boolean } }).agentCapabilities;
      const cwd = this.ctx.cwd ?? process.cwd();

      // Resume an existing session when the caller supplied one AND the agent
      // advertises `loadSession`; otherwise start fresh. (ACP `session/load`
      // replays history via notifications, which our turn-isolation gate drops —
      // we want continuity, not a re-emit.) When resume isn't possible the new
      // session id supersedes the caller's, so saved params naturally roll over.
      const resumeId = readAcpResumeId(this.ctx.sessionParams);
      let loaded = false;
      if (resumeId && agentCaps?.loadSession && this.connection.loadSession) {
        try {
          await withTimeout(
            this.connection.loadSession({ sessionId: resumeId, cwd, mcpServers: [] }),
            ACP_HANDSHAKE_TIMEOUT_MS,
            "acp loadSession",
          );
          this._sessionId = resumeId;
          loaded = true;
        } catch (err) {
          if (this.ctx.onOutput) {
            const reason = err instanceof Error ? err.message : String(err);
            try {
              void this.ctx.onOutput("stderr", `agentex: acp session/load failed for ${resumeId}, starting fresh: ${reason}\n`);
            } catch { /* swallow */ }
          }
        }
      }
      if (!loaded) {
        const res = await withTimeout(
          this.connection.newSession({ cwd, mcpServers: [] }),
          ACP_HANDSHAKE_TIMEOUT_MS,
          "acp newSession",
        );
        this._sessionId = typeof res.sessionId === "string" ? res.sessionId : null;
      }

      const requested = this.ctx.config?.modeId ?? this.deps.modeId;
      if (requested && this._sessionId && this.connection.setSessionMode) {
        const modeId = this.deps.transformers?.modeId
          ? this.deps.transformers.modeId(requested)
          : requested;
        try {
          await this.connection.setSessionMode({ sessionId: this._sessionId, modeId });
        } catch {
          /* mode application is best-effort */
        }
      }
    } catch (err) {
      // Spawn/handshake failed — tear down so we don't leak the child process.
      this._state = "closed";
      try {
        proc.kill();
      } catch {
        /* ignore */
      }
      throw err;
    }

    // Wire AbortSignal → close.
    if (this.ctx.signal) {
      if (this.ctx.signal.aborted) void this.close();
      else this.ctx.signal.addEventListener("abort", () => void this.close(), { once: true });
    }
  }

  // -------------------------------------------------------------------------
  // Client callbacks (agent → us)
  // -------------------------------------------------------------------------

  private async handleSessionUpdate(params: SessionNotification): Promise<void> {
    const update = (params as { update?: unknown }).update as Record<string, unknown> | undefined;
    if (!update) return;
    // Drop stragglers from a finished/aborted turn (ACP events aren't turn-tagged,
    // so a late update would otherwise be attributed to the next turn).
    if (!this._turnActive) return;

    const kind = update["sessionUpdate"];
    if (kind === "agent_message_chunk") {
      const text = extractContentText(update["content"]);
      if (text) this._turnText += text;
    }
    // Cache tool names from the initial tool_call so tool_call_update (which often
    // omits `title`) can still report a toolName.
    if (kind === "tool_call") {
      const id = update["toolCallId"];
      const title = update["title"];
      if (typeof id === "string" && typeof title === "string" && title) {
        this._toolNames.set(id, title);
      }
    }

    const event = mapAcpUpdate(update, {
      provider: this.deps.provider,
      sessionId: this._sessionId,
      timestamp: new Date().toISOString(),
    });
    if (event) {
      if (event.type === "tool_result" && !event.toolName && event.toolCallId) {
        const cached = this._toolNames.get(event.toolCallId);
        if (cached) event.toolName = cached;
      }
      if (this.ctx.onEvent) {
        try {
          await this.ctx.onEvent(event);
        } catch {
          /* a throwing handler must not break the stream */
        }
      }
    }
  }

  private async handlePermission(
    params: RequestPermissionRequest,
  ): Promise<RequestPermissionResponse> {
    const toolCall = ((params as { toolCall?: unknown }).toolCall ?? {}) as Record<string, unknown>;
    const options = (((params as { options?: unknown }).options ?? []) as Array<Record<string, unknown>>);

    const select = (allow: boolean): RequestPermissionResponse => {
      const want = allow ? ["allow_once", "allow_always"] : ["reject_once", "reject_always"];
      const opt = options.find((o) => want.includes(String(o["kind"]))) ?? options[0];
      if (!opt) return { outcome: { outcome: "cancelled" } } as RequestPermissionResponse;
      return {
        outcome: { outcome: "selected", optionId: String(opt["optionId"]) },
      } as RequestPermissionResponse;
    };

    this._state = "waiting_for_approval";
    const restore = (): void => {
      if (this._state === "waiting_for_approval") this._state = this._turnActive ? "thinking" : "idle";
    };

    if (!this.ctx.onUserInputRequest) {
      const r = select(true);
      restore();
      return r;
    }

    try {
      const result = await this.ctx.onUserInputRequest({
        toolName: String(toolCall["title"] ?? toolCall["kind"] ?? "tool"),
        input: (toolCall["rawInput"] as Record<string, unknown>) ?? toolCall,
        toolUseId: String(toolCall["toolCallId"] ?? ""),
        ...(typeof toolCall["title"] === "string" ? { title: toolCall["title"] as string } : {}),
      });
      const r = select(result.allow);
      restore();
      return r;
    } catch {
      const r = select(false);
      restore();
      return r;
    }
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  async send(message: string, options?: SendOptions): Promise<SendHandle> {
    if (this._state === "closed") throw new Error("Session is closed");
    if (this._draining) throw new Error("Session is draining — no new sends accepted");
    if (this._turnActive) {
      throw new Error("ACP session is busy — a turn is already in progress (concurrentSend not supported)");
    }

    const uuid = uuidv7();
    this._turnActive = true;
    this._turnText = "";
    this._toolNames.clear();
    this._state = "thinking";

    const result = this.runPrompt(message, options);
    this._inFlight = result;
    return { uuid, result };
  }

  private finishTurn(): void {
    this._turnActive = false;
    this._inFlight = null;
    if (this._state !== "closed") this._state = "idle";
  }

  private async runPrompt(message: string, options?: SendOptions): Promise<TurnResult> {
    const sessionId = this._sessionId;
    if (!this.connection || !sessionId) {
      this.finishTurn();
      return {
        summary: null,
        costUsd: null,
        status: "failed",
        errorCode: "not_initialized",
        errorMessage: "ACP session is not initialized",
      };
    }

    const timeoutSec = options?.timeoutSec ?? this.ctx.config?.timeoutSec;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const promptP = this.connection
      .prompt({ sessionId, prompt: [{ type: "text", text: message }] })
      .then((res) => ({ ok: true as const, res }))
      .catch((err: unknown) => ({
        ok: false as const,
        error: err instanceof Error ? err.message : String(err),
      }));

    const guards: Promise<"timeout" | "aborted">[] = [];
    if (timeoutSec && timeoutSec > 0) {
      guards.push(
        new Promise((resolve) => {
          timer = setTimeout(() => resolve("timeout"), timeoutSec * 1000);
        }),
      );
    }
    if (options?.signal) {
      if (options.signal.aborted) guards.push(Promise.resolve("aborted"));
      else
        guards.push(
          new Promise((resolve) =>
            options.signal!.addEventListener("abort", () => resolve("aborted"), { once: true }),
          ),
        );
    }

    const outcome = await Promise.race([promptP.then(() => "prompt" as const), ...guards]);
    if (timer) clearTimeout(timer);

    if (outcome === "timeout" || outcome === "aborted") {
      try {
        await this.interrupt();
      } catch {
        /* best effort */
      }
      // Drain the cancelled turn before finishing: ACP guarantees the agent
      // flushes any pending session/update notifications and then resolves the
      // prompt as cancelled. Awaiting it (bounded) keeps those stragglers inside
      // THIS turn's window so they can't bleed into the next turn's text/events.
      const summaryBeforeDrain = this._turnText;
      await Promise.race([
        promptP,
        new Promise<void>((resolve) => setTimeout(resolve, 2000)),
      ]);
      this.finishTurn();
      return {
        summary: (this._turnText || summaryBeforeDrain) || null,
        costUsd: null,
        status: outcome,
        errorCode: outcome,
        errorMessage: outcome === "timeout" ? "Turn exceeded its timeout" : "Turn aborted",
      };
    }

    const settled = await promptP;
    this.finishTurn();
    if (!settled.ok) {
      return {
        summary: this._turnText || null,
        costUsd: null,
        status: "failed",
        errorCode: "prompt_error",
        errorMessage: settled.error,
      };
    }
    return {
      summary: this._turnText || null,
      costUsd: null,
      status: mapAcpStopReason(settled.res?.stopReason),
      errorCode: null,
      errorMessage: null,
    };
  }

  async cancel(_uuid: string): Promise<CancelResult> {
    // ACP has no per-queued-message cancel — only whole-turn cancel via interrupt().
    return { cancelled: false };
  }

  async interrupt(): Promise<void> {
    if (this.connection && this._sessionId) {
      try {
        await this.connection.cancel({ sessionId: this._sessionId });
      } catch {
        /* best effort */
      }
    }
  }

  async drain(): Promise<void> {
    this._draining = true;
    const inFlight = this._inFlight;
    if (inFlight) {
      try {
        await inFlight;
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

/**
 * Discover an ACP agent's available modes by spawning it, running the
 * handshake, creating a throwaway session, reading the advertised modes, and
 * closing. Returns [] on any failure (modes are advisory).
 */
export async function listAcpModes(deps: AcpSessionDeps, ctx?: SessionContext): Promise<AgentMode[]> {
  let proc: ChildProcess | null = null;
  try {
    const acp = (await import("@agentclientprotocol/sdk")) as unknown as AcpSdk;
    const binary = ctx?.config?.command ?? deps.command[0]!;
    const args = deps.command.slice(1);
    const env = buildEnv({ ...deps.env, ...ctx?.env });
    ensurePathInEnv(env);
    proc = spawn(binary, args, {
      cwd: ctx?.cwd ?? process.cwd(),
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    // Swallow spawn errors so they don't surface as an unhandled 'error' crash.
    proc.on("error", () => {});
    if (!proc.stdin || !proc.stdout) return [];
    const writable = Writable.toWeb(proc.stdin) as unknown as WritableStream<Uint8Array>;
    const readable = Readable.toWeb(proc.stdout) as unknown as ReadableStream<Uint8Array>;
    const stream = acp.ndJsonStream(writable, readable);
    const client: Client = {
      requestPermission: async () => ({ outcome: { outcome: "cancelled" } }) as RequestPermissionResponse,
      sessionUpdate: async () => {},
    };
    const connection = new acp.ClientSideConnection(() => client, stream);
    await withTimeout(
      connection.initialize({
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
      }),
      ACP_HANDSHAKE_TIMEOUT_MS,
      "acp initialize (listModes)",
    );
    const res = await withTimeout(
      connection.newSession({ cwd: ctx?.cwd ?? process.cwd(), mcpServers: [] }),
      ACP_HANDSHAKE_TIMEOUT_MS,
      "acp newSession (listModes)",
    );
    const modes = parseAcpModes(res.modes);
    return deps.transformers?.modes ? deps.transformers.modes(modes) : modes;
  } catch {
    return [];
  } finally {
    // Always tear down the throwaway process — initialize/newSession can throw
    // (agent doesn't speak ACP, handshake mismatch) and would otherwise leak it.
    if (proc && !proc.killed) {
      try {
        proc.kill();
      } catch {
        /* ignore */
      }
    }
  }
}

/** Parse an ACP `SessionModeState` (`{ currentModeId, availableModes }`) into AgentMode[]. */
export function parseAcpModes(modeState: unknown): AgentMode[] {
  if (!modeState || typeof modeState !== "object") return [];
  const available = (modeState as Record<string, unknown>)["availableModes"];
  if (!Array.isArray(available)) return [];
  const out: AgentMode[] = [];
  for (const m of available) {
    if (!m || typeof m !== "object") continue;
    const r = m as Record<string, unknown>;
    const id = typeof r["id"] === "string" ? r["id"] : "";
    if (!id) continue;
    out.push({
      id,
      name: typeof r["name"] === "string" ? r["name"] : id,
      ...(typeof r["description"] === "string" ? { description: r["description"] } : {}),
    });
  }
  return out;
}
