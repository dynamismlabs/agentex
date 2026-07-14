import type {
  BaseStreamEventFields,
  HistoryCheckpoint,
  ProviderRuntimeContext,
  StreamEvent,
} from "../types.js";

/**
 * Provider-neutral discovery options for persisted sessions. Unlike
 * `LocalHistoryDiscoverOptions`, these options do not assume a filesystem
 * source. Providers may satisfy them through a local authenticated service.
 */
export interface SavedHistoryDiscoverOptions extends ProviderRuntimeContext {
  /** Optional provider-session directory filter. `cwd` is runtime context only. */
  directory?: string;
  includeArchived?: boolean;
  mainSessionsOnly?: boolean;
  requireUserMessage?: boolean;
  limit?: number;
}

export interface SavedHistoryProbeOptions extends ProviderRuntimeContext {
  limit?: number;
}

export interface SavedHistoryProbeResult {
  providerType: string;
  /** The provider-owned history source could be reached. */
  sourceAvailable: boolean;
  historyAvailable: boolean;
  /** A bounded source count, not necessarily an eligible-session count. */
  approximateCount?: number;
}

export type SavedHistoryArchiveState = "active" | "archived" | "unknown";

/**
 * Serializable metadata for a provider-owned persisted session. Storage
 * details such as transcript paths, byte offsets, and database layouts are
 * deliberately absent.
 */
export interface SavedHistorySession {
  version: 1;
  providerType: string;
  externalSessionId: string;
  cwd: string | null;
  title: string | null;
  startedAt: string | null;
  updatedAt: string;
  branch: string | null;
  gitOriginUrl: string | null;
  archiveState: SavedHistoryArchiveState;
  hasUserMessage: boolean;
}

export type SavedHistoryUserEvent = {
  type: "user";
  text: string;
} & BaseStreamEventFields;

export type SavedHistoryEvent = StreamEvent | SavedHistoryUserEvent;

export interface SavedHistoryYield {
  event: SavedHistoryEvent & { eventId: string };
  /** Opaque provider-owned bookmark. Persist only after the event commits. */
  checkpoint: HistoryCheckpoint;
  eventId: string;
  /** Disambiguates normalized events that share one provider source part. */
  partIndex: number;
}

export interface SavedHistoryReadOptions extends ProviderRuntimeContext {
  after?: HistoryCheckpoint;
  mode?: "incremental" | "bounded_full_resync";
}

/**
 * Discover and read provider-owned saved sessions when their ids are not yet
 * known. This is the provider-neutral import/synchronization surface. It is
 * separate from `attachHistory`, which starts from a known `SessionRecord`,
 * and from the file-specific `LocalHistoryOps` compatibility API.
 */
export interface SavedHistoryOps {
  probe(options?: SavedHistoryProbeOptions): Promise<SavedHistoryProbeResult>;
  discover(options?: SavedHistoryDiscoverOptions): AsyncIterable<SavedHistorySession>;
  read(
    session: SavedHistorySession,
    options?: SavedHistoryReadOptions,
  ): AsyncIterable<SavedHistoryYield>;
}

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
