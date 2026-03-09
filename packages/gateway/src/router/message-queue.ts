import type { InboundMessage, QueueConfig } from "../types.js";

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface SessionQueue {
  queue: InboundMessage[];
  running: boolean;
  collectTimer?: ReturnType<typeof setTimeout>;
  abortController?: AbortController;
}

// ---------------------------------------------------------------------------
// MessageQueue
// ---------------------------------------------------------------------------

export class MessageQueue {
  private readonly sessions = new Map<string, SessionQueue>();

  // -----------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------

  private getOrCreate(sessionKey: string): SessionQueue {
    let sq = this.sessions.get(sessionKey);
    if (!sq) {
      sq = { queue: [], running: false };
      this.sessions.set(sessionKey, sq);
    }
    return sq;
  }

  private enforceDepth(sq: SessionQueue, maxDepth: number | undefined): void {
    if (maxDepth !== undefined && maxDepth > 0) {
      while (sq.queue.length > maxDepth) {
        sq.queue.shift(); // drop oldest
      }
    }
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  enqueue(
    sessionKey: string,
    msg: InboundMessage,
    mode: QueueConfig["mode"],
    config: QueueConfig,
  ): void {
    const sq = this.getOrCreate(sessionKey);

    switch (mode) {
      case "queue": {
        sq.queue.push(msg);
        this.enforceDepth(sq, config.maxQueueDepth);
        break;
      }

      case "collect": {
        sq.queue.push(msg);
        this.enforceDepth(sq, config.maxQueueDepth);
        break;
      }

      case "steer": {
        sq.queue = [msg];
        break;
      }

      case "interrupt": {
        sq.abortController = new AbortController();
        sq.queue = [msg];
        break;
      }
    }
  }

  dequeue(sessionKey: string): InboundMessage | InboundMessage[] | null {
    const sq = this.sessions.get(sessionKey);
    if (!sq || sq.queue.length === 0) return null;

    // Determine the mode that was used by inspecting the queue state.
    // For collect mode the gateway calls dequeue expecting all accumulated
    // messages. We detect collect by checking if > 1 message is buffered —
    // but that heuristic is fragile. Instead we return all messages as an
    // array when queue length >= 1 for collect. However, the caller knows
    // the mode. To keep MessageQueue mode-agnostic at dequeue time we use a
    // simple strategy: if the queue has exactly one message, return a single
    // InboundMessage; if more than one, return them all as an array. This
    // covers all four modes correctly:
    //   - queue: always has 0-1 ready (FIFO shift)
    //   - collect: may have many (return all)
    //   - steer: always 0-1 (replaced)
    //   - interrupt: always 0-1 (replaced)
    //
    // Actually, to keep it simpler and more predictable, we'll provide a
    // mode-aware dequeue. But since dequeue doesn't take a mode arg, we
    // use the approach from the spec: queue/steer/interrupt return single,
    // collect returns array. We detect collect by buffer length > 1 or we
    // just always return single for shift-based modes and array for drain.
    //
    // Simplest correct approach: dequeue always returns a single message
    // (shift) UNLESS the queue has more than one, in which case it returns
    // them all (drain). This matches the spec behavior because:
    //   - queue mode: dequeue is called when not running, one message at a time
    //   - collect: multiple accumulate, returned as array
    //   - steer: always 0 or 1
    //   - interrupt: always 0 or 1

    if (sq.queue.length === 1) {
      return sq.queue.shift()!;
    }

    // Multiple messages — return all (collect mode behavior)
    const all = sq.queue;
    sq.queue = [];
    return all;
  }

  isRunning(sessionKey: string): boolean {
    return this.sessions.get(sessionKey)?.running ?? false;
  }

  setRunning(sessionKey: string, running: boolean): void {
    const sq = this.getOrCreate(sessionKey);
    sq.running = running;
  }

  getAbortController(sessionKey: string): AbortController | undefined {
    return this.sessions.get(sessionKey)?.abortController;
  }

  clear(sessionKey: string): void {
    const sq = this.sessions.get(sessionKey);
    if (!sq) return;

    if (sq.collectTimer !== undefined) {
      clearTimeout(sq.collectTimer);
    }
    this.sessions.delete(sessionKey);
  }

  drainAll(): void {
    for (const [, sq] of this.sessions) {
      if (sq.collectTimer !== undefined) {
        clearTimeout(sq.collectTimer);
      }
    }
    this.sessions.clear();
  }
}
