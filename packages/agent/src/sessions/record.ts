import type { SessionRecord } from "../types.js";

/**
 * Current `SessionRecord.version`. Bumped only on a breaking shape change;
 * `isSessionRecord` / `assertSessionRecord` validate against it so a host can
 * detect a record written by an incompatible library version.
 */
export const SESSION_RECORD_VERSION = 1 as const;

/**
 * Thrown when a value that should be a `SessionRecord` is malformed. Branch on
 * it; don't parse. Mirrors `MalformedProviderConfigError` — `path` names the
 * offending field when known.
 */
export class MalformedSessionRecordError extends Error {
  readonly path?: string;
  constructor(message: string, path?: string) {
    super(message);
    this.name = "MalformedSessionRecordError";
    this.path = path;
  }
}

/** Inputs for {@link createSessionRecord}. */
export interface CreateSessionRecordInput {
  /** Provider type (registry key) that owns this session. */
  providerType: string;
  /** Codec-serialized session params (e.g. `{sessionId, cwd?}`). */
  params: Record<string, unknown>;
  /** Working directory the session ran in — transcript-lookup hint. */
  cwd?: string | null;
  /** Human-facing id (`sessionCodec.getDisplayId`), for UIs/logs. */
  displayId?: string | null;
}

/**
 * Build a `SessionRecord`, stamping `version` and a fresh `updatedAt`. This is
 * the one blessed way to mint a record outside of `session.describe()`.
 */
export function createSessionRecord(input: CreateSessionRecordInput): SessionRecord {
  return {
    version: SESSION_RECORD_VERSION,
    providerType: input.providerType,
    params: input.params,
    cwd: input.cwd ?? null,
    displayId: input.displayId ?? null,
    updatedAt: new Date().toISOString(),
  };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Structural guard for a `SessionRecord`. Tolerant of extra keys (a host may
 * persist the record inside a larger row and read it back). Does not mutate.
 */
export function isSessionRecord(v: unknown): v is SessionRecord {
  if (!isPlainObject(v)) return false;
  if (v["version"] !== SESSION_RECORD_VERSION) return false;
  if (typeof v["providerType"] !== "string" || v["providerType"].length === 0) return false;
  if (!isPlainObject(v["params"])) return false;
  if (v["cwd"] !== null && typeof v["cwd"] !== "string") return false;
  if (v["displayId"] !== null && typeof v["displayId"] !== "string") return false;
  if (typeof v["updatedAt"] !== "string") return false;
  return true;
}

/**
 * Assert `v` is a well-formed `SessionRecord`, narrowing the type. Throws
 * `MalformedSessionRecordError` naming the first offending field.
 */
export function assertSessionRecord(v: unknown): asserts v is SessionRecord {
  if (!isPlainObject(v)) {
    throw new MalformedSessionRecordError("session record must be an object");
  }
  if (v["version"] !== SESSION_RECORD_VERSION) {
    throw new MalformedSessionRecordError(
      `session record version must be ${SESSION_RECORD_VERSION}; got ${JSON.stringify(v["version"])}`,
      "version",
    );
  }
  if (typeof v["providerType"] !== "string" || v["providerType"].length === 0) {
    throw new MalformedSessionRecordError(
      "session record providerType must be a non-empty string",
      "providerType",
    );
  }
  if (!isPlainObject(v["params"])) {
    throw new MalformedSessionRecordError("session record params must be an object", "params");
  }
  if (v["cwd"] !== null && typeof v["cwd"] !== "string") {
    throw new MalformedSessionRecordError("session record cwd must be a string or null", "cwd");
  }
  if (v["displayId"] !== null && typeof v["displayId"] !== "string") {
    throw new MalformedSessionRecordError(
      "session record displayId must be a string or null",
      "displayId",
    );
  }
  if (typeof v["updatedAt"] !== "string") {
    throw new MalformedSessionRecordError(
      "session record updatedAt must be an ISO timestamp string",
      "updatedAt",
    );
  }
}
