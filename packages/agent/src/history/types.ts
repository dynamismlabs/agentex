import type { BaseStreamEventFields, StreamEvent } from "../types.js";

export interface LocalHistoryDiscoverOptions {
  includeArchived?: boolean;
  mainSessionsOnly?: boolean;
  requireUserMessage?: boolean;
  cwd?: string;
  limit?: number;
  env?: Record<string, string>;
}

export interface LocalHistoryProbeOptions {
  limit?: number;
  env?: Record<string, string>;
}

export interface LocalHistoryProbeResult {
  providerType: string;
  homeAvailable: boolean;
  historyAvailable: boolean;
  /** A file count only. It is not an eligible-session count. */
  approximateCount?: number;
}

export type LocalHistoryArchiveState = "active" | "archived" | "unknown";

export interface LocalHistorySourceFingerprint {
  size: number;
  /** String because nanosecond timestamps can exceed Number.MAX_SAFE_INTEGER. */
  modifiedAtNs: string;
  sha256?: string;
}

export interface LocalHistorySession {
  version: 1;
  providerType: string;
  externalSessionId: string;
  /** Local-runtime detail. Network hosts must not serialize this to clients. */
  transcriptPath: string;
  cwd: string | null;
  title: string | null;
  startedAt: string | null;
  updatedAt: string;
  branch: string | null;
  gitOriginUrl: string | null;
  archiveState: LocalHistoryArchiveState;
  hasUserMessage: boolean;
  source: LocalHistorySourceFingerprint;
}

export type LocalHistoryUserEvent = {
  type: "user";
  text: string;
} & BaseStreamEventFields;

export type LocalHistoryEvent = StreamEvent | LocalHistoryUserEvent;

export interface LocalHistoryYield {
  event: LocalHistoryEvent & { eventId: string };
  lineStartOffset: number;
  nextOffset: number;
  /** Disambiguates several normalized events produced from one source record. */
  partIndex: number;
}

export interface LocalHistoryReadOptions {
  fromOffset?: number;
}

export interface LocalHistoryFingerprintOptions {
  sha256?: boolean;
}

export type LocalHistoryErrorCode =
  | "home_missing"
  | "permission_denied"
  | "source_missing"
  | "unsupported_format"
  | "source_changed_during_read"
  | "invalid_session"
  | "io_error";

export class LocalHistoryError extends Error {
  readonly code: LocalHistoryErrorCode;

  constructor(code: LocalHistoryErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "LocalHistoryError";
    this.code = code;
  }
}

export interface LocalHistoryOps {
  probe(options?: LocalHistoryProbeOptions): Promise<LocalHistoryProbeResult>;
  discover(options?: LocalHistoryDiscoverOptions): AsyncIterable<LocalHistorySession>;
  read(
    session: LocalHistorySession,
    options?: LocalHistoryReadOptions,
  ): AsyncIterable<LocalHistoryYield>;
  fingerprint(
    session: LocalHistorySession,
    options?: LocalHistoryFingerprintOptions,
  ): Promise<LocalHistorySourceFingerprint>;
}
