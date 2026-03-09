import { SessionStore } from "./store.js";
import { parseDuration } from "../utils/duration.js";
import type { GatewayEventEmitter } from "../types.js";

const REAP_INTERVAL_MS = 60_000;

export class IdleSessionReaper {
  private interval: ReturnType<typeof setInterval> | null = null;
  private durationMs: number;

  constructor(
    private store: SessionStore,
    private resetOnIdle: string,
    private events: GatewayEventEmitter,
  ) {
    this.durationMs = parseDuration(resetOnIdle);
  }

  start(): void {
    if (this.interval !== null) {
      return;
    }
    this.interval = setInterval(() => {
      void this.reap();
    }, REAP_INTERVAL_MS);
  }

  stop(): void {
    if (this.interval !== null) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  /** Exposed for testing — runs the reap logic immediately. */
  async reap(): Promise<void> {
    const now = Date.now();
    const sessions = this.store.getAll();

    for (const session of sessions) {
      if (now - session.lastActivityAt > this.durationMs) {
        session.sessionParams = null;
        this.store.set(session.key, session);

        this.events.emit(
          "session.reset",
          {
            sessionKey: session.key,
            reason: "idle",
            idleDuration: this.resetOnIdle,
          },
          session.key,
        );
      }
    }

    await this.store.persist();
  }
}
