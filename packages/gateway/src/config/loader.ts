import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { substituteEnvVars } from "../utils/env-substitution.js";
import { validateConfig } from "./schema.js";
import type { LoadConfigOptions } from "./types.js";
import type { GatewayConfig } from "../types.js";

/**
 * Load, validate, and return a {@link GatewayConfig}.
 *
 * 1. If `configPath` is provided, read and parse the YAML file.
 * 2. Run environment-variable substitution on all string values.
 * 3. Deep-merge any programmatic `overrides` on top (overrides take precedence).
 * 4. Validate (and apply defaults) via the Zod schema.
 */
export function loadConfig(opts: LoadConfigOptions = {}): GatewayConfig {
  const { configPath, overrides } = opts;

  let raw: Record<string, unknown> = {};

  if (configPath) {
    const content = readFileSync(configPath, "utf-8");
    const parsed: unknown = parseYaml(content);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      raw = parsed as Record<string, unknown>;
    } else if (parsed === null || parsed === undefined) {
      // Empty YAML file — treat as empty config
      raw = {};
    } else {
      throw new Error(`Config file must be a YAML mapping, got ${typeof parsed}`);
    }
  }

  // Environment variable substitution on YAML values
  const substituted = substituteEnvVars(raw);

  // Merge programmatic overrides (take precedence over YAML)
  const merged =
    overrides && Object.keys(overrides).length > 0
      ? deepMerge(substituted, overrides)
      : substituted;

  // Validate with Zod (applies defaults)
  return validateConfig(merged);
}

// ---------------------------------------------------------------------------
// Deep merge helper
// ---------------------------------------------------------------------------

function isPlainObject(val: unknown): val is Record<string, unknown> {
  return val !== null && typeof val === "object" && !Array.isArray(val);
}

/**
 * Recursively merge `source` into `target`.
 * Arrays and primitives in `source` replace values in `target`.
 * Plain objects are merged recursively.
 */
function deepMerge(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...target };

  for (const key of Object.keys(source)) {
    const srcVal = source[key];
    const tgtVal = result[key];

    if (isPlainObject(srcVal) && isPlainObject(tgtVal)) {
      result[key] = deepMerge(tgtVal, srcVal);
    } else {
      result[key] = srcVal;
    }
  }

  return result;
}
