export class TelemetryCancelled extends Error {
  constructor(readonly kind: "aborted" | "timeout") { super(kind === "aborted" ? "Telemetry read cancelled" : "Telemetry read timed out"); }
}
interface Flight<T> {
  controller: AbortController;
  promise: Promise<T>;
  users: number;
  finished: boolean;
}

/** In-flight work only. No completed-data cache, and no cancellation shared between callers. */
export class TelemetryFlights<T> {
  private flights = new Map<string, Flight<T>>();
  run(key: string, start: (signal: AbortSignal) => Promise<T>, options: { signal?: AbortSignal; timeoutMs: number }): Promise<T> {
    if (options.signal?.aborted) return Promise.reject(new TelemetryCancelled("aborted"));
    let flight = this.flights.get(key);
    if (!flight) {
      const controller = new AbortController();
      const next = { controller, users: 0, finished: false } as Flight<T>;
      const deadline = setTimeout(() => controller.abort(), 60_000); deadline.unref();
      next.promise = Promise.resolve().then(() => start(controller.signal)).then((value) => {
        if (controller.signal.aborted) throw new TelemetryCancelled("timeout");
        return value;
      }).finally(() => {
        clearTimeout(deadline); next.finished = true;
        if (this.flights.get(key) === next) this.flights.delete(key);
      });
      this.flights.set(key, next); flight = next;
    }
    const shared = flight;
    shared.users++;
    return new Promise((resolve, reject) => {
      let active = true;
      const cleanup = () => { clearTimeout(timer); options.signal?.removeEventListener("abort", onAbort); shared.users--; };
      const cancel = (kind: "aborted" | "timeout") => {
        if (!active) return;
        active = false; cleanup();
        const error = new TelemetryCancelled(kind);
        if (!shared.users && !shared.finished) {
          if (this.flights.get(key) === shared) this.flights.delete(key);
          shared.controller.abort();
          // The last caller waits for the transport's bounded cleanup.
          void shared.promise.then(() => reject(error), () => reject(error));
        } else reject(error);
      };
      const onAbort = () => cancel("aborted");
      const timer = setTimeout(() => cancel("timeout"), options.timeoutMs); timer.unref();
      options.signal?.addEventListener("abort", onAbort, { once: true });
      if (options.signal?.aborted) onAbort();
      void shared.promise.then((value) => {
        if (!active) return;
        active = false; cleanup(); resolve(structuredClone(value));
      }, (error) => {
        if (!active) return;
        active = false; cleanup(); reject(error);
      });
    });
  }
}

export function rateLimitTimeout(value?: number): number {
  if (value !== undefined && (!Number.isFinite(value) || value <= 0)) throw new RangeError("timeoutMs must be a positive finite number");
  return Math.min(value ?? 10_000, 60_000);
}
