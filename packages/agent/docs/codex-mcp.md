# Codex MCP configuration

Agent Ex 0.0.43 supports host-supplied MCP servers in `execute()`, `createSession()`, and resumed Codex threads. The selected Codex CLI must be 0.160.0 or newer. Older or unverifiable runtimes fail explicitly when MCP configuration is requested; no inference session starts with silently missing connectors.

```typescript
const session = await getProvider("codex").createSession!({
  cwd: projectPath,
  config: {
    mcpServers: [
      {
        name: "ri_orchestrator",
        type: "http",
        url: "http://127.0.0.1:42241/mcp",
        headers: {
          Authorization: `Bearer ${localToken}`,
          "X-Session-Credential": signedSessionCredential,
        },
      },
      { name: "local_files", command: "node", args: ["files-mcp.js"], env: { API_TOKEN: localFilesToken } },
    ],
    strictMcpConfig: true,
  },
  onElicitation: async (request) => showMcpForm(request),
});
```

Use the actual signed credential header name expected by your server. HTTP transport means streamable HTTP. Codex does not support the legacy `sse` arm of `McpServerConfig`; that configuration is rejected.

## Isolation and configuration

- Supplying `mcpServers` defaults Codex to strict isolation, including an explicitly empty array.
- `strictMcpConfig: true` without servers disables all ambient configured MCP servers.
- `strictMcpConfig: false` retains the user's configured servers alongside the attached servers.
- Omitting both options preserves the existing ambient Codex behavior.
- Host names must be unique and nonempty. `codex_apps` is reserved. A name that already exists in ambient configuration is rejected, even if disabled, because native config merging could otherwise inherit its transport, credentials or per-tool policy. Choose a distinct host name.

Codex merges user, project, profile and managed config layers. An empty `mcp_servers` table does not remove inherited servers. Agent Ex reads the effective inventory through bounded `codex mcp list --json` calls, emits disabled registrations for ambient servers, then verifies the final enabled set before starting the session. This includes plugin-derived configured servers: a disabled config registration vetoes the same-name plugin registration in the verified runtime. Disabled servers can remain visible in Codex's status inventory; they have no initialized connection or model-visible tools.

Config overrides are placed before `app-server` or `exec`, including on resume. Caller config flags from `extraArgs` are included in discovery and precede the final MCP security overrides. If inventory discovery fails, a requested host server is blocked by policy, or an unrelated server remains enabled under strict isolation, startup fails with a credential-safe error. Native inventory stdout/stderr is not forwarded to user callbacks.

MCP-configured resumes explicitly select the working directory used for inventory discovery. Supply the original project as `cwd`, or retain the `cwd` in restored `sessionParams` when omitting the context's `cwd`. This prevents an old thread from loading unverified servers from another project. Use the context's `cwd` and `ProviderConfig.workspace` for project selection; `--cd`/`-C` and `--worktree` in `extraArgs` are rejected when MCP configuration is requested because native inventory does not apply those runtime options.

`CODEX_HOME` is never replaced. No user config file is rewritten, so subscription auth, history and existing native settings continue to use the original home. Every invocation gets its own environment-variable names; concurrent sessions cannot overwrite one another's MCP credentials.

This option isolates **configured MCP servers**. Codex's native ChatGPT apps integration is separate and retains its existing configuration and approval behavior. This release does not change that integration's enablement or connected-account scope.

## Credentials and stdio environment

HTTP bearer auth uses `bearer_token_env_var`. Other headers use `env_http_headers`. Only variable references enter native `-c` overrides; the values exist in the spawned Codex environment. Embedded URL user/password credentials are rejected; put authentication in headers.

Stdio servers without environment overrides retain their command and arguments directly. When a server has `env`, a small Node transport launcher receives the command, arguments and environment through a unique child-only variable, overlays that server's environment, removes Agent Ex's credential variables before launching the server, and forwards shutdown signals. This preserves different values for two servers using the same environment key without exposing those values in argv or changing the host process environment. No temporary credential file is created.

Commands, plain stdio arguments and public URLs are configuration visible in argv. Supply credentials through `headers` or stdio `env`.

## Permissions and names

Host-supplied servers receive `default_tools_approval_mode = "approve"`. If Codex still emits a tool-approval request for one of them, Agent Ex accepts it without calling `onUserInputRequest`. The host server must enforce its own tool policy, including any ask-first/write confirmation. Other server and ChatGPT app approvals still reach the host normally. Form/URL elicitations from all servers, including host-owned ones, still go to `onElicitation` and are declined when no handler exists.

Normalized tool events and approval names retain `mcp__<server>__<tool>` with the existing Codex name sanitizer. The actual model-visible namespace can also depend on native Codex configuration; consuming apps should use the normalized events for correlation rather than inventing another naming scheme.

## Evidence and validation

Verified against installed `codex-cli 0.160.0` and the matching upstream release source at commit `a956835d020762cb2b570053af06f643a11c0ecc`:

- Native server keys and approval settings: [official MCP documentation](https://learn.chatgpt.com/docs/extend/mcp?surface=cli), [configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference), and `codex-rs/config/src/mcp_types.rs`.
- Layer merging and quoted literal server keys: `codex-rs/config/src/merge.rs` / `overrides.rs`. The generated inline table preserves names containing dots without relying on CLI dotted-path parsing.
- Read-only inventory including plugins: `codex-rs/cli/src/mcp_cmd.rs` and `codex-rs/core/src/config/mod.rs`.
- Disabled registration vetoes: `codex-rs/codex-mcp/src/catalog.rs`.
- The selected app-server schema exposes `mcpServerStatus/list` and `mcpServer/tool/call`, allowing discovery and local tool verification without inference.

The opt-in repository check is `pnpm --filter @agentex/agent exec tsx scripts/smoke-codex-mcp.ts`. It uses local HTTP/stdio test servers, verifies both HTTP auth headers and the stdio environment, checks strict configured-MCP isolation, resumes the same thread with the newly supplied server configuration and an explicit project cwd, checks stdio process cleanup, and checks that the user's config bytes remain unchanged. The test persists its baseline thread by injecting local history without inference, then archives its own test threads. It calls no Ri or connected-account tool and sends no inference prompt. Existing durable chats can receive host servers after restarting their Agent Ex session with the new configuration; a new chat is not required by this native path.

Unit and transport tests cover exact config/env references, no secret in argv, strict on/off/empty behavior, native failures and malformed inventories, unexpected enabled servers, collisions, old versions, per-server/per-session environment isolation, new/resumed sessions and executions, and approval/elicitation compatibility. Ri registry/dependency changes and production deployment are downstream application work, outside this Agent Ex release change.
