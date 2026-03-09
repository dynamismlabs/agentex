import type {
  GatewayEventEmitter,
  GatewayEventPayload,
} from "../types.js";

type Handler = (payload: GatewayEventPayload) => void;

export class GatewayEventEmitterImpl implements GatewayEventEmitter {
  private listeners = new Map<string, Set<Handler>>();
  private seq = 0;

  on(type: string, handler: Handler): void {
    let handlers = this.listeners.get(type);
    if (!handlers) {
      handlers = new Set();
      this.listeners.set(type, handlers);
    }
    handlers.add(handler);
  }

  off(type: string, handler: Handler): void {
    const handlers = this.listeners.get(type);
    if (handlers) {
      handlers.delete(handler);
      if (handlers.size === 0) {
        this.listeners.delete(type);
      }
    }
  }

  emit(type: string, data: Record<string, unknown>, sessionKey?: string): void {
    this.seq += 1;

    const payload: GatewayEventPayload = {
      type,
      seq: this.seq,
      ts: Date.now(),
      ...(sessionKey !== undefined ? { sessionKey } : {}),
      data,
    };

    const typeHandlers = this.listeners.get(type);
    if (typeHandlers) {
      for (const handler of typeHandlers) {
        handler(payload);
      }
    }

    // Wildcard listeners receive all events
    if (type !== "*") {
      const wildcardHandlers = this.listeners.get("*");
      if (wildcardHandlers) {
        for (const handler of wildcardHandlers) {
          handler(payload);
        }
      }
    }
  }
}
