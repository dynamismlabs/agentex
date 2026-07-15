# @agentex/agent

Programmatic execution of AI coding agents. Spawn and manage Claude Code, Codex, Gemini, Cursor, OpenCode, Pi, OpenClaw, or any CLI-based agent as a child process with streaming output, multi-turn sessions, auth detection, isolated workspaces, skill installation, and a unified interface.

## Install

```bash
npm install @agentex/agent
```

Node.js >= 20.19. Each provider requires its CLI to be installed and on `$PATH`. The Codex session adapter additionally requires **codex-cli 0.130.0 or newer** (the `app-server` subcommand); older CLIs will fail with `unexpected argument '--json'`.

## Quick Start

```typescript
import { getProvider } from "@agentex/agent";

const claude = getProvider("claude");

const result = await claude.execute({
  prompt: "Add error handling to server.ts",
  config: {
    skipPermissions: true,
    maxTurns: 5,
    timeoutSec: 120,
  },
  onEvent: (event) => {
    if (event.type === "assistant") process.stdout.write(event.text);
    if (event.type === "tool_call") console.log(`Tool ${event.name} (toolCallId=${event.toolCallId})`);
    // event.sessionId, event.messageId, event.eventId are populated per-provider
  },
});

console.log(result.status);     // "completed"
console.log(result.summary);    // "Added try/catch to all route handlers..."
console.log(result.durationMs); // 12340
console.log(result.costUsd);    // 0.0342
console.log(result.usage);      // { "claude-sonnet-4-6": { inputTokens: 1200, outputTokens: 350, costUsd: 0.0342, ... } }
console.log(result.stopReason); // "end_turn"
console.log(result.numTurns);   // 3
console.log(result.rateLimits); // [{ status: "allowed", ... }]
console.log(result.raw);        // the final provider-native event, verbatim (escape hatch)
```

## Built-in Providers

Providers fall into three tiers:

- **Tier 1 — deep native:** `claude`, `codex`. Hand-built adapters over each CLI's richest protocol (Claude's stream-json, Codex's `app-server` JSON-RPC). Subscription-native, fullest feature set.
- **Tier 2 — ACP:** `gemini`, `copilot`, plus any agent registered via [`acpProvider`](#custom--byok-providers) or `extends: "acp"` config. One shared, tested base over the open [Agent Client Protocol](https://agentclientprotocol.com) (JSON-RPC over stdio).
- **Tier 3 — bespoke escape hatches:** `opencode` (authenticated HTTP/SSE daemon), `pi` (persistent RPC), `cursor` (exec-backed resume), `openclaw` (HTTP gateway), `process` (any executable).

| Provider   | Transport                              | Tier | Sessions  | Modes | Permissions |
| ---------- | -------------------------------------- | ---- | --------- | ----- | ----------- |
| `claude`   | `claude` CLI stream-json               | 1    | ✅ resume | —     | ✅          |
| `codex`    | `codex app-server` JSON-RPC            | 1    | ✅ resume | ✅    | ✅          |
| `gemini`   | `gemini --acp` (ACP)                   | 2    | ✅        | ✅    | ✅          |
| `copilot`  | `copilot --acp` (ACP)                  | 2    | ✅        | ✅    | ✅          |
| `opencode` | authenticated `opencode serve` HTTP + SSE | 3 | ✅ resume | ✅ | ✅ |
| `pi`       | persistent `pi --mode rpc`             | 3    | ✅ resume | —     | —           |
| `cursor`   | `cursor-agent` stream-json per turn    | 3    | ✅ resume | probed | —          |
| `openclaw` | HTTP gateway                           | 3    | —         | —     | —           |
| `process`  | any executable                         | 3    | —         | —     | —           |

Cursor sessions are exec-backed. Each `send()` starts one CLI process and promotes the returned Cursor session ID into `--resume` for the next turn. `probeCapabilities()` verifies the selected binary's model catalog and advertised modes. Each execution independently validates the supported stream-json acceptance marker before releasing output. Older Cursor CLIs report `upgrade_required` instead of silently advertising discovery features they do not expose.

OpenCode sessions use a password-authenticated loopback server, SSE events, permission and question reconciliation, durable service-backed history, saved-session discovery and import, runtime model and agent discovery, and upstream provider authentication. `config.mcpServers` remains unsupported for OpenCode because strict isolation from ambient OpenCode MCP configuration is not yet proven.

### OpenCode and Cursor discovery

The static `capabilities` object describes the maximum adapter surface. Use the runtime probe before presenting controls that depend on a particular installed CLI version.

```ts
const opencode = getProvider("opencode");
const runtime = await opencode.probeCapabilities?.({ cwd });
const models = runtime?.capabilities.modelDiscovery?.supported
  ? await opencode.listModels?.({ cwd })
  : [];
const modes = runtime?.capabilities.modes?.supported
  ? await opencode.listModes?.({ cwd })
  : [];

const cursor = getProvider("cursor");
const cursorRuntime = await cursor.probeCapabilities?.({ cwd });
const cursorModels = cursorRuntime?.capabilities.modelDiscovery?.supported
  ? await cursor.listModels?.({ cwd })
  : [];
```

OpenCode model IDs are fully qualified as `provider/model`. Provider-native variants are returned separately on `ProviderModel.variants` and selected with `config.modelVariant`. Cursor models are returned exactly as the installed CLI reports them. Grok therefore appears through Cursor discovery when the account and CLI expose it. There is no separate Grok provider or hard-coded Grok catalog.

Cursor's runtime report claims sessions and resume only when the selected CLI advertises `--print`, `--resume`, and `stream-json` as an explicit `--output-format` value. A generic output-format flag is not enough. A real turn still validates that `system:init` arrives before releasing any output. This keeps discovery non-billable without treating a successful model-list command as proof of the execution protocol.

OpenCode also exposes its upstream providers so an app can build provider-first credential UI without storing keys in agentex:

```ts
const manager = opencode.upstreamProviders!;
const providers = await manager.list({ cwd });
const methods = await manager.authMethods("anthropic", { cwd });
await manager.setApiKey("anthropic", apiKey, { cwd });
```

OAuth uses `beginOAuth()` followed by `completeOAuth()`. Disconnect is capability-gated against the running OpenCode schema. The tested OpenCode 1.3.2 profile uses `DELETE /auth/{providerID}`. Unknown credential-ID schemas are reported unsupported instead of guessing which credential to delete.

Capabilities (sessions, modes, skills, workspaces, MCP, model discovery, quota probing, instructions, concurrent send, cancel queued messages, stop task) are declared on each module's `capabilities` field — check `provider.capabilities` to branch on what's supported. ACP providers set `dynamicCapabilities: true` (their real capability set is negotiated at the ACP `initialize` handshake). Skill-aware providers also report:

- `skillInventory` — `"provider-init"` for Claude's runtime inventory, `"local-discovery"` for Codex, or `"none"`.
- `skillInvocation` — `"native-slash"` for Claude, `"expanded-prompt"` for Codex, `"configured-only"`, or `"unsupported"`.

## Custom / BYOK providers

Three ways to add providers without forking, all behind the same `getProvider` /
`ProviderModule` surface. See [internal-docs/spec-provider-architecture.md](../../internal-docs/spec-provider-architecture.md)
for the design.

**Derived providers (config-extend).** Inherit a built-in with an env / command /
model overlay — the canonical use is pointing Claude at an Anthropic-compatible
gateway:

```ts
import { defineDerivedProvider, registerProvider, loadProvidersFromConfig } from "@agentex/agent";

registerProvider(
  defineDerivedProvider({
    id: "zai",
    extends: "claude",
    env: { ANTHROPIC_BASE_URL: "https://api.z.ai/api/anthropic", ANTHROPIC_AUTH_TOKEN: "…" },
    models: [{ id: "glm-5.1", name: "GLM 5.1" }],
  }),
);

// …or load a whole map from config (also accepts Paseo's `agents.providers` nesting):
loadProvidersFromConfig({
  providers: {
    zai: { extends: "claude", env: { ANTHROPIC_BASE_URL: "…" } },
    "my-gemini": { extends: "acp", command: ["gemini", "--acp"] },
  },
});
```

When the base provider supports durable sessions or service history, the
derived provider keeps that capability without losing its identity. Persisted
records use the derived provider ID, and attachment/resume reapplies the
derived command, environment, mode, cwd, and session parameters. Upstream
provider authentication and disconnect calls also receive the derived runtime
overlay, so an OpenCode provider configured with an isolated credential home
continues to use that store for credential management.

**Per-call endpoint (`config.endpoint`).** When the endpoint is chosen per
session rather than registered up front — e.g. an app that lets each user bring
their own model — set `endpoint` on `ProviderConfig`. The library keeps no state
and stores no config file; you pass the endpoint on the call and it is
translated into whatever the provider's CLI understands, at spawn:

```ts
const session = await getProvider("claude").createSession({
  cwd,
  config: {
    model: "sonnet", // tier alias still works — see modelMap
    endpoint: {
      baseUrl: "https://api.z.ai/api/anthropic",
      authToken: "…",                 // → Authorization: Bearer (or `apiKey` → x-api-key)
      modelMap: { sonnet: "glm-5.1" }, // alias → concrete id on the endpoint
    },
  },
});
```

Translation is per provider (there is no shared wire format):

| Provider | `baseUrl` / auth | `modelMap` |
| --- | --- | --- |
| `claude` | `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN`/`ANTHROPIC_API_KEY` (`headers` → `ANTHROPIC_CUSTOM_HEADERS`) | → `ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU,FABLE}_MODEL` |
| `codex` | synthesized `[model_providers.custom]` block (`base_url`, `wire_api="responses"`, `env_key`) via `-c` overrides; key injected into env. Requires `baseUrl`. | ignored — Codex has no tier aliases; pass a concrete `model` |
| others | ignored (like `allowedTools` on unsupported providers) | — |

`endpoint` is applied once at spawn, so it is per-session / per-`exec`: change it
by starting a fresh `createSession`/`exec` (resume re-applies it), never
mid-session. Set exactly one of `authToken` / `apiKey`.

**Credential hygiene (claude).** When a custom `baseUrl` is set, only the auth in
`endpoint` reaches it — ambient `ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN` from the
host env is not forwarded to the third party, and ambient alternate-routing config
(Bedrock/Vertex/Foundry) is cleared so it can't steer Claude off the endpoint.
Pass auth explicitly. One consequence: an observability-proxy pattern (Helicone /
LangSmith-style, where the proxy forwards using your *own* Anthropic key) no longer
picks up the ambient key — pass it deliberately, e.g.
`endpoint: { baseUrl, apiKey: process.env.ANTHROPIC_API_KEY }`.

**Codex header safety.** Codex header values are passed to the child via env
(`env_http_headers`), never argv, so a secret header (`Authorization`, `X-API-Key`)
doesn't leak through `ps`. Header *names* must be TOML bare keys.

**Codex speaks the Responses API.** Codex removed the Chat Completions
(`wire_api="chat"`) protocol in Feb 2026, so a custom endpoint must implement the
OpenAI Responses API, directly or via a translating gateway (e.g. LiteLLM). Pure
chat-completions endpoints won't work through Codex. If you're pinned to a
pre-Feb-2026 Codex that still needs `chat`, override it on the one-shot `exec`
path with `extraArgs: ["-c", 'model_providers.custom.wire_api="chat"']`.

Prefer derived providers when the same endpoint is reused across many calls (and
for heavy Codex config customization); prefer `config.endpoint` when it varies
per session and the host owns storage. To override the synthesized Codex config,
`extraArgs` is reliable on the one-shot `exec` path (it follows the endpoint
`-c` flags); for sessions, a derived provider is the robust path.

**ACP agents.** Any agent speaking the [Agent Client Protocol](https://agentclientprotocol.com)
is a few lines:

```ts
import { acpProvider, registerProvider } from "@agentex/agent";

registerProvider(acpProvider({ id: "my-agent", command: ["my-agent", "--acp"] }));
```

`acpProvider` also accepts `transformers` (`modes` / `modeId`) to absorb a
specific agent's quirks without forking the base.

**Remote HTTP gateways.** For an "agent behind a URL", `httpAgentProvider` gives
you gateway-URL resolution, session-key round-trip, `auth_required` mapping, and
timeouts:

```ts
import { httpAgentProvider, registerProvider } from "@agentex/agent";

registerProvider(
  httpAgentProvider({ providerType: "my-gw", defaultBaseUrl: "http://localhost:3001", runPath: "/api/agent/run" }),
);
```

## Execution Context

Only `prompt` is required. Everything else has sensible defaults.

```typescript
interface ExecutionContext {
  prompt: string;
  model?: string;
  runId?: string;                   // Auto-generated UUIDv7 if omitted
  cwd?: string;                     // Defaults to process.cwd()
  env?: Record<string, string>;
  sessionParams?: Record<string, unknown> | null;
  config?: ProviderConfig;
  signal?: AbortSignal;             // Cancellation — SIGTERM then SIGKILL after graceSec
  onOutput?: (stream: "stdout" | "stderr", chunk: string) => void | Promise<void>;
  onEvent?: (event: StreamEvent) => void | Promise<void>;
  onStart?: (pid: number) => void;
  onLifecycle?: (event: LifecycleEvent) => void;
}
```

`ProviderConfig` covers the knobs most providers accept:

```typescript
interface ProviderConfig {
  command?: string;                 // Override CLI binary path
  model?: string;
  modelVariant?: string;            // OpenCode provider-native variant, separate from effort
  effort?: string;
  unattendedPermissionPolicy?: "allow" | "deny";
  inputRequestTimeoutSec?: number;  // OpenCode permission/question response deadline, default 300
  maxTurns?: number;
  timeoutSec?: number;
  graceSec?: number;
  skipPermissions?: boolean;
  skillDirs?: string[];
  instructionsFile?: string;
  mcpServers?: McpServerConfig[];   // stdio | http | sse — staged as a 0600 file, passed via --mcp-config
  strictMcpConfig?: boolean;        // claude: --strict-mcp-config — MCP surface is exactly what you attach
  allowedTools?: string[];          // claude: --allowed-tools (patterns verbatim; codex ignores)
  disallowedTools?: string[];       // claude: --disallowed-tools (deny wins; codex ignores)
  includePartialMessages?: boolean; // claude: emit assistant_delta/thinking_delta typewriter events
  extraArgs?: string[];             // always appended LAST — hosts can override any generated flag
  search?: boolean;
  sandbox?: boolean;
  thinking?: string;
  mode?: string;                    // cursor: --mode <mode>; not for plan mode
  modeId?: string;                  // select an operating mode from listModes() (codex/ACP)
  planMode?: boolean;               // read-only "plan" mode (claude/codex)
  workspace?: { strategy: "worktree"; baseBranch?: string; branchName?: string };
}
```

MCP servers attach via a generated config file, never argv — http `headers` can
carry bearer tokens and argv is world-readable via `ps`:

```typescript
config.mcpServers = [
  { name: "files", command: "node", args: ["mcp-files.js"] },              // stdio (default)
  { name: "orchestrator", type: "http", url: "http://localhost:4100/mcp",  // http/sse
    headers: { Authorization: "Bearer …" } },
];
config.strictMcpConfig = true; // nothing else leaks in
```

## Execution Result

```typescript
interface ExecutionResult {
  runId: string;
  exitCode: number | null;
  signal: string | null;
  status: ExecutionStatus;          // "completed" | "failed" | "aborted" | "timeout" | "blocked"
  startedAt: string;                // ISO timestamp
  completedAt: string;
  durationMs: number;
  errorMessage: string | null;
  errorCode: string | null;
  usage?: Record<string, ModelUsage>;  // keyed by model ID
  costUsd: number | null;
  model: string | null;
  summary: string | null;
  sessionParams: Record<string, unknown> | null;
  sessionDisplayId: string | null;
  clearSession: boolean;
  billingType: "api" | "subscription" | "metered_api" | null;

  // Provider-reported run metadata — populated when the provider emits it.
  // Claude populates all of these; Codex leaves them undefined/null.
  stopReason?: string | null;         // "end_turn" | "max_turns" | "tool_use" | ...
  terminalReason?: string | null;     // CLI's own terminal reason ("completed" | "error" | ...)
  numTurns?: number | null;
  durationApiMs?: number | null;      // Time in model API calls, separate from wall clock
  permissionDenials?: unknown[];      // Claude permission_denials array, verbatim
  rateLimits?: RateLimitInfo[];       // Rate-limit signals observed during the run

  raw?: Record<string, unknown> | null; // True escape hatch: final provider-native event verbatim
  workspace?: PreparedWorkspace;       // Present if config.workspace was set
}

interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;         // Claude cache_read ∪ Codex cached_input_tokens
  cacheCreationInputTokens?: number;  // Claude only
}

interface ModelUsage extends TokenUsage {
  costUsd?: number;                   // Per-model cost (Claude's modelUsage)
  webSearchRequests?: number;
  contextWindow?: number;
  maxOutputTokens?: number;
}

interface RateLimitInfo {
  status: string;                     // "allowed" | "rejected" | ...
  limitType: string | null;           // "five_hour" | "weekly" | ...
  resetAt: string | null;             // ISO timestamp when the window resets
  overageStatus: string | null;
  isUsingOverage: boolean | null;
}
```

Use `aggregateUsage(result.usage)` to collapse per-model usage into a single total.

## Stream Events

Emitted during execution via `onEvent`. Every event carries the same normalized ID set on top of its variant-specific fields:

```typescript
interface BaseStreamEventFields {
  timestamp: string;
  providerType: string;               // "claude" | "codex" | "cursor" | ...
  sessionId: string | null;           // Stable session/thread ID across turns
  messageId: string | null;           // Provider-native message ID
  eventId: string | null;             // Per-event ID (Claude: native uuid; Codex: synthetic — see below)
  turnId: string | null;              // Native turn ID (Codex v2 app-server only; NDJSON & Claude = null)
  parentToolCallId: string | null;    // Sub-agent origin — same namespace as tool_call.toolCallId (Claude only)
  raw: Record<string, unknown>;       // Original provider event verbatim
}
```

Variants:

- `system` — Session init (`subtype`, `model`, `cwd`, `tools`, `permissionMode`). Claude init events also include `slashCommands?: string[]` and `skills?: string[]` when Claude Code reports them.
- `assistant` — Text output from the agent (`text`). Codex also includes an optional `phase: "commentary" | "final_answer"` so progress updates can be distinguished from the terminal answer.
- `assistant_delta` — Incremental assistant text for typewriter UIs (`text`, `blockIndex`). Opt-in via `config.includePartialMessages` (claude). Purely additive: the consolidated `assistant` event still fires when the block completes, with a matching `messageId` so you can reconcile optimistic delta text against the durable event.
- `thinking` — Agent's internal reasoning (`text`)
- `thinking_delta` — Incremental thinking text (`text`, `blockIndex`), same flag, best-effort. On current Claude versions these deltas are the *only* place thinking prose appears — the consolidated thinking block is withheld (signature-only). Treat as advisory UI sugar.
- `tool_call` — Agent invoked a tool (`toolCallId: string | null`, `name`, `input`)
- `unknown` — Fallback for unrecognized wire events (`subtype` = the provider's `type` field). Forward-compat access to new CLI events via `raw` without a library update.
- `tool_result` — Tool returned a result (`toolCallId: string | null`, `toolName: string | null`, `content`, `isError`, `exitCode: number | null`). `toolName` mirrors the matching `tool_call.name` (correlated for you), so you don't need your own `toolCallId → name` cache; null when no preceding `tool_call` was seen on the stream.
- `rate_limit` — Provider reported rate-limit state (`status`, `limitType`, `resetAt`, `overageStatus`, `isUsingOverage`)
- `permission_mode` — Permission mode change mid-session (`permissionMode: string`). Claude only, e.g., when the user accepts a plan and the session leaves `plan` mode.
- `result` — Final result (`text`, `costUsd`, `isError`, `stopReason`, `terminalReason`, `numTurns`, `durationMs`)

Lifecycle events (via `onLifecycle`) report phases: `preparing`, `spawning`, `running`, `waiting_for_input`, `completed`, `cancelled`, `error`.

### What each provider surfaces on stream events

Verified live against `claude 2.1.116` and `codex-cli 0.122.0` (2026-04-21). ACP providers (`gemini`, `copilot`) and the session-backed `opencode`/`pi` emit real, correlated events (assistant / thinking / tool_call / tool_result); `cursor` and `openclaw` still stub most IDs — see the precedence note at the end of this section.

| Field on `StreamEvent` | Claude source                                      | Codex source                                     |
| ---------------------- | -------------------------------------------------- | ------------------------------------------------ |
| `sessionId`            | `session_id` (UUID, stable across turns + resume)  | `thread_id` (UUIDv7, emitted once on `thread.started`, tracked across lines) |
| `messageId`            | `message.id` (Anthropic API message, e.g. `msg_*`) | v2 app-server: globally unique (`msg_*`, `rs_*`, `call_*`). NDJSON: `item_N` — **turn-local, not globally unique** |
| `eventId`              | Top-level per-line `uuid`                          | Synthetic where derivable (see below); else null |
| `turnId`               | **null** — Claude doesn't model turns              | v2 app-server: native UUIDv7 from `params.turnId`. NDJSON: **null** — no turn id in legacy format |
| `parentToolCallId`     | `parent_tool_use_id` (set for sub-agent messages)  | **null** — not emitted                           |
| Tool correlation       | `tool_use.id` (`toolu_*`) ↔ `tool_result.tool_use_id`; the library stamps `tool_result.toolName` from the matching call | `item.id` reappears on the same item's `item.completed`; `toolName` set directly from the item type |
| `tool_result.exitCode` | **null** (Claude doesn't expose shell exit codes)  | `item.exit_code` for `command_execution`         |
| Assistant message span | One `message.id` may span multiple event lines (thinking + tool_use emitted separately with distinct `uuid`s) | One `item.completed` per agent message |

On `ExecutionResult`:

| Field              | Claude                                                         | Codex                                                                |
| ------------------ | -------------------------------------------------------------- | -------------------------------------------------------------------- |
| `costUsd`          | ✓ `total_cost_usd`                                             | **always null** — Codex JSONL doesn't report cost                    |
| `usage.*.costUsd`  | ✓ per-model from `modelUsage` payload                          | — not available                                                      |
| `usage` cache keys | ✓ `cachedInputTokens` + `cacheCreationInputTokens`             | ✓ `cachedInputTokens` only (maps from `cached_input_tokens`)         |
| `model`            | ✓ from `system.init` / `message.model`                         | **null from stdout** — falls back to the requested model            |
| `raw.stopReason`   | ✓ `result.stop_reason`                                         | — not emitted                                                        |
| `raw.terminalReason` | ✓ `result.terminal_reason`                                   | — not emitted                                                        |
| `raw.numTurns`     | ✓                                                              | — not emitted                                                        |
| `raw.rateLimits`   | ✓ parsed from `rate_limit_event` events                        | — not emitted                                                        |
| `raw.permissionDenials` | ✓ `result.permission_denials`                             | — not emitted                                                        |
| `raw.finalEvent`   | ✓ the `result` event verbatim                                  | ✓ the `turn.completed` / `turn.failed` / `error` event verbatim     |
| Per-model breakdown | ✓ multiple models can appear — Claude quietly calls haiku alongside the main model for summarization | single requested model only |

### Storing events in a database

For Claude, `eventId` is a safe unique key for a per-event row. `messageId` is a safe key for "one logical assistant message" — multiple event lines can share it when the message contains both thinking and tool_use blocks.

For Codex, `item.id` values like `item_0`, `item_1` **reset every turn** (including on `codex exec resume`). Do not use them as unique keys on their own. Codex emits no native per-event uuid, so agentex synthesizes documented, replay-stable identities where the components exist:

- **Live v2 session events:** `eventId = codex:<threadId>:<turnId>:<itemId>:<eventType>` when thread + turn + item are all known; null otherwise. This is an **upsert key**, not a uniqueness guarantee — repeated updates to the same item (e.g. streaming text) intentionally share an id; the last write wins.
- **Transcript reads** (`transcript.read()` / `readCodexTranscript`): `eventId = codex:<rolloutSessionId>:<lineStartByteOffset>` — deterministic across reads of the same file, so transcript replays are idempotent.
- The two schemes intentionally **do not match each other** (the live and on-disk wire vocabularies differ — `command_execution` vs `exec_command`). Cross-shape dedup between a live capture and a transcript replay remains a host concern.

When in doubt, `raw` is the verbatim provider event — parse it yourself for anything the normalized fields don't cover.

### Other providers

`gemini` and `copilot` (ACP) and the session-backed `opencode` and `pi` emit real, correlated `StreamEvent`s — assistant text, thinking, and tool_call/tool_result with proper tool-call ids (ACP and Codex have no per-event/message ids, so those stay `null`). `cursor` and `openclaw` still emit the same `StreamEvent` shape with most ids stubbed to `null`; their `raw` field is populated. `cursor` will gain full fidelity when it moves to the ACP tier.

## Sessions (multi-turn)

Providers with `capabilities.sessions = true` (Claude, Codex) can host a persistent session where you send multiple user messages and reuse context across turns.

```typescript
import { getProvider, parseAskUserQuestion } from "@agentex/agent";

const claude = getProvider("claude");
const session = await claude.createSession!({
  cwd: process.cwd(),
  onEvent: (e) => { /* stream events */ },
  onUserInputRequest: async (req) => {
    const q = parseAskUserQuestion(req);
    if (q) return { allow: true, updatedInput: { answers: ["Yes"] } };
    return { allow: true };  // auto-approve other tool calls
  },
});

const { uuid, result } = await session.send("List the API routes in src/");
const turnResult = await result;          // resolves on the next TurnResult
const followUp = await session.send("Now add rate limiting to each one.");
await followUp.result;

await session.close();
```

`session.send()` returns a `SendHandle` with a synchronously-available `uuid` and a `result: Promise<TurnResult>`. `TurnResult` carries `summary`, `usage`, `costUsd`, and a `status` of `completed | failed | max_turns | max_budget | aborted | timeout`. Handle elicitations (MCP forms), hook callbacks, and interrupts through the corresponding `SessionContext` callbacks.

### Bounding a turn (timeout / abort)

`send()` takes an optional `SendOptions` to cap a single turn — the natural shape for scheduled / fire-and-forget runs where a cron firing every minute can't be allowed to run a multi-hour turn:

```typescript
// Hard cap this turn. On fire, the library interrupts the agent and resolves
// `result` with status "timeout" — no consumer-side Promise.race needed.
const { result } = await session.send("Summarize the repo.", { timeoutSec: 90 });
const turn = await result;
if (turn.status === "timeout") { /* mark the run timed-out */ }

// Or abort just this turn (not the whole session) via an AbortSignal.
const ac = new AbortController();
const handle = await session.send("Long task…", { signal: ac.signal });
ac.abort();                       // → result resolves with status "aborted"
```

`SendOptions.timeoutSec` overrides `ProviderConfig.timeoutSec`, which acts as the session-level default when no per-call value is given. The per-send `signal` is distinct from `SessionContext.signal`: the per-send one ends just that turn, the session-level one closes the whole session. Because a session runs a single underlying agent, a timeout/abort interrupts the active turn — so any concurrent sends coalesced into the same turn end with it.

### Concurrent send ("type while the agent is working")

For providers with `capabilities.concurrentSend = true` (Claude, Codex), `session.send()` is callable at any time — including while a previous turn is still running. The underlying CLI's own queue handles ordering: Claude drains queued messages mid-turn as `<system-reminder>` attachments on the next tool-result batch; Codex coalesces them into the active or next turn.

```typescript
// Fire a long-running turn.
const { uuid, result } = await session.send("Run the test suite and fix any failures.");

// User decides they want a tweak — no need to wait for the turn to finish.
await session.send("While you're at it, also add a CHANGELOG entry.");

// Both messages get processed in the same turn (Claude mid-turn drain) or
// adjacent turns (Codex). Both `result` Promises resolve when the turn ends —
// they may resolve to the *same* TurnResult if the CLI coalesces them.
await result;
```

When multiple sends are coalesced into one turn by the CLI, the `result` Promises returned by each `send()` resolve with the **same** `TurnResult` object — callers cannot assume 1:1 correspondence between `send()` calls and `TurnResult`s.

For providers with `concurrentSend = false`, calling `send()` while a turn is in progress throws. Check the capability flag to gate UI:

```typescript
if (provider.capabilities.concurrentSend) {
  // Render the "type while working" textarea.
}
```

### Cancelling a queued message

For providers with `capabilities.cancelQueuedMessage = true` (Claude only), `session.cancel(uuid)` removes a message from the CLI's queue if it hasn't started processing yet.

```typescript
const { uuid } = await session.send("Refactor the auth middleware.");
// ...user changes their mind...
const { cancelled } = await session.cancel(uuid);
if (cancelled) console.log("Pulled the message before the agent started on it.");
else console.log("Too late — the agent already drained it.");
```

`cancel()` is always callable. For providers with `cancelQueuedMessage = false` (Codex, and any session-less provider), it returns `{ cancelled: false }` immediately. For Claude, it sends a `cancel_async_message` control_request to the CLI, which runs `dequeueAllMatching` against its internal queue and reports whether the message was found.

> **Race note.** Cancellation is best-effort. If the CLI drained the message mid-turn (Claude's `query.ts` between-tool-batches drain) before your `cancel()` request landed, you get `{ cancelled: false }` — and the message will be visible to the model as a `<system-reminder>`. The library does not unmount what the model has already seen.

### Stopping one background task

A turn can spawn work that outlives it — a backgrounded shell (`next dev`, a test watcher) or an async subagent. For providers with `capabilities.stopTask = true` (Claude only), `session.stopTask(taskId)` kills **one** such task without disturbing the session or its other tasks. This is distinct from `interrupt()` (ends the whole active turn, and can't reach a detached background process) and `close()` (kills the entire session).

```typescript
// taskId comes from a background-task lifecycle event (see below).
const { stopped } = await session.stopTask(taskId);
if (stopped) console.log("Asked the CLI to kill that task.");
```

`stopTask()` is always callable. For providers with `stopTask = false` it returns `{ stopped: false }` immediately. For Claude it sends a `stop_task` control_request; the **CLI/harness** owns the process and performs the kill (the model is never in the loop). The acknowledgement carries no payload, so `stopped: true` just means "accepted" — an unknown or already-ended `taskId` (or a closed session) yields `{ stopped: false }`. The task's terminal status arrives asynchronously on the event stream as its next `task_updated` / `task_notification`.

Background-task lifecycle events (`task_started`, `task_progress`, `task_updated`, `task_notification`) reach you as `type: "unknown"` StreamEvents (Claude emits them as `system` subtypes; only `system`+`init` gets its own typed variant, so the rest fall through the forward-compat escape hatch with the payload on `raw`). Use `getClaudeTaskDetails(event)` to decode one into typed fields — `{ phase, taskId, taskType, status, usage, … }` — or `null` if it isn't a task event. It's a stateless per-event decode, not a reducer: `status` reflects only the event in hand (and `task_updated` is a sparse `patch`), so collapsing a task's events into one current state over its lifetime is the consumer's job.

```typescript
import { getClaudeTaskDetails } from "@agentex/agent";

createSession({
  onEvent(event) {
    const task = getClaudeTaskDetails(event);
    if (task?.phase === "started") console.log("background task:", task.taskId, task.description);
  },
});
```

### Graceful shutdown with `drain()`

`close()` kills the process (SIGTERM → SIGKILL after `graceSec`, default 5) — fine for "stop now," wrong when a tool is mid-flight. `drain()` is the graceful stop: it refuses new `send()` calls (they throw), waits for any in-flight turn's `result` to settle, then closes. Use it for budget gates, `SIGTERM` handlers, and schedule pauses where a running turn should finish rather than be cut off.

```typescript
process.on("SIGTERM", async () => {
  await session.drain();   // let the current turn finish, then close
});
```

`drain()` is idempotent. Bump `ProviderConfig.graceSec` for sessions running legitimately long tools (test suites, long Bash) so `close()`/`drain()` don't hard-kill them prematurely.

### Reattach after a restart (durable sessions)

Claude and Codex sessions are disk-durable and resumable. Persist one blessed identity object — a `SessionRecord` from `session.describe()` — and after your host restarts, `provider.attachSession(record)` gets you back to it: it locates the on-disk transcript, tells you how the last turn ended, replays the events with checkpointable offsets, and (only when you ask) resumes the session live. Attach is **read-only** — it spawns nothing, and `resume()` is never called automatically. Check `provider.capabilities.durableSessions` first (`true` for `claude`/`codex`).

```typescript
import { getProvider } from "@agentex/agent";
import type { SessionRecord } from "@agentex/agent";

// --- While the session runs: persist its identity once the id is known ---
const provider = getProvider("claude");
const session = await provider.createSession({ cwd, onEvent });
await session.send("start the task");
const record = session.describe();      // null until the session id arrives
if (record) await store.save(record);   // your DB / JSON file — it's plain JSON

// ... host process restarts ...

// --- After restart: reattach from the stored record ---
const saved: SessionRecord = await store.load();
const attachment = await provider.attachSession(saved);

console.log(attachment.lastTurn);       // "completed" | "interrupted" | "unknown"

// Replay what happened while you were gone, checkpointing the offset so the
// next catch-up resumes where this one stopped. The offset is LINE-granular: a
// single Claude line (assistant text + a `tool_use`) yields several events that
// share one offset, so checkpoint only at line boundaries — after a line is
// fully drained — else a crash mid-line would skip that line's remaining events
// on resume. (Codex currently emits one event per line, so today this only bites Claude.)
let checkpoint = store.lastOffset ?? 0;
let lineEnd: number | undefined;        // offset of the line currently being drained
for await (const { event, offset } of attachment.catchUp({ fromOffset: checkpoint })) {
  if (lineEnd !== undefined && offset !== lineEnd) {
    checkpoint = lineEnd;               // a new line started → prior line fully ingested
    await store.saveOffset(checkpoint);
  }
  await ingest(event);                  // same normalized StreamEvent as live onEvent
  lineEnd = offset;
}
if (lineEnd !== undefined) await store.saveOffset(lineEnd); // final line drained

// Continue live only when you decide to — this is exactly createSession + the
// record's params (one resume path). Pending user-input from before the crash
// is gone, so re-prompt when lastTurn === "interrupted".
if (attachment.lastTurn === "interrupted") {
  const live = await attachment.resume({ cwd, onEvent });
  await live.send("continue where we left off");
}
```

Dedup replayed events against anything you saw live: Claude events carry a stable wire `eventId`. File-backed Codex events carry a deterministic synthetic id derived from the rollout session id and line-start byte offset. A runnable end-to-end proof — start a session, crash the host mid-turn, reattach in a fresh process — lives in `scripts/durable-session-demo.ts` (`pnpm demo:durable`).

OpenCode exposes the same host-level recovery shape through service-backed history rather than a local JSONL transcript. Persist `session.describeHistory()`, call `provider.attachHistory(record)`, and checkpoint the opaque `HistoryCheckpoint` returned with each event. `catchUp({ mode: "incremental", after })` resumes after that exact normalized event. `catchUp({ mode: "bounded_full_resync" })` performs a bounded rebuild. OpenCode pagination is capped at 100 pages, 10,000 messages, and 25 MiB so a corrupt or unexpectedly large history cannot exhaust the host.

### Discover and synchronize provider-owned saved history

OpenCode exposes `provider.savedHistory` for import tools that do not yet know
the provider session ids. This provider-neutral API does not expose OpenCode's
database layout, transcript paths, or byte offsets. Discovery uses OpenCode's
authenticated global session API and reading returns opaque provider-owned
checkpoints.

```typescript
import { getProvider, type HistoryCheckpoint } from "@agentex/agent";

const history = getProvider("opencode").savedHistory!;
const presence = await history.probe({ cwd: appRoot });

if (presence.historyAvailable) {
  for await (const session of history.discover({
    cwd: appRoot,             // where Agentex starts the local OpenCode service
    includeArchived: true,
    mainSessionsOnly: true,
    limit: 50,
  })) {
    let checkpoint: HistoryCheckpoint | undefined = await loadCheckpoint(session);
    for await (const item of history.read(session, {
      after: checkpoint,
      mode: "incremental",
    })) {
      await ingest(item.event, item.partIndex);
      checkpoint = item.checkpoint;
      await saveCheckpoint(session, checkpoint); // only after ingest commits
    }
  }
}
```

Saved OpenCode reads include human messages as well as assistant, thinking,
tool, and terminal events. Use
`(providerType, externalSessionId, eventId, partIndex)` as the idempotency key.
If an old checkpoint is no longer present, retry with
`mode: "bounded_full_resync"` and deduplicate using that key.

Discovery is global across OpenCode projects. `cwd` is only runtime context for
starting the authenticated local service. Pass `directory` separately when an
import UI intentionally filters the provider catalog to one project. Root
sessions with a meaningful user message are returned by default. Archived
sessions are included by default and can be excluded with
`includeArchived: false`.

The current OpenCode `/experimental/session` global endpoint is paginated and
bounded at 10,000 sessions and 25 MiB of session metadata. Message history
retains the existing
100-page, 10,000-message, and 25 MiB bounds. A compatibility fallback uses the
older global `GET /session` list for active sessions on older OpenCode builds.
Malformed candidate records and sessions concurrently deleted with a 404 are
skipped without hiding healthy sessions from the catalog. Authentication,
server, network, size-bound, and invalid-response failures abort discovery so
a synchronizing host cannot mistake a partial catalog for an authoritative
empty result.
Discovery's eligibility inspection also shares a 10,000-message and 25 MiB
budget across the complete scan, so many large or damaged candidates cannot
multiply the per-session bound. Checkpoints fingerprint their complete source
message. If OpenCode mutates a still-running tail message after synchronization,
the next incremental read rejects that checkpoint and lets the host perform a
deduplicated bounded full resync.

`savedHistory` is distinct from `attachHistory()`. Saved-history discovery
starts without known ids and includes user prompts for import. Attachment
starts from a persisted `SessionRecord` for a host-owned session and omits user
prompts because the host already owns them.

### Discover local file history when session ids are unknown

Claude and Codex expose `provider.localHistory` for import and migration tools. This is separate from `attachHistory()`: attachment starts from a persisted `SessionRecord`, while local discovery starts with no known session ids.

```typescript
import { getProvider } from "@agentex/agent";

const history = getProvider("claude").localHistory!;
const presence = await history.probe(); // file presence only, no transcript parsing

if (presence.historyAvailable) {
  for await (const session of history.discover({ limit: 50 })) {
    let checkpoint = 0;
    let completedLine: number | undefined;
    for await (const item of history.read(session, { fromOffset: checkpoint })) {
      if (completedLine !== undefined && item.nextOffset !== completedLine) {
        checkpoint = completedLine;
        await saveCheckpoint(checkpoint);
      }
      await ingest(item.event, item.partIndex);
      completedLine = item.nextOffset;
    }
    if (completedLine !== undefined) await saveCheckpoint(completedLine);
    const strongFingerprint = await history.fingerprint(session, { sha256: true });
    await saveFingerprint(strongFingerprint);
  }
}
```

Discovery defaults to main sessions with at least one meaningful human message. Claude nested subagents and sidechains are excluded by default. Pass `mainSessionsOnly: false` to include them with a stable parent-session identity and inherited project context. Codex subagent rollouts, environment context, metadata-only threads, and duplicate active/archive copies are excluded by default. Source files are opened read-only and are never changed.

`discover({ limit })` first orders candidates by filesystem metadata, then inspects transcripts in bounded batches until it finds enough eligible sessions. A limit bounds transcript parsing, not only returned rows.

Strong fingerprints verify the opened file before and after hashing. A strong fingerprint or completed transcript read throws `LocalHistoryError` with code `source_changed_during_read` when the source changes during the operation. Hosts should keep committed line checkpoints and retry from the last completed boundary.

`LocalHistoryYield.event.eventId` identifies the provider source record. Use `(providerType, externalSessionId, eventId, partIndex)` as the normalized-event idempotency key because one JSONL record can produce several events. `nextOffset` is line-aligned, so persist it only after every part for that line commits.

Codex rollout JSONL is the canonical history and checkpoint source. `session_index.jsonl` and compatible SQLite state databases are optional title sources opened read-only. Local history never starts Codex App Server.

## Plan Mode

Run an agent in read-only "plan" mode — it investigates and proposes a plan but cannot edit files or run mutating commands. Same goal in both providers, **different mechanism** in each. Check `provider.capabilities.planMode` before relying on it.

```typescript
import { getProvider, parseExitPlanMode } from "@agentex/agent";

const claude = getProvider("claude");

// 1. Plan run — agent investigates and proposes a plan
const planRun = await claude.execute({
  prompt: "Plan how to add OAuth to the auth middleware.",
  config: { planMode: true },
});

// 2. Resume in execute mode after the user approves the plan
const executeRun = await claude.execute({
  prompt: "Approved. Implement the plan.",
  sessionParams: planRun.sessionParams,   // resume the same session
  config: { planMode: false },             // now allowed to mutate
});
```

### How each provider implements plan mode

| Provider | What we wire                                                         | Where the plan shows up                                                                                       |
| -------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `claude` | `--permission-mode plan` (CLI-native plan UX)                        | Agent calls the `ExitPlanMode` tool with the plan as a permission request. Host extracts via `parseExitPlanMode(req)` from `onUserInputRequest`. The plan is **not** in the persisted transcript — capture it live. |
| `codex`  | `--sandbox read-only` **plus** an injected planning system preamble  | Plain text in the agent's final assistant message (i.e. `result.summary`). |

The mechanism difference matters:

- **Claude** has a deliberate plan-mode UX baked into the CLI: `--permission-mode plan` activates a planning system prompt and wires up the `ExitPlanMode` tool that the host can gate on via `onUserInputRequest`. We pass the flag through and surface the structured plan via `parseExitPlanMode(req)`.

- **Codex** *does* have a native plan mode (one of three collaboration modes — Plan, Pair, Execute — toggled with `/plan` or **Shift+Tab** in the TUI; in plan mode the agent emits a structured plan with steps, files, and acceptance criteria, streamed via `item/plan/delta` and finalized via a `ConsolidateProposedPlan` action). **But Codex's native plan mode is TUI-only as of v0.122.** `codex exec` exposes no `--mode` / `--plan` flag; the official non-interactive reference and config reference document only `plan_mode_reasoning_effort` (effort tuning), not a way to start in plan mode. The collaboration mode is a per-message runtime parameter inside Codex's app-server JSON-RPC protocol, not a CLI startup option.

  So for `codex exec`, native plan mode isn't reachable. We approximate it by combining `--sandbox read-only` (permission boundary — writes are rejected) with a system-prompt preamble that tells the agent to investigate-and-propose rather than attempt-and-fail. The plan lands in the agent's final assistant message (`result.summary`). There's no in-protocol approval gate; the consumer drives the next step manually (typically by showing `result.summary` to the user and re-invoking with `planMode: false` on approval).

  This is a workaround for a missing Codex CLI flag, not a deliberate design choice. If/when Codex exposes its native plan mode through `exec` (e.g. `-c collaboration_mode=plan` or `--mode plan`), we'll switch to that and surface real `item/plan/delta` events.

### Session mode (Claude only — capturing the plan live)

```typescript
const session = await claude.createSession!({
  config: { planMode: true },
  onUserInputRequest: async (req) => {
    const plan = parseExitPlanMode(req);
    if (plan) {
      const approved = await showPlanApprovalUI(plan.plan);
      return { allow: approved };
    }
    return { allow: true };
  },
});
```

For Codex sessions, the plan-mode preamble is sent once via `developerInstructions` at session start and applies to every turn until the session is closed.

### Caveats

- `planMode` and `skipPermissions` are mutually exclusive — if both are set, `planMode` wins and `skipPermissions` is silently ignored.
- Providers with `capabilities.planMode === false` ignore `config.planMode`. OpenCode maps plan mode to its `plan` agent. Cursor maps it to `--mode plan` only when its runtime probe confirms that mode.
- Codex's preamble is a heuristic, not a hard guarantee. The sandbox is the enforcement boundary — even if the agent ignored the prompt and tried to write, the sandbox would reject it. The preamble exists so the agent emits a usable plan instead of a sequence of failed write attempts.

## Auth

`provider.resolveAuth()` is the single entry point for "is this provider usable?" It returns binary status, every supported auth path with a definitive `present: boolean`, and (when the CLI exposes it) rich identity info like email and subscription tier.

Under the hood it prefers the provider's own status subcommand — `claude auth status --json`, `codex login status` — falling back to filesystem heuristics if the binary is missing or too old.

```typescript
import { getProvider, hasSubscription, hasApiKey } from "@agentex/agent";

const claude = getProvider("claude");
const auth = await claude.resolveAuth();

// {
//   providerType: "claude",
//   binary: { installed: true, resolvedPath: "/Users/you/.local/bin/claude", version: "2.1.116" },
//   options: [
//     { method: "api_key",      source: { kind: "env", var: "ANTHROPIC_API_KEY" }, present: false },
//     { method: "bedrock",      source: { kind: "env_combo", vars: [...] },        present: false },
//     { method: "subscription", source: { kind: "cli", command: "claude auth status --json" }, present: true },
//   ],
//   identity: { email: "you@example.com", orgName: "Acme", subscriptionType: "max", authMethod: "claude.ai" },
//   source: "cli",
// }
```

### Sugar helpers (commit to a billing mode explicitly)

There is deliberately no blanket `canRun()` / `isReady()` helper — conflating subscription and API-key auth is a billing footgun (e.g. Claude with `ANTHROPIC_API_KEY` set silently bills metered API even if the user's also subscribed). Callers name the mode they want:

```typescript
await hasSubscription(claude);  // true only if a subscription credential is confirmed present
await hasApiKey(claude);        // true only if an API env var is set
await hasBedrock(claude);       // true only if Bedrock credentials are configured
```

For "any auth works," write it out explicitly at the call site:

```typescript
const anyReady = (await claude.resolveAuth()).options.some((o) => o.present);
```

### Welcome-flow pattern

```typescript
const auth = await claude.resolveAuth();

if (!auth.binary.installed) {
  return showInstallInstructions(auth.binary.error);
}

const sub = await hasSubscription(claude);
const key = await hasApiKey(claude);

if (sub && !key)  return showReady("subscription", auth.identity);
if (key && !sub)  return showReady("api_key");
if (sub && key)   return showReady("api_key", { warning: "api_key_wins" });
return showLoginInstructions();
```

For end-to-end verification (is auth actually good enough to complete a round-trip?), just call `execute()` with a trivial prompt — no separate probe method:

```typescript
await claude.execute({ prompt: "Respond with 'hello'.", config: { timeoutSec: 15 } });
```

### What each provider reports

| Provider  | Subscription source                                             | API key source(s)                          | Other                                                                        |
| --------- | --------------------------------------------------------------- | ------------------------------------------ | ---------------------------------------------------------------------------- |
| `claude`  | `claude auth status --json` · fallback: keychain/creds file     | `ANTHROPIC_API_KEY`                        | Bedrock via `ANTHROPIC_BEDROCK_BASE_URL` or `AWS_ACCESS_KEY_ID`+`AWS_REGION` |
| `codex`   | `codex login status` · fallback: `$CODEX_HOME/auth.json`        | `OPENAI_API_KEY`                           | —                                                                            |
| `gemini`  | `$GEMINI_CONFIG_DIR/oauth_creds.json`                           | `GEMINI_API_KEY`, `GOOGLE_API_KEY`         | —                                                                            |
| `cursor`  | selected CLI's `status` command                                 | `CURSOR_API_KEY`                           | `OPENAI_API_KEY` is intentionally ignored                                   |
| `opencode`| —                                                               | `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`      | —                                                                            |
| `pi`      | —                                                               | `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`      | —                                                                            |

### Precedence (what actually gets used when both are present)

The library reflects real CLI behavior rather than imposing its own:

| Provider  | Winner when both API key and subscription present                       |
| --------- | ----------------------------------------------------------------------- |
| Claude    | API key wins (documented). Set `hasApiKey` + show a billing warning.    |
| Codex     | Subscription wins (current CLI; see openai/codex#2733, #3286).          |
| Gemini    | API key wins in non-interactive mode.                                   |

### Caching

Results are cached for 60s per `(providerType, env, command)` to keep welcome-flow and badge-rendering calls effectively free. Pass `{ fresh: true }` to bypass:

```typescript
await claude.resolveAuth({ fresh: true });
// Or globally:
import { clearAuthCache } from "@agentex/agent";
clearAuthCache();
```

### Auth types

```typescript
type AuthMethod = "api_key" | "bedrock" | "subscription";

type AuthSource =
  | { kind: "env"; var: string }
  | { kind: "env_combo"; vars: string[] }
  | { kind: "file"; path: string }
  | { kind: "keychain"; service: string; account?: string }
  | { kind: "cli"; command: string };

interface AuthOption {
  method: AuthMethod;
  source: AuthSource;
  present: boolean;
}

interface BinaryStatus {
  installed: boolean;
  resolvedPath?: string;
  version?: string;
  error?: string;
}

interface AuthIdentity {
  email?: string;
  orgName?: string;
  subscriptionType?: string;   // "max", "pro", "team", "enterprise"
  authMethod?: string;         // "claude.ai", "chatgpt", "api_key", ...
}

interface AuthReport {
  providerType: string;
  binary: BinaryStatus;
  options: AuthOption[];
  identity?: AuthIdentity;
  source: "cli" | "filesystem";
}
```

## Workspaces (isolated git worktree)

Providers with `capabilities.workspace = true` can run in an isolated `git worktree`, letting you diff or discard the agent's changes without touching your main checkout.

```typescript
import { prepareWorkspace } from "@agentex/agent";

const ws = await prepareWorkspace({ strategy: "worktree", baseBranch: "main" });
const result = await claude.execute({ prompt: "Refactor utils.ts", cwd: ws.cwd });

const patch = await ws.diff();                        // all changes (default)
const summary = await ws.diff({ stat: true });        // --stat summary
const committed = await ws.diff({ scope: "committed" });

await ws.cleanup({ deleteBranch: true });
```

Or pass `config.workspace` to `execute()` and the provider will prepare and attach it — the result's `workspace` field exposes the same handle.

## Parallel Execution

```typescript
import { executeAll } from "@agentex/agent";

const results = await executeAll(
  [
    { provider: "claude", ctx: { prompt: "Review server.ts" } },
    { provider: "codex",  ctx: { prompt: "Review db.ts" } },
  ],
  { cancelOnFailure: true },
);
```

## Skills And Slash Commands

AgentEx supports both skill installation and the higher-level slash-command UI flow:

1. Install or pass skill directories through `config.skillDirs`.
2. Discover rich local metadata for the UI.
3. Reconcile that metadata with the provider runtime inventory when one exists.
4. Invoke the selected skill using provider-appropriate semantics.

### Install Or List Skills

Install and remove reusable agent skills across multiple runtimes at once, into either the user's home or a workspace directory.

```typescript
import { installSkills, listInstalledSkills, removeSkills } from "@agentex/agent";

const skillDirs = ["/path/to/code-review", "/path/to/testing"];

await installSkills(skillDirs, {
  location: "workspace",              // or "global"
  cwd: process.cwd(),                 // required for workspace installs
  includeNativeDirs: false,           // true also installs into ~/.gemini/skills/, etc.
});

const installed = await listInstalledSkills({ location: "workspace", cwd: process.cwd() });
await removeSkills(skillDirs, { location: "workspace", cwd: process.cwd() });
```

Channels and locations follow the emerging `.agents/skills/` + `.claude/skills/` convention — see the `SkillRuntime`, `SkillLocation`, and `SkillChannel` types.

### Install Instruction Files

`installInstructions` is the instruction-file twin of `installSkills`: it drops an orientation brief into the right per-runtime file(s), merging into a **managed region** so any content the user wrote outside the markers is preserved.

```typescript
import { installInstructions, removeInstructions } from "@agentex/agent";

// Workspace (repo-root) install — the common case.
// Writes the brief into {cwd}/CLAUDE.md and {cwd}/AGENTS.md (deduped by filename).
await installInstructions(brief, {
  location: "workspace",      // or "global"
  cwd: process.cwd(),         // required for workspace installs
  includeNativeFiles: false,  // true also writes Gemini's native GEMINI.md
  managed: true,              // wrap in markers + merge (default); false overwrites the file
  managedTag: "agentex",      // marker tag → <!-- agentex:managed:start -->
});

// Global install — per-runtime home files (~/.claude/CLAUDE.md, ~/.codex/AGENTS.md,
// ~/.gemini/GEMINI.md, ~/.config/opencode/AGENTS.md, ~/.pi/AGENTS.md).
await installInstructions(brief, { location: "global" });

// Remove only the managed region; user-authored content (and user-owned files) survive.
await removeInstructions({ location: "workspace", cwd: process.cwd() });
```

Every runtime except Claude reads `AGENTS.md`; Claude reads `CLAUDE.md`. Gemini reads `GEMINI.md` by default (only reads `AGENTS.md` when configured), so it gets a native escape hatch via `includeNativeFiles`. Re-installing unchanged content is idempotent (reported as `skipped`). Use `resolveInstructionTargets(opts)` to see which files *would* be written without touching disk, and `upsertManagedBlock` / `stripManagedBlock` for the low-level merge.

### Discover Slash-Invokable Skills

Use `discoverSkillCommands(...)` to parse local `SKILL.md` files into UI-ready descriptors. It reads frontmatter fields such as `description`, `argument-hint`, and `user-invocable`; if no description is present, it falls back to the first non-empty body paragraph.

```typescript
import {
  discoverSkillCommands,
  reconcileSkillCommands,
  commandInventoryFromEvent,
  invokeSkill,
  getProvider,
  type RuntimeCommandInventory,
} from "@agentex/agent";

const providerType = "claude";
const provider = getProvider(providerType);
const skillDirs = ["/path/to/code-review"];

let inventory: RuntimeCommandInventory | null = null;

const session = await provider.createSession!({
  cwd: process.cwd(),
  config: { skillDirs },
  onEvent(event) {
    inventory ??= commandInventoryFromEvent(event);
  },
});

const { commands, diagnostics } = await discoverSkillCommands({
  cwd: process.cwd(),
  skillDirs,
  runtime: providerType,
});

for (const diagnostic of diagnostics) {
  console.warn(diagnostic.message);
}

const visibleCommands = reconcileSkillCommands({
  discovered: commands,
  inventory,
  provider: providerType,
}).filter((command) => command.available && command.userInvocable);

await invokeSkill(session, visibleCommands[0]!, {
  args: "review the auth changes",
});
```

For a slash menu, render `visibleCommands` and show at least:

- `/${command.name}`
- `command.description`
- `command.argumentHint`
- `command.source`

Ranking/typeahead is host-owned in core v1. A typical UI opens suggestions when the composer starts with `/`, filters by command name and description, inserts `/name ` on selection, and submits through `invokeSkill(...)`.

### Provider Semantics

Claude Code exposes runtime names in its `system/init` event as `slash_commands` and `skills`. AgentEx parses those into `event.slashCommands` and `event.skills`, and `commandInventoryFromEvent(...)` normalizes them. For Claude, `reconcileSkillCommands(...)` marks provider-slash commands unavailable when the running session did not report them.

Claude invocation uses native slash dispatch:

```typescript
await invokeSkill(session, command, { args: "focus on regressions" });
// sends: /command-name focus on regressions
```

Claude Code then resolves the slash command, expands `SKILL.md`, substitutes arguments, and applies provider-native metadata.

Codex does not currently expose a runtime slash/skill inventory through AgentEx. For Codex, discovered skills default to expanded-prompt invocation:

```typescript
await invokeSkill(codexSession, command, {
  args: "review src/server.ts",
  userRequest: "Focus on missing tests.",
});
```

AgentEx reads the skill body, substitutes supported argument placeholders, wraps it with skill metadata, and sends the expanded prompt as the turn input. If Codex later exposes native slash dispatch, AgentEx can switch that command's `execution.kind` to `provider-slash` without changing host UI code.

## Temporary Config Override

Run a CLI with a throwaway config directory (useful for injecting system prompts or custom settings without touching the user's real home).

```typescript
import { withTempConfig } from "@agentex/agent";

const cfg = await withTempConfig({
  runtime: "codex",
  seedFromDefault: true,                          // optional: copy ~/.codex into the temp dir
  overrides: { "config.toml": "model = \"o3\"\n" },
});

await codex.execute({ prompt: "...", env: cfg.env });
await cfg.cleanup();
```

## AskUserQuestion / Elicitation / Hooks

Sessions can surface three distinct user-input requests. Handle each via a `SessionContext` callback:

- `onUserInputRequest` — tool permission requests (and interactive tools like Claude's `AskUserQuestion`). Use `parseAskUserQuestion(req)` to detect structured question payloads and return answers via `updatedInput`.
- `onElicitation` — MCP servers asking the host to render a form or open a URL (`form` / `url` modes, with a JSON-Schema `requestedSchema`).
- `onHookCallback` — CLI requesting the host to run a registered hook.

## Custom Providers

```typescript
import { registerProvider } from "@agentex/agent";
import type { ProviderModule } from "@agentex/agent";

const myProvider: ProviderModule = {
  type: "my-agent",
  capabilities: {
    sessions: false,
    modelDiscovery: false,
    quotaProbing: false,
    mcp: false,
    skills: false,
    instructions: false,
    workspace: false,
  },
  async execute(ctx) {
    const startedAt = new Date().toISOString();
    // Spawn your agent, stream events via ctx.onEvent...
    return {
      runId: ctx.runId ?? "generated-id",
      exitCode: 0,
      signal: null,
      status: "completed",
      startedAt,
      completedAt: new Date().toISOString(),
      durationMs: 0,
      errorMessage: null,
      errorCode: null,
      costUsd: null,
      model: null,
      summary: "Done",
      sessionParams: null,
      sessionDisplayId: null,
      clearSession: false,
      billingType: null,
    };
  },
  async resolveAuth() {
    return {
      providerType: "my-agent",
      binary: { installed: true },
      options: [],
      source: "filesystem",
    };
  },
};

registerProvider(myProvider);
```

## API Reference

### Registry
- `getProvider(type)` — look up a registered provider. Throws if unknown.
- `listProviders()` — list all registered provider type names.
- `registerProvider(module)` — register a custom provider.

### Execution
- `provider.execute(ctx)` — run a single turn.
- `provider.createSession?(ctx)` — start a multi-turn session (when `capabilities.sessions`).
- `executeAll(tasks, { cancelOnFailure?, signal? })` — run multiple executions concurrently.

### Auth
- `provider.resolveAuth(ctx?)` — structured report: binary status, all auth paths, identity. Cached 60s; pass `{ fresh: true }` to bypass.
- `hasSubscription(provider, ctx?)` / `hasApiKey(provider, ctx?)` / `hasBedrock(provider, ctx?)` — presence sugar.
- `clearAuthCache()` — invalidate the resolveAuth cache globally (e.g. after a login).
- `detectAuth(providerType, env)` — legacy env-only auth classification used internally for `ExecutionResult.billingType`.

### Binary / runtime
- `findBinary(name, configOverride?)` — resolve a provider CLI on disk.
- `ensureCommandResolvable(command)` — like `findBinary` but accepts an absolute path too.
- `clearBinaryCache()` — invalidate the binary-resolution cache.
- `provider.checkQuota?(ctx)` — rate-limit / quota status (when `capabilities.quotaProbing`).
- `provider.listModels?(opts?)` — enumerate models the binary can drive. Currently no built-in provider implements this: none of the Claude / Codex / Gemini CLIs expose a non-interactive model-listing subcommand yet (run `pnpm list-models` to re-probe). Pass the model you want directly via `ExecutionContext.model` or `ProviderConfig.model`.

### Workspace
- `prepareWorkspace({ strategy, baseBranch?, branchName?, targetDir? })` → `PreparedWorkspace` with `cwd`, `diff()`, `cleanup()`.

### Skills
- `installSkills(skillDirs, opts?)` / `removeSkills(skillDirs, opts?)` / `listInstalledSkills(opts?)`
- `resolveSkillsHome(channel)` / `resolveSkillsWorkspace(channel, cwd)`
- `resolveNativeSkillsHome(runtime)` / `resolveNativeSkillsWorkspace(runtime, cwd)`
- `ensureSkillSymlink(...)`
- `commandInventoryFromEvent(event)` — extract provider-reported slash/skill names from a `system/init` event.
- `discoverSkillCommands({ cwd?, skillDirs?, includeInstalled?, runtime? })` — parse local `SKILL.md` metadata into `SkillCommandDescriptor[]`.
- `reconcileSkillCommands({ discovered, inventory?, provider, appCommands? })` — merge app commands and apply provider runtime availability.
- `formatSlashInvocation(command, args?)` — build `/name args` text.
- `invokeSkill(session, command, options?)` — send native slash text for `provider-slash` commands or an expanded prompt for `expanded-prompt` commands.
- `buildExpandedSkillPrompt(command, options?)` — construct the expanded-prompt payload without sending it.

### Runtime config
- `withTempConfig({ runtime, seedFromDefault?, overrides? })` → env + configDir + cleanup.
- `getRuntimeHomeEnvVar(runtime)` / `getDefaultRuntimeHome(runtime)` — introspect each CLI's home dir override.

### Utilities
- `aggregateUsage(usage)` — collapse `Record<string, TokenUsage>` to a single total.
- `renderTemplate(template, ctx)` — `{{var}}` interpolation.
- `redactEnvForLogs(env)` — redact sensitive values before logging.
- `resolveInstructions(path?)` — read an instructions file, or `null` if no path.
- `installInstructions(content, opts?)` / `removeInstructions(opts?)` — write/remove a managed instruction brief across per-runtime files (`CLAUDE.md` / `AGENTS.md` / native `GEMINI.md`), workspace or global.
- `resolveInstructionTargets(opts?)` — list which instruction files would be written, without touching disk.
- `upsertManagedBlock(existing, content, opts?)` / `stripManagedBlock(existing, opts?)` — low-level managed-region merge/strip (preserves content outside the markers).
- `getDefaultRuntimeHome(runtime, homeDir?)` — pass `homeDir` to resolve against a sandboxed base instead of `os.homedir()`.
- `parseAskUserQuestion(req)` — extract structured question/option data from a `UserInputRequest`.
- `parseExitPlanMode(req)` — extract the proposed plan text from an `ExitPlanMode` permission request (Claude plan mode).

## Requirements

- Node.js >= 18
- Each provider's CLI installed and resolvable on `$PATH` (`claude`, `codex`, `gemini`, `agent` for Cursor, `opencode`, `pi`, or a reachable OpenClaw gateway)
- For subscription auth, the relevant CLI must already be logged in (`codex login`, `claude login`, `gemini auth login`, etc.)

## License

MIT
