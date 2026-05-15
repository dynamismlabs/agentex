import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AgentSession, StreamEvent, TurnResult } from "../types.js";
import { listInstalledSkills } from "./skills.js";

export type SkillCommandSource = "configured" | "installed-user" | "installed-workspace" | "app";

export type SkillCommandExecution =
  | {
      kind: "provider-slash";
      provider: string;
      commandText: string;
    }
  | {
      kind: "expanded-prompt";
      provider: string;
    };

export interface SkillCommandDescriptor {
  id: string;
  name: string;
  /** Frontmatter description. Discovery falls back to the first non-empty body paragraph. */
  description?: string;
  argumentHint?: string;
  source: SkillCommandSource;
  /** Skill directory for discovered commands. Expanded-prompt invocation also accepts a direct SKILL.md path. */
  sourcePath?: string;
  userInvocable: boolean;
  /**
   * Whether this command should be offered for invocation in the current host/session.
   *
   * Discovery defaults this to true. `reconcileSkillCommands` narrows Claude
   * provider-slash commands against the runtime inventory, while Codex,
   * expanded-prompt, and app commands pass through unchanged.
   */
  available: boolean;
  execution: SkillCommandExecution;
}

export interface RuntimeCommandInventory {
  provider: "claude" | "codex" | string;
  sessionId?: string | null;
  slashCommands: string[];
  skills: string[];
  source: "provider-init" | "configured" | "none";
  raw?: unknown;
}

export interface SkillCommandDiagnostic {
  level: "warning" | "error";
  path?: string;
  message: string;
}

export interface DiscoverSkillCommandsOptions {
  cwd?: string;
  skillDirs?: string[];
  includeInstalled?: false | "workspace" | "user" | "all";
  runtime?: "claude" | "codex" | string;
}

export interface DiscoverSkillCommandsResult {
  commands: SkillCommandDescriptor[];
  diagnostics: SkillCommandDiagnostic[];
}

export interface ReconcileSkillCommandsOptions {
  discovered: SkillCommandDescriptor[];
  inventory?: RuntimeCommandInventory | null;
  provider: "claude" | "codex" | string;
  appCommands?: SkillCommandDescriptor[];
}

export interface InvokeSkillOptions {
  args?: string;
  userRequest?: string;
  provider?: "claude" | "codex" | string;
}

type ParsedSkillFile = {
  body: string;
  frontmatter: Record<string, string>;
};

type DiscoveredSkillSource = Exclude<SkillCommandSource, "app">;

type CollectedSkillDir = {
  dir: string;
  source: DiscoveredSkillSource;
};

export function commandInventoryFromEvent(event: StreamEvent): RuntimeCommandInventory | null {
  if (event.type !== "system" || event.subtype !== "init") return null;

  const slashCommands = event.slashCommands ?? readStringArray(event.raw, "slash_commands") ?? [];
  const skills = event.skills ?? readStringArray(event.raw, "skills") ?? [];
  if (slashCommands.length === 0 && skills.length === 0) return null;

  return {
    provider: event.providerType,
    sessionId: event.sessionId,
    slashCommands,
    skills,
    source: "provider-init",
    raw: event.raw,
  };
}

export async function discoverSkillCommands(
  options: DiscoverSkillCommandsOptions,
): Promise<DiscoverSkillCommandsResult> {
  const diagnostics: SkillCommandDiagnostic[] = [];
  const runtime = options.runtime ?? "claude";
  const skillDirs = await collectSkillDirs(options, diagnostics);
  const commands: SkillCommandDescriptor[] = [];
  const seenNames = new Set<string>();
  const seenRealpaths = new Set<string>();

  for (const { dir, source } of skillDirs) {
    const resolvedDir = path.resolve(dir);
    const realDir = await realpathOrResolved(resolvedDir);
    if (seenRealpaths.has(realDir)) {
      diagnostics.push({
        level: "warning",
        path: resolvedDir,
        message: "Duplicate skill path skipped",
      });
      continue;
    }
    seenRealpaths.add(realDir);

    const command = await commandFromSkillDir(resolvedDir, source, runtime, diagnostics);
    if (!command) continue;
    if (seenNames.has(command.name)) {
      diagnostics.push({
        level: "warning",
        path: resolvedDir,
        message: `Duplicate skill command "${command.name}" skipped`,
      });
      continue;
    }
    seenNames.add(command.name);
    commands.push(command);
  }

  return { commands, diagnostics };
}

/**
 * Merge discovered commands with host app commands and apply provider runtime availability.
 *
 * Today only Claude provider-slash commands are narrowed by runtime inventory.
 * Commands for other providers or execution kinds keep their existing
 * `available` value because AgentEx has no authoritative runtime inventory
 * for them yet.
 */
export function reconcileSkillCommands(options: ReconcileSkillCommandsOptions): SkillCommandDescriptor[] {
  const commands = [...options.discovered, ...(options.appCommands ?? [])];

  if (options.provider !== "claude" || !options.inventory) {
    return commands;
  }

  const availableNames = new Set([
    ...options.inventory.skills,
    ...options.inventory.slashCommands,
  ]);

  return commands.map((command) => {
    if (command.execution.kind !== "provider-slash" || command.execution.provider !== "claude") {
      return command;
    }
    return {
      ...command,
      available: inventoryCandidatesFor(command).some((name) => availableNames.has(name)),
    };
  });
}

export function formatSlashInvocation(command: Pick<SkillCommandDescriptor, "name">, args?: string): string {
  const trimmedArgs = args?.trim() ?? "";
  return trimmedArgs ? `/${command.name} ${trimmedArgs}` : `/${command.name}`;
}

export async function invokeSkill(
  session: AgentSession,
  command: SkillCommandDescriptor,
  options: InvokeSkillOptions = {},
): Promise<TurnResult> {
  if (!command.available) {
    throw new Error(`Skill command "${command.name}" is not available`);
  }
  if (options.provider && options.provider !== command.execution.provider) {
    throw new Error(
      `Skill command "${command.name}" is configured for provider "${command.execution.provider}", not "${options.provider}"`,
    );
  }

  if (command.execution.kind === "provider-slash") {
    return session.send(formatCommandText(command.execution.commandText, options.args));
  }

  const prompt = await buildExpandedSkillPrompt(command, {
    args: options.args,
    userRequest: options.userRequest,
  });
  return session.send(prompt);
}

export async function buildExpandedSkillPrompt(
  command: SkillCommandDescriptor,
  options?: { args?: string; userRequest?: string },
): Promise<string> {
  const skill = command.sourcePath
    ? await readSkill(command.sourcePath)
    : { body: "", skillDir: undefined };
  const args = options?.args?.trim() ?? "";
  const userRequest = options?.userRequest?.trim() ?? "";
  const substitutedBody = substituteSkillArguments(skill.body, args, skill.skillDir);

  const parts = [
    "Use the following skill for this request.",
    "",
    `Skill: ${command.name}`,
  ];

  if (command.description) {
    parts.push(`Description: ${command.description}`);
  }

  parts.push("", "Skill instructions:", substitutedBody || "(No skill body was available.)");

  if (args) {
    parts.push("", "Arguments:", args);
  }
  if (userRequest) {
    parts.push("", "User request:", userRequest);
  }

  return parts.join("\n");
}

async function collectSkillDirs(
  options: DiscoverSkillCommandsOptions,
  diagnostics: SkillCommandDiagnostic[],
): Promise<CollectedSkillDir[]> {
  const dirs = new Map<string, CollectedSkillDir>();
  for (const dir of options.skillDirs ?? []) {
    const resolved = path.resolve(dir);
    dirs.set(resolved, { dir: resolved, source: "configured" });
  }
  if (!options.includeInstalled) return [...dirs.values()];

  const addInstalled = async (
    location: "global" | "workspace",
    source: Extract<SkillCommandSource, "installed-user" | "installed-workspace">,
  ): Promise<void> => {
    const installed = await listInstalledSkills({
      location,
      cwd: options.cwd,
    });
    for (const skills of Object.values(installed)) {
      for (const skill of skills) {
        if (skill.sourcePath) {
          const resolved = path.resolve(skill.sourcePath);
          if (!dirs.has(resolved)) {
            dirs.set(resolved, { dir: resolved, source });
          }
        }
      }
    }
  };

  try {
    if (options.includeInstalled === "user" || options.includeInstalled === "all") {
      await addInstalled("global", "installed-user");
    }
    if (options.includeInstalled === "workspace" || options.includeInstalled === "all") {
      await addInstalled("workspace", "installed-workspace");
    }
  } catch (err) {
    diagnostics.push({
      level: "warning",
      message: `Failed to list installed skills: ${err instanceof Error ? err.message : String(err)}`,
    });
  }

  return [...dirs.values()];
}

async function commandFromSkillDir(
  skillDir: string,
  source: DiscoveredSkillSource,
  runtime: string,
  diagnostics: SkillCommandDiagnostic[],
): Promise<SkillCommandDescriptor | null> {
  const skillFile = path.join(skillDir, "SKILL.md");
  let parsed: ParsedSkillFile;
  try {
    const content = await fs.readFile(skillFile, "utf8");
    parsed = parseSkillFileContent(content);
  } catch (err) {
    diagnostics.push({
      level: "error",
      path: skillFile,
      message: `Failed to read SKILL.md: ${err instanceof Error ? err.message : String(err)}`,
    });
    return null;
  }

  const name = path.basename(skillDir);
  if (!isValidSkillName(name)) {
    diagnostics.push({
      level: "error",
      path: skillFile,
      message: `Invalid skill command name "${name}"`,
    });
    return null;
  }

  return {
    id: `${runtime}:${name}:${skillDir}`,
    name,
    description: parsed.frontmatter["description"] ?? firstBodyParagraph(parsed.body),
    argumentHint: parsed.frontmatter["argument-hint"],
    source,
    sourcePath: skillDir,
    userInvocable: parseBoolean(parsed.frontmatter["user-invocable"], true),
    available: true,
    execution: runtime === "claude"
      ? { kind: "provider-slash", provider: "claude", commandText: `/${name}` }
      : { kind: "expanded-prompt", provider: runtime },
  };
}

function parseSkillFileContent(content: string): ParsedSkillFile {
  const normalized = content.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) {
    return { frontmatter: {}, body: normalized.trim() };
  }

  const end = normalized.indexOf("\n---", 4);
  if (end === -1) {
    return { frontmatter: {}, body: normalized.trim() };
  }

  const frontmatterText = normalized.slice(4, end).trim();
  const bodyStart = normalized.indexOf("\n", end + 1);
  const body = bodyStart === -1 ? "" : normalized.slice(bodyStart + 1).trim();
  return { frontmatter: parseSimpleFrontmatter(frontmatterText), body };
}

function parseSimpleFrontmatter(input: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of input.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf(":");
    if (idx <= 0) continue;
    const key = trimmed.slice(0, idx).trim();
    const value = stripQuotes(trimmed.slice(idx + 1).trim());
    if (key) values[key] = value;
  }
  return values;
}

function stripQuotes(value: string): string {
  if (
    (value.startsWith("\"") && value.endsWith("\"")) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  const normalized = value.trim().toLowerCase();
  if (["true", "1", "yes", "on"].includes(normalized)) return true;
  if (["false", "0", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function firstBodyParagraph(body: string): string | undefined {
  for (const block of body.split(/\n\s*\n/)) {
    const normalized = block
      .split("\n")
      .map((line) => line.trim().replace(/^#+\s*/, ""))
      .filter(Boolean)
      .join(" ")
      .trim();
    if (normalized) return normalized;
  }
  return undefined;
}

function isValidSkillName(name: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9:_-]*$/.test(name);
}

async function readSkill(sourcePath: string): Promise<{ body: string; skillDir: string }> {
  const stat = await fs.stat(sourcePath);
  const skillFile = stat.isDirectory() ? path.join(sourcePath, "SKILL.md") : sourcePath;
  const skillDir = stat.isDirectory() ? sourcePath : path.dirname(sourcePath);
  const content = await fs.readFile(skillFile, "utf8");
  return { body: parseSkillFileContent(content).body, skillDir };
}

async function realpathOrResolved(dir: string): Promise<string> {
  try {
    return await fs.realpath(dir);
  } catch {
    return path.resolve(dir);
  }
}

function substituteSkillArguments(body: string, args: string, skillDir?: string): string {
  return body
    .replace(/\$\{ARGUMENTS\}/g, args)
    .replace(/\$ARGUMENTS\b/g, args)
    .replace(/\$\{CLAUDE_SKILL_DIR\}/g, skillDir ?? "")
    .replace(/\{\{\s*args\s*\}\}/g, args)
    .replace(/\{\{\s*ARGUMENTS\s*\}\}/g, args);
}

function formatCommandText(commandText: string, args?: string): string {
  const trimmedCommand = commandText.trim();
  const trimmedArgs = args?.trim() ?? "";
  return trimmedArgs ? `${trimmedCommand} ${trimmedArgs}` : trimmedCommand;
}

function readStringArray(raw: unknown, key: string): string[] | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const value = (raw as Record<string, unknown>)[key];
  if (!Array.isArray(value)) return undefined;
  return value.filter((item): item is string => typeof item === "string");
}

function inventoryCandidatesFor(command: SkillCommandDescriptor): string[] {
  if (command.execution.kind !== "provider-slash") return [command.name];
  const commandText = command.execution.commandText.trim();
  const slashName = commandText
    .split(/\s+/, 1)[0]
    ?.replace(/^\/+/, "");
  return [...new Set([command.name, slashName].filter((name): name is string => !!name))];
}
