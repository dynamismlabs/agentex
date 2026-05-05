import * as path from "node:path";

/** Assert `value` is a non-empty string. */
export function assertNonEmpty(value: string, label: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
}

/** Assert `value` is a non-empty absolute path. */
export function assertAbsolutePath(value: string, label: string): void {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  if (!path.isAbsolute(value)) {
    throw new Error(`${label} must be an absolute path (got: ${value})`);
  }
}

/** Assert `value` is a non-empty relative path with no `..` segments. */
export function assertRelativePosixPath(value: string, label: string): void {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  if (path.isAbsolute(value)) {
    throw new Error(`${label} must be a path relative to source (got absolute: ${value})`);
  }
  if (value.includes("..")) {
    throw new Error(`${label} must not contain '..' segments (got: ${value})`);
  }
}
