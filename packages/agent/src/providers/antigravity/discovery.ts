import type { AgentMode, ListModelsOptions, ListModesOptions, ProviderModel } from "../../types.js";
import { buildEnv, ensurePathInEnv } from "../../utils/env.js";
import { withModelCache } from "../../utils/model-cache.js";
import { runChildProcess } from "../../utils/process.js";
import { isAgyAuthRequired } from "./parse.js";
import { ANTIGRAVITY_MODES, AGY_SIGN_IN_MESSAGE, findAgyBinary } from "./runtime.js";

function rec(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function fromJson(output: string): ProviderModel[] | null {
  try {
    const parsed = JSON.parse(output) as unknown;
    const list = Array.isArray(parsed) ? parsed : rec(parsed)["models"];
    if (!Array.isArray(list)) return null;
    return list.map((value) => {
      if (typeof value === "string") return { id: value, name: value };
      const model = rec(value);
      const id = [model["slug"], model["id"], model["model"]].find((v): v is string => typeof v === "string" && v.length > 0) ?? "";
      const name = [model["display_name"], model["displayName"], model["name"], model["label"]]
        .find((v): v is string => typeof v === "string" && v.length > 0);
      return { id, name: name ?? id };
    }).filter((model) => model.id);
  } catch {
    return null;
  }
}

/**
 * Parse `agy models`. The JSON form is preferred when a build supports it;
 * the text form is one model per line: a slug, two or more spaces, then the
 * display name, for example `gemini-3.1-pro-high     Gemini 3.1 Pro (High)`.
 */
export function parseAntigravityModels(output: string): ProviderModel[] {
  const trimmed = output.trim();
  if (!trimmed) return [];
  const json = trimmed.startsWith("{") || trimmed.startsWith("[") ? fromJson(trimmed) : null;
  if (json?.length) return json;

  const seen = new Set<string>();
  const models: ProviderModel[] = [];
  for (const raw of trimmed.split(/\r?\n/)) {
    const line = raw.replace(/^\s*(?:[*•>-]|→)\s*/, "").trim();
    if (!line || /^(?:available\s+)?models?:?$/i.test(line) || /^fetching\b/i.test(line) || line === "...") continue;
    const match = line.match(/^([A-Za-z0-9][\w./:-]*)(?:\s{2,}|\t+)(.+)$/) ?? line.match(/^([A-Za-z0-9][\w./:-]*)$/);
    const id = match?.[1];
    if (!id || seen.has(id) || /^(?:error|warning|usage)$/i.test(id)) continue;
    seen.add(id);
    const name = match?.[2]?.replace(/\s*\((?:current|default|selected)\)\s*$/i, "").trim();
    models.push({ id, name: name || id });
  }
  return models;
}

export async function listAntigravityModels(options: ListModelsOptions = {}): Promise<ProviderModel[]> {
  return withModelCache("antigravity", options, options.cacheTtlMs, () => discoverAntigravityModels(options));
}

async function discoverAntigravityModels(options: ListModelsOptions): Promise<ProviderModel[]> {
  const resolved = await findAgyBinary(options);
  const env = buildEnv(options.env);
  ensurePathInEnv(env);
  const cwd = options.cwd ?? process.cwd();
  let lastOutput = "";
  for (const args of [["models", "--output-format", "json"], ["models"]]) {
    const result = await runChildProcess({
      runId: "antigravity-model-discovery",
      command: resolved.bin,
      args: [...resolved.prefixArgs, ...args],
      cwd,
      env,
      timeoutSec: 20,
    });
    lastOutput = `${result.stdout}\n${result.stderr}`;
    if (isAgyAuthRequired(lastOutput)) {
      throw new Error(AGY_SIGN_IN_MESSAGE);
    }
    if (result.exitCode !== 0) continue;
    const models = parseAntigravityModels(result.stdout);
    if (models.length) return models;
  }
  const detail = lastOutput.split(/\r?\n/).map((line) => line.trim()).find((line) => /error/i.test(line));
  throw new Error(detail ?? "The installed Antigravity CLI did not list any models");
}

/** Antigravity's modes are a fixed set (`--mode`); listing them spawns nothing. */
export async function listAntigravityModes(_options: ListModesOptions = {}): Promise<AgentMode[]> {
  return ANTIGRAVITY_MODES.map((mode) => ({ ...mode }));
}
