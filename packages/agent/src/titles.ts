import type { AgentSession } from "./types.js";

/** Controls for a native title request. Generation never persists a suggestion. */
export interface NativeTitleOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface FallbackTitleContext {
  description: string;
  signal?: AbortSignal;
  reason: "unsupported" | "empty" | "failed";
  /** The native failure, when reason is failed. The host decides how to report it. */
  error?: unknown;
}

export interface GenerateTitleOptions extends NativeTitleOptions {
  description: string;
  fallbackTitleGenerator?: (context: FallbackTitleContext) => Promise<string | null>;
}

export interface GeneratedTitle {
  title: string;
  source: "native" | "fallback";
}

export function throwIfTitleAborted(signal?: AbortSignal): void {
  signal?.throwIfAborted();
}

/** Stop waiting immediately on cancellation, even when a host callback ignores its signal. */
export async function awaitTitle<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  throwIfTitleAborted(signal);
  if (!signal) return work;
  let abort!: () => void;
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => {
      abort = () => reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    })]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

/** Whitespace normalization only. Length, wording and model choice belong to the host. */
export function normalizeTitle(title: unknown): string | null {
  if (typeof title !== "string") return null;
  return title.trim().replace(/\s+/g, " ") || null;
}

/**
 * Try the harness's actual naming operation, then an explicitly supplied host fallback.
 * Never reads an existing name, persists a title, supplies a prompt/model, or starts a turn.
 * Cancellation propagates and never starts a fallback. Fallback errors propagate to the host.
 */
export async function generateTitle(
  session: Pick<AgentSession, "generateNativeTitle"> | null,
  options: GenerateTitleOptions,
): Promise<GeneratedTitle | null> {
  throwIfTitleAborted(options.signal);
  let reason: FallbackTitleContext["reason"] = "unsupported";
  let error: unknown;
  if (session?.generateNativeTitle) {
    try {
      const title = normalizeTitle(await awaitTitle(session.generateNativeTitle(options.description, options), options.signal));
      throwIfTitleAborted(options.signal);
      if (title) return { title, source: "native" };
      reason = "empty";
    } catch (failure) {
      throwIfTitleAborted(options.signal);
      if (failure instanceof Error && failure.name === "AbortError") throw failure;
      reason = "failed";
      error = failure;
    }
  }
  throwIfTitleAborted(options.signal);
  if (!options.fallbackTitleGenerator) return null;
  const title = normalizeTitle(await awaitTitle(options.fallbackTitleGenerator({
    description: options.description, signal: options.signal, reason,
    ...(reason === "failed" ? { error } : {}),
  }), options.signal));
  throwIfTitleAborted(options.signal);
  return title ? { title, source: "fallback" } : null;
}
