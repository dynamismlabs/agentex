import type { AgentMode, ListModelsOptions, ListModesOptions, ProviderModel } from "../../types.js";
import { buildEnv, ensurePathInEnv } from "../../utils/env.js";
import { runChildProcess } from "../../utils/process.js";
import { findCursorBinary } from "./runtime.js";

function rec(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function parseCursorModels(output: string): ProviderModel[] {
  const trimmed = output.trim();
  if (!trimmed) return [];
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    const values = Array.isArray(parsed) ? parsed : Array.isArray(rec(parsed)["models"]) ? rec(parsed)["models"] as unknown[] : [];
    const models = values.map((value) => {
      if (typeof value === "string") return { id: value, name: value };
      const model = rec(value);
      const id = typeof model["id"] === "string"
        ? model["id"]
        : typeof model["slug"] === "string" ? model["slug"] : "";
      return {
        id,
        name: typeof model["name"] === "string" ? model["name"] : id,
      };
    }).filter((model) => model.id);
    if (models.length) return models;
  } catch {
    // Fall through to the version-aware text parser.
  }

  const seen = new Set<string>();
  const models: ProviderModel[] = [];
  for (const line of trimmed.split(/\r?\n/)) {
    const cleaned = line.replace(/^\s*[-*•]\s*/, "").trim();
    if (!cleaned || /^(available\s+)?models?:?$/i.test(cleaned)) continue;
    const match = cleaned.match(/^([\w./:-]+)(?:\s{2,}|\s+-\s+|\s+\()?(.*)$/);
    const id = match?.[1] ?? "";
    if (!id || seen.has(id) || /^(usage|error|warning)$/i.test(id)) continue;
    seen.add(id);
    const label = match?.[2]?.replace(/[()]$/, "").trim();
    models.push({ id, name: label || id });
  }
  return models;
}

export function cursorModesFromHelp(output: string): AgentMode[] {
  if (!/--mode\b/.test(output)) return [];
  const advertised = new Set<string>();
  const modeLine = output.split(/\r?\n/).find((line) => /--mode\b/.test(line)) ?? "";
  const match = modeLine.match(/--mode[^\n]*(?:<|\[)([^>\]]+)(?:>|\])/i);
  if (match?.[1]) {
    for (const value of match[1].split(/[|,\s]+/)) {
      const mode = value.trim().toLowerCase();
      if (mode) advertised.add(mode);
    }
  }
  const candidates: AgentMode[] = [
    { id: "agent", name: "Agent" },
    { id: "plan", name: "Plan", description: "Read and plan before making changes" },
    { id: "ask", name: "Ask", description: "Answer questions without editing" },
  ];
  for (const candidate of candidates) {
    if (new RegExp(`\\b${candidate.id}\\b`, "i").test(modeLine)) {
      advertised.add(candidate.id);
    }
  }
  return candidates.filter((mode) => advertised.has(mode.id));
}

export async function listCursorModels(options: ListModelsOptions = {}): Promise<ProviderModel[]> {
  const resolved = await findCursorBinary(options);
  const env = buildEnv(options.env);
  ensurePathInEnv(env);
  const cwd = options.cwd ?? process.cwd();
  const attempts = [
    ["models", "--output-format", "json"],
    ["models", "--json"],
    ["--list-models"],
    ["models"],
  ];
  for (const args of attempts) {
    const result = await runChildProcess({
      runId: "cursor-model-discovery",
      command: resolved.bin,
      args: [...resolved.prefixArgs, ...args],
      cwd,
      env,
      timeoutSec: 15,
    });
    if (result.exitCode !== 0) continue;
    const models = parseCursorModels(result.stdout || result.stderr);
    if (models.length) return models;
  }
  throw new Error("The installed Cursor CLI does not expose model discovery");
}

export async function listCursorModes(options: ListModesOptions = {}): Promise<AgentMode[]> {
  const resolved = await findCursorBinary(options);
  const env = buildEnv(options.env);
  ensurePathInEnv(env);
  const result = await runChildProcess({
    runId: "cursor-mode-probe",
    command: resolved.bin,
    args: [...resolved.prefixArgs, "--help"],
    cwd: options.cwd ?? process.cwd(),
    env,
    timeoutSec: 10,
  });
  const output = `${result.stdout}\n${result.stderr}`;
  return cursorModesFromHelp(output);
}
