/**
 * The approval policy and sandbox a Codex app-server thread runs with.
 *
 * `codex app-server` reads root `-c key=value` overrides but drops the
 * interactive flags (`--sandbox`, `--dangerously-bypass-approvals-and-sandbox`):
 * they belong to the TUI, and the `app-server` subcommand never receives them
 * (codex-rs `cli/src/main.rs`, verified on 0.160). Sessions spawned with those
 * flags ran on Codex's own defaults instead: approvals `on-request` and a
 * `workspace-write` or `read-only` sandbox, whatever the host asked for.
 *
 * So the policy is set twice, through the two channels app-server does read:
 * the `-c` overrides at spawn (every thread the process runs, child agents and
 * resumed threads included) and the `thread/start` / `thread/resume` params
 * (the root thread, explicitly, so a resumed thread created under different
 * settings takes the current ones).
 *
 * It matters beyond the sandbox. Under `never` with full disk access, Codex
 * approves MCP and app tool calls itself (`mcp_permission_prompt_is_auto_approved`
 * in codex-rs `codex-mcp`). Under `on-request` it asks the client first, through
 * `mcpServer/elicitation/request`.
 */

import type { ProviderConfig } from "../../types.js";

export type CodexSandboxMode = "read-only" | "workspace-write" | "danger-full-access";

export interface CodexThreadPermissions {
  /** Unset leaves Codex's configured default (`on-request` unless the user changed it). */
  approvalPolicy?: "never";
  /** Unset leaves Codex's configured default, which depends on the folder's trust. */
  sandbox?: CodexSandboxMode;
}

/**
 * Plan mode wins over `skipPermissions`, as it does for the spawn flags:
 * read-only, with approvals left on so an escalation still reaches the host.
 * Anything else leaves Codex's defaults, which is what no flag ever meant.
 */
export function codexThreadPermissions(
  config: Pick<ProviderConfig, "planMode" | "skipPermissions"> | undefined,
): CodexThreadPermissions {
  if (config?.planMode) return { sandbox: "read-only" };
  if (config?.skipPermissions) return { approvalPolicy: "never", sandbox: "danger-full-access" };
  return {};
}

/** The same settings as root `-c` overrides, placed before the `app-server` subcommand. */
export function codexPermissionConfigArgs(permissions: CodexThreadPermissions): string[] {
  const args: string[] = [];
  if (permissions.approvalPolicy) args.push("-c", `approval_policy="${permissions.approvalPolicy}"`);
  if (permissions.sandbox) args.push("-c", `sandbox_mode="${permissions.sandbox}"`);
  return args;
}

/** The same settings as `thread/start` / `thread/resume` params. */
export function codexPermissionThreadParams(permissions: CodexThreadPermissions): Record<string, unknown> {
  return {
    ...(permissions.approvalPolicy ? { approvalPolicy: permissions.approvalPolicy } : {}),
    ...(permissions.sandbox ? { sandbox: permissions.sandbox } : {}),
  };
}
