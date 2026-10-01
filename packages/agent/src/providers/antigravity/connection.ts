import { spawn, type ChildProcess } from "node:child_process";
import type { StreamEvent } from "../../types.js";
import { killProcessTree } from "../../utils/process.js";
import {
  ANTIGRAVITY_PROVIDER_TYPE,
  isAgyAuthRequired,
  parseAgyErrorLine,
  type AgyErrorReport,
  type AgyResult,
  type AgyStreamParser,
} from "./parse.js";
import { AGY_LOGIN_COMMAND } from "./runtime.js";

const STDERR_TAIL_BYTES = 16 * 1024;

export interface AgyConnectionOptions {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  parser: AgyStreamParser;
  onEvent?: (event: StreamEvent) => void | Promise<void>;
  onOutput?: (stream: "stdout" | "stderr", chunk: string) => void | Promise<void>;
}

/** How a turn (or the whole process) ended, as seen by the host. */
export interface AgyTurnOutcome {
  /** The turn's `result` event, or null when the process exited first. */
  result: AgyResult | null;
  /** The process has exited. */
  exited: boolean;
  exitCode: number | null;
  signal: string | null;
  /** The CLI asked for a sign-in, which a headless run can never complete. */
  authRequired: boolean;
  agyError: AgyErrorReport | null;
  /** Last ~16KB of stderr, for error messages. */
  stderr: string;
}

/**
 * One headless `agy` process speaking `stream-json` in both directions.
 *
 * Every stdout line is parsed and dispatched through a single promise chain,
 * so `onEvent` handlers run strictly in wire order and a turn's waiter
 * resolves only after the handler for its `result` event has settled.
 */
export class AgyConnection {
  readonly pid: number | null;
  authRequired = false;
  agyError: AgyErrorReport | null = null;

  private readonly child: ChildProcess;
  private chain: Promise<void> = Promise.resolve();
  private stdoutBuffer = "";
  private stderrLineBuffer = "";
  private stderrTail = "";
  private exitInfo: { code: number | null; signal: string | null } | null = null;
  private finalized = false;
  private readonly waiters: Array<(outcome: AgyTurnOutcome) => void> = [];
  private readonly exitWaiters: Array<() => void> = [];

  constructor(private readonly options: AgyConnectionOptions) {
    this.child = spawn(options.command, options.args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
      // A process group lets interrupt/terminate reach the commands agy runs.
      detached: process.platform !== "win32",
    });
    this.pid = this.child.pid ?? null;

    this.child.stdin?.on("error", () => { /* agy exited; the exit path reports it */ });
    this.child.stdout?.setEncoding("utf-8");
    this.child.stderr?.setEncoding("utf-8");
    this.child.stdout?.on("data", (chunk: string) => this.onStdout(chunk));
    this.child.stderr?.on("data", (chunk: string) => this.onStderr(chunk));
    this.child.on("error", (err) => {
      this.appendStderrTail(`${err.message}\n`);
      this.finalize(null, null);
    });
    this.child.on("close", (code, signal) => this.finalize(code, signal ?? null));
  }

  get alive(): boolean {
    return this.exitInfo === null;
  }

  /** Exit status, or null while the process runs. */
  get exit(): { code: number | null; signal: string | null } | null {
    return this.exitInfo;
  }

  /** Last ~16KB of stderr. */
  get stderr(): string {
    return this.stderrTail;
  }

  /** Resolves once the process has exited and every queued event was dispatched. */
  exited(): Promise<void> {
    if (this.finalized) return this.chain;
    return new Promise((resolve) => this.exitWaiters.push(resolve));
  }

  /** Send one user message. Resolve it with `nextTurn()`. */
  write(text: string): void {
    if (!this.alive || !this.child.stdin || this.child.stdin.destroyed) return;
    this.child.stdin.write(`${JSON.stringify({ event: "user", message: { content: text } })}\n`);
  }

  /** Close stdin. `agy` finishes the current turn and exits. */
  endInput(): void {
    try {
      this.child.stdin?.end();
    } catch {
      /* already closed */
    }
  }

  /** Resolves with the next `result` event, or with the exit when no result comes. */
  nextTurn(): Promise<AgyTurnOutcome> {
    if (this.finalized) return Promise.resolve(this.outcome(null));
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  /** Signal the whole process group. */
  signal(signal: NodeJS.Signals): void {
    if (this.pid != null && this.alive) killProcessTree(this.pid, signal);
  }

  /** True when the process exited within `ms`. */
  async waitForExit(ms: number): Promise<boolean> {
    return (await within(this.exited().then(() => true), ms)) === true;
  }

  /**
   * Stop the process: close stdin and give it a moment to exit on its own
   * (an idle `agy` flushes its conversation history and exits), then
   * SIGTERM, then SIGKILL after `graceSec`.
   */
  async terminate(graceSec = 5, idleWaitMs = 1000): Promise<void> {
    if (this.finalized) return;
    this.endInput();
    if (idleWaitMs > 0 && await this.waitForExit(idleWaitMs)) return;
    this.signal("SIGTERM");
    if (await this.waitForExit(graceSec * 1000)) return;
    this.signal("SIGKILL");
    await this.waitForExit(1000);
  }

  private onStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    const lines = this.stdoutBuffer.split("\n");
    this.stdoutBuffer = lines.pop() ?? "";
    for (const line of lines) this.enqueueLine(line);
  }

  private enqueueLine(rawLine: string): void {
    const line = rawLine.replace(/\r$/, "");
    if (!line.trim()) return;
    this.chain = this.chain.then(async () => {
      await this.emitOutput("stdout", `${line}\n`);
      const parsed = this.options.parser.parseLine(line);
      for (const event of parsed.events) await this.emitEvent(event);
      if (parsed.result) this.waiters.shift()?.(this.outcome(parsed.result));
    });
  }

  private onStderr(chunk: string): void {
    this.appendStderrTail(chunk);
    this.chain = this.chain.then(() => this.emitOutput("stderr", chunk));
    this.stderrLineBuffer += chunk;
    const lines = this.stderrLineBuffer.split("\n");
    this.stderrLineBuffer = lines.pop() ?? "";
    for (const line of lines) this.inspectStderrLine(line);
    // The sign-in prompt can sit on an unterminated line while agy waits.
    if (!this.authRequired && isAgyAuthRequired(this.stderrLineBuffer)) this.onAuthRequired(this.stderrLineBuffer);
  }

  private inspectStderrLine(line: string): void {
    const report = parseAgyErrorLine(line);
    if (report) this.agyError = report;
    if (!this.authRequired && isAgyAuthRequired(line)) this.onAuthRequired(line);
  }

  /**
   * A headless run without a cached sign-in prints a login URL and waits a
   * full minute for a code nobody can paste. Fail fast instead: report it
   * and stop the process.
   */
  private onAuthRequired(message: string): void {
    this.authRequired = true;
    const event: StreamEvent = {
      type: "auth_required",
      httpStatus: null,
      reason: "missing",
      loginCommand: AGY_LOGIN_COMMAND,
      message: message.trim() || "Antigravity CLI requires sign-in.",
      timestamp: new Date().toISOString(),
      providerType: ANTIGRAVITY_PROVIDER_TYPE,
      sessionId: this.options.parser.conversationId,
      messageId: null,
      eventId: null,
      turnId: null,
      parentToolCallId: null,
      raw: { stderr: message },
    };
    this.chain = this.chain.then(() => this.emitEvent(event));
    this.signal("SIGTERM");
  }

  private appendStderrTail(chunk: string): void {
    this.stderrTail = (this.stderrTail + chunk).slice(-STDERR_TAIL_BYTES);
  }

  private finalize(code: number | null, signal: string | null): void {
    if (this.exitInfo === null) this.exitInfo = { code, signal };
    if (this.finalized) return;
    this.finalized = true;
    if (this.stdoutBuffer.trim()) this.enqueueLine(this.stdoutBuffer);
    this.stdoutBuffer = "";
    if (this.stderrLineBuffer.trim()) this.inspectStderrLine(this.stderrLineBuffer);
    this.stderrLineBuffer = "";
    this.chain = this.chain.then(() => {
      for (const waiter of this.waiters.splice(0)) waiter(this.outcome(null));
      for (const waiter of this.exitWaiters.splice(0)) waiter();
    });
  }

  private outcome(result: AgyResult | null): AgyTurnOutcome {
    return {
      result,
      exited: this.exitInfo !== null,
      exitCode: this.exitInfo?.code ?? null,
      signal: this.exitInfo?.signal ?? null,
      authRequired: this.authRequired,
      agyError: this.agyError,
      stderr: this.stderrTail,
    };
  }

  private async emitEvent(event: StreamEvent): Promise<void> {
    if (!this.options.onEvent) return;
    try {
      await this.options.onEvent(event);
    } catch {
      /* a throwing handler must not break the stream */
    }
  }

  private async emitOutput(stream: "stdout" | "stderr", chunk: string): Promise<void> {
    if (!this.options.onOutput) return;
    try {
      await this.options.onOutput(stream, chunk);
    } catch {
      /* swallow */
    }
  }
}

/** First meaningful stderr line, skipping the sign-in URL noise. */
export function firstAgyErrorLine(stderr: string): string | null {
  for (const raw of stderr.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || /^https?:\/\//.test(line) || line.startsWith("AGY_ERROR:")) continue;
    return line.replace(/^error:\s*/i, "");
  }
  return null;
}

/** Waits for `promise` up to `ms`; resolves null on timeout. */
export function within<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(null);
      },
    );
  });
}

/**
 * Interrupt the running turn like Ctrl+C would: SIGINT the process group,
 * give agy a moment to report the turn as INTERRUPTED, and stop the process
 * if it does not. Resolves with whatever outcome arrived.
 */
export async function interruptAgyTurn(
  connection: AgyConnection,
  pending: Promise<AgyTurnOutcome>,
  graceSec = 5,
): Promise<AgyTurnOutcome | null> {
  connection.signal("SIGINT");
  const settled = await within(pending, 3000);
  if (settled) return settled;
  await connection.terminate(graceSec, 0);
  return within(pending, 2000);
}
