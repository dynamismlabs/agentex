# Context and provider capacity telemetry

Agent Ex exposes three independent measurements:

| Measurement | Meaning | Public surface |
| --- | --- | --- |
| Run/turn accounting | Tokens and cost reported for work performed | Existing `TokenUsage`, `ModelUsage`, `TurnResult.usage`, `ExecutionResult.usage` |
| Session context | Occupancy of the conversation's effective context window | `ContextUsage`, `context_usage`, `session.contextUsage` |
| Provider capacity | Independent allowances funding requests in an account, workspace, model family, or provider pool | `RateLimitSnapshot`, `rate_limits`, `session.rateLimits` |

Historical billed tokens do not measure current context. Cached input still occupies context; repeated prompts, compaction, restores, and model changes make summing turns incorrect. No adapter substitutes cumulative accounting for context occupancy or hardcodes model capacities.

## Read and refresh

```ts
import { getProvider, type ContextUsage, type RateLimitSnapshot } from "@agentex/agent";

const provider = getProvider("claude");
const session = await provider.createSession!({
  cwd: process.cwd(),
  onEvent(event) {
    if (event.type === "context_usage") {
      const context: ContextUsage = event.usage;
      console.log(context.model, context.usedTokens, context.capacityTokens);
    }
    if (event.type === "rate_limits") {
      // A notification can update only some buckets. Read the merged store below.
      console.log(event.update.mode, event.update.snapshot.buckets);
    }
  },
});

try {
  // Synchronous, isolated cache reads. These never contact the harness/provider.
  const before = session.contextUsage?.getSnapshot();
  const cached = session.rateLimits?.getSnapshot({ maxAgeMs: 120_000 });

  // Explicit, bounded native reads where the selected runtime/auth supports them.
  const context = await session.contextUsage?.refresh?.();
  const capacity = await session.rateLimits?.refresh?.();
  if (context?.status === "fresh") console.log(context.value);
  if (capacity?.status === "fresh") {
    const snapshot: RateLimitSnapshot = capacity.value!;
    for (const bucket of snapshot.buckets) {
      console.log(bucket.id, bucket.applicability, bucket.usedPercent, bucket.resetAt);
    }
  }
} finally {
  await session.close();
}
```

Static capabilities (`contextUsage`, `rateLimits`, `contextUsageRefresh`, `rateLimitsRefresh`) describe adapter paths. `provider.probeCapabilities?.({ cwd, env, config })` explicitly verifies the selected native runtime/auth context where a probe exists. Probes can perform native control/account reads and spawn short-lived harnesses; they never send an inference prompt. Claude/Codex handshake or telemetry read failures degrade only the affected telemetry capabilities, never `binary.status` or session availability. Binary resolution and Codex's independent MCP version check retain their own semantics. Matching concurrent probes share in-flight work; completed reports are not cached. Session observations are authoritative for what actually arrived. ACP context support starts `unknown` until the agent emits the optional standard.

A native session's refresh method can initially exist while support is `unknown`, allowing a bounded discovery read. `refreshSupported` becomes true only after actual source support is established. An unsupported response disables further reads (`refreshSupported: false`); calling that existing method again returns the unsupported snapshot. Concurrent refreshes of the same surface on a session share one promise/request. The context and capacity transports are independent; a combined native event is parsed once into independent stores. Closing the session settles pending controls, stops automatic reads, and marks retained data unavailable/stale.

After a successful explicit Claude context refresh, the session also reads the native summary at subsequent result, compaction/reset, and model-init boundaries. This keeps the opted-in context snapshot current without an inference or token-count API call. Codex and ACP consume their native context notifications directly. Snapshot reads themselves never enable or trigger refresh.

## Read account capacity without a session

Since 0.0.44, Claude and Codex implement `provider.readRateLimits?(ctx)` separately from `probeCapabilities`. `RateLimitReadContext` extends `ProviderRuntimeContext` (`cwd`, `env`, `config`) with optional `signal: AbortSignal` and `timeoutMs`. No session is created and no probe is required:

```ts
import { getProvider, type RateLimitReadContext } from "@agentex/agent";

const controller = new AbortController();
const ctx: RateLimitReadContext = {
  cwd: process.cwd(),
  // env/config select the same runtime and auth context as the app's session.
  timeoutMs: 10_000,
  signal: controller.signal,
};
const result = await getProvider("claude").readRateLimits?.(ctx);
if (result?.value) {
  // TelemetryObservation<RateLimitUpdate>, not a session snapshot surface.
  console.log(result.value.mode); // "replace"
  console.log(result.value.snapshot.observedAt);
  for (const bucket of result.value.snapshot.buckets) {
    console.log(bucket.id, bucket.applicability, bucket.usedPercent, bucket.resetAt);
  }
}
```

The value is the same authoritative normalized `replace` update an explicit session capacity read emits. It describes the collection returned by the native source, including independent account, model-family/pool and credit/enforcement buckets where supplied; it does not promise native fields the provider omits. Each bucket retains its own timestamp and reset. An already expired reset produces `status: "stale"` and `bucket.stale: true` without changing the measured usage. An explicitly empty collection is a successful observation. Unsupported auth/methods return `unsupported`; timeout, cancellation, transport failure or missing/malformed data return `unavailable` with a safe reason and no value. Other built-in providers omit `readRateLimits`.

The deadline defaults to 10,000 milliseconds and is capped at 60,000. Nonpositive/nonfinite `timeoutMs` rejects with `RangeError` before spawning. Matching concurrent reads share one native process; a caller's abort or deadline affects only that caller while others remain. When the last caller leaves, it waits for bounded process cleanup (SIGTERM, then SIGKILL after one second). Every completed/failed read closes its process, and the in-flight operation has a 60-second ceiling. Agent Ex keeps no completed-result cache and does not mutate an existing session's telemetry store.

Deduplication is per operation (read or probe), selected provider/command, cwd, canonical config, effective environment/home/endpoint, and native auth-file revision. Values are compared through a process-private keyed digest, not logged or exposed as keys. Credential files are fingerprinted by filesystem metadata without reading tokens. Native credentials held only in external keychains cannot be independently fingerprinted; there is no durable auth/result cache. Returned `authContextId` is opaque and read-local, not a credential or reusable account id. Scope an app's cache by its own selected provider/auth context; preserve native `accountId` where reported. Runtime config's `command` and environment select the harness; turn instructions, extra argv, MCP servers, skills and hooks are not installed for an account read. Custom endpoints are unsupported for native plan allowance.

Codex performs app-server **initialize → account/read (`refreshToken: false`) → account/rateLimits/read**, only for service-backed `account.type: "chatgpt"`. It sends no thread/start/resume or turn request, so no conversation is written to Codex history. API-key, Bedrock and other auth types are unsupported. Claude performs headless control **initialize → get_usage (`skip_behaviors: true`)** with `--no-session-persistence`, `--setting-sources ""`, strict empty MCP configuration and no prompt. The skip flag avoids the unrelated transcript/behavior scan. Both use the session telemetry normalizers/redaction; native error text, environment and credentials are never returned as diagnostic metadata.

For an app's hover-to-refresh UI, read only when its cached capacity is stale, retain old numbers with an updating indicator, and replace the cache only when a value arrives. Failed/unsupported reads do not prove zero usage or available capacity. Probe scheduling, cache lifetime and display policy belong to the consuming app.

## Unknown, unavailable, and stale data

`TelemetryObservation<T>` contains `support`, `status`, `value`, `refreshSupported`, and an optional safe `reason`.

| State | Interpretation |
| --- | --- |
| `support: "unsupported"`, `status: "unsupported"` | The selected adapter/protocol/auth context cannot provide this measurement |
| `support: "unknown"`, `status: "unobserved"` | An optional signal has not demonstrated support yet |
| `support: "supported"`, `status: "unobserved"` | A supported source has not produced a snapshot yet |
| `status: "unavailable"` | A source/read failed or returned no observation; `value` may retain prior data with stale buckets |
| `status: "fresh"` | An observation is within the requested age threshold and has not been invalidated |
| `status: "stale"` | Age, transport closure, context invalidation, or a bucket reset has invalidated freshness |

An absent optional numeric field means unknown. `usedTokens: 0` and `usedPercent: 0` are measured zero. `value: null` is no snapshot; `value.buckets: []` is an explicitly reported empty collection. Neither absence nor emptiness proves available capacity.

Freshness defaults to 60 seconds and is evaluated at read time. Pass `maxAgeMs` to choose another threshold (`Infinity` disables age expiry), and `now` for a replay/test clock. Every bucket retains its own `observedAt` and gets its own `stale` flag on reads. One fresh bucket does not refresh other buckets. An expired `resetAt` makes the old observation stale; it never invents a newly measured zero.

## Bucket identity, applicability, and enforcement

Bucket ids are opaque. Keep them as keys without decoding or depending on today's windows/model names. Durations are milliseconds and resets/timestamps are ISO strings. Absolute `used`, `remaining`, and `limit` have a `unit` only when native data supplies them (for example `USD`, `credits`, or `provider_credits`). Claude extra-usage amounts with a native currency retain minor units (`USD:minor` means cents); they are not mislabeled as dollars or divided into another unit. Stream fractions and control percentages are normalized to `usedPercent` without clamping values above 100.

Ownership (`owner.kind`, optional `owner.id`) is separate from applicability:

- `all_models`: a provider-established shared allowance.
- `models`: explicit native model ids.
- `model_family`: a provider-established family, including future members.
- `provider_pool`: an opaque native pool; membership is not guessed from model names.
- `unknown`: the provider did not establish applicability.

For example, Claude's `five_hour`, `seven_day`, and `seven_day_opus` can apply simultaneously. The Opus bucket remains an Opus family allowance without enumerating current model releases. A future native model-scoped display label is preserved as an opaque pool rather than guessed into a family. Never add percentages or select a single reset from independent buckets.

`enforcement`, `overage`, `credits`, and snapshot-level `ordinaryUsageAllowed` preserve reported native state. A warning/rejection is not derived from missing metrics. Native future fields survive in sanitized additive `metadata`. Credential-like fields and bearer/basic credential strings are removed from telemetry metadata. Existing `StreamEvent.raw` remains the provider-native escape hatch with its existing trust/redaction contract; consumers should not log it indiscriminately.

`rate_limits` carries `RateLimitUpdate`: `merge` updates only supplied buckets; `replace` denotes an authoritative collection; `removedBucketIds` removes only explicit native removals. `replacedCollectionIds` can replace an authoritative subset identified by each bucket's opaque `collectionId`, while leaving unrelated buckets alone. In partial Claude reports, an explicitly empty `model_scoped` list clears only that collection; an omitted, null, or filtered list does not. Explicit control reads use `replace` for the collection the native source returns. Older partial updates cannot overwrite newer observations, remove newer buckets, or revive an explicitly removed collection/bucket. Account changes clear unrelated buckets. Every session/auth transport has its own opaque `authContextId`; there is no process-global quota cache. Native auth-change notifications invalidate account observations and fence in-flight reads from the previous auth context. External credential/endpoint changes should use a new session unless the harness reports an auth change; no undocumented credential polling is performed.

Codex pool-level spend control is retained in a separate enforcement bucket even when numerical windows or credits are also present and individual-limit metrics are absent. Its `enforcement.allowed` describes that reported control; it does not override other simultaneous allowance buckets. Transport closure or a failed stdin write makes retained observations stale and disables refresh, including unexpected ACP exits.

## Support matrix

Support is for Agent Ex's selected transport, not every interface offered by a product.

| Provider / transport | Current context | Provider capacity | Explicit refresh | Execute and replay |
| --- | --- | --- | --- | --- |
| Codex app-server | `thread/tokenUsage/updated`: `last.totalTokens`, effective `modelContextWindow` | `account/rateLimits/updated` and authenticated `account/rateLimits/read`; all limit ids/windows, credits, native enforcement | Capacity only; runtime method and service-backed auth gated; custom endpoints/API-key/Bedrock auth do not claim ChatGPT quotas | Execute uses exact-session native rollout observations; context is restored, quota rows must belong to the current run. Read-only attachment/history preserves native historical telemetry |
| Claude Code stream-json/control | Native `get_context_usage` summary; structured `context_usage` when emitted | `rate_limit_event`, including `unifiedWindows`; native `get_usage` plan windows, model-scoped rows, extra usage | Context and capacity on supporting CLI/auth; controls are experimental and gated by real responses | Execute captures emitted native telemetry; no source means unobserved. Attachment/history preserves telemetry only when native records actually contain it |
| Generic ACP (including built-in ACP harnesses) | Optional standard `session/update` `usage_update` (`used`, `size`, optional cumulative session cost) | Unsupported by the standard selected here | None | Live/execute consume actual emissions; no claim that a particular harness emits the optional standard |
| Google Antigravity (`agy` headless stream-json) | Unsupported: no verified signal in selected headless transport | Unsupported: TUI status-line quota feed is not a headless integration | None | Existing `result.usage` remains run accounting |
| Cursor native stream-json | Unsupported: no verified effective-context signal | Unsupported: no native capacity read verified | None | Existing usage remains accounting; an explicitly configured ACP harness can use the generic optional standard |
| OpenCode native HTTP/SSE and one-shot CLI | Unsupported: accounting/model catalog does not establish current effective context | Unsupported: no provider allowance source verified | None | Existing usage remains accounting; generic ACP support is conditional on actual emissions |
| Pi RPC | Unsupported: selected RPC does not expose its internal extension context helper | Unsupported | None | Existing stats remain accounting |
| Process, OpenClaw, generic HTTP-agent | Unsupported | Unsupported | None | Built-in results report unsupported observations; custom provider surfaces remain optional |

`ExecutionResult.contextUsage` and `ExecutionResult.rateLimitSnapshot` contain final observations captured independently of whether the caller supplies `onEvent`. The legacy `ExecutionResult.rateLimits` array and `rate_limit` events retain compatibility. Read-only `SessionAttachment`/`HistoryAttachment` expose snapshot surfaces without refresh. Historical snapshots retain original timestamps and can be stale. Codex live restore does not import account-unidentified historical quota data into the current auth scope; it waits for a live observation/read.

The old Claude `checkQuota` inferred allowance from authentication configuration. It is deprecated and now returns `available: false`, `detail.measured: false` with a reason, while preserving billing/auth classification. That is unknown allowance, not a measured rejection. `quotaProbing` is false; use the separate session capacity surface or sessionless read.

## Protocol evidence and limits

Verified on 2026-10-09 using non-inference, bounded local checks:

- **Sessionless reads (0.0.44):** the public API returned fresh authoritative snapshots on Claude Code 2.1.295 (eight buckets) and Codex 0.160.0 (three buckets). Before/after filesystem checks found zero new or modified Claude project/session/transcript files and zero new or modified Codex session/archive/history/index files. No prompts were sent. Run `pnpm --filter @agentex/agent exec tsx scripts/telemetry-read-smoke.ts --live` with other native sessions idle to repeat these checks. Claude's [CLI reference](https://code.claude.com/docs/en/cli-reference) documents persistence, MCP and settings-source flags; the vendor SDK publishes `get_usage`/`skip_behaviors`.

- **Codex 0.160.0:** generated app-server TypeScript schema confirms `ThreadTokenUsage { total, last, modelContextWindow }`, dynamic `rateLimitsByLimitId`, window percentages/durations/resets, credits, individual limits, and enforcement fields. An ephemeral native initialize → `account/read` → `account/rateLimits/read` returned service-backed multi-pool data. The cumulative `total` is not used for context. See [app-server documentation](https://learn.chatgpt.com/docs/app-server).
- **ACP SDK 1.7.0:** real SDK transport tests receive idle and active `usage_update` notifications. The previous 0.24.0 validator rejected this new standard before the adapter could parse it, so the SDK dependency was upgraded. See the [session-usage proposal](https://agentclientprotocol.com/rfds/session-usage).
- **Claude Code 2.1.295 / SDK 0.3.295:** the exact persistent headless flags used by Agent Ex successfully served `get_context_usage { detail: "summary" }` and `get_usage { skip_behaviors: true }` without a user prompt. The current [vendor SDK types](https://unpkg.com/@anthropic-ai/claude-agent-sdk@0.3.295/sdk.d.ts) publish both controls; [SDK 0.3.220](https://app.unpkg.com/@anthropic-ai/claude-agent-sdk@0.3.220/files/sdk.d.ts) documents `rate_limit_event`/`SDKRateLimitInfo`. Runtime schema and existing fixtures additionally confirm `unifiedWindows`, beyond that published event type. These controls can evolve: unsupported methods or unavailable auth yield explicit unsupported/unavailable state rather than guessed quotas.
- **Antigravity 1.3.2:** the selected `--input-format stream-json --output-format stream-json` headless path returned native init/result records, and rejected a read-only `control_request` with “stream input message event … is not supported yet.” Its [headless docs](https://www.antigravity.google/docs/cli/headless/) describe init/step_update/result and accounting usage. Its [status-line docs](https://www.antigravity.google/docs/cli/statusline/) describe scripts executed by the interactive TUI from user settings. They do not establish a supported headless context/quota bridge. No global configuration was rewritten and no scraping/credential endpoint was added.
- **Other selected protocols:** [Cursor output docs](https://cursor.com/docs/cli/reference/output-format), [OpenCode server docs](https://opencode.ai/docs/server/), and installed Pi 0.62.0 RPC definitions provide accounting/state but no verified current effective-context/account-capacity source for these adapters. This is a transport limitation, not a claim that the products have no internal data.

Claude's [status-line docs](https://code.claude.com/docs/en/statusline) alone do not prove scripts run under headless stream-json, so this integration uses native stream/control data. The [model configuration docs](https://code.claude.com/docs/en/model-config) do not establish a Fable-specific quota/reset. No Fable window, reset, family membership, or availability is invented; any native bucket or credit enforcement is retained as supplied.

Validation covers source units/timestamps, unknown/malformed/zero/empty values, arbitrary windows and model pools, partial/out-of-order updates, reset expiry, compaction/capacity changes, auth isolation and in-flight fences, immutable snapshot reads, refresh deduplication, SDK delivery, durable replay, execute accounting separation, and process/control cleanup. No inference was used to ask a model for telemetry.
