# Migration Guide

## 0.0.x → 0.1.0

One breaking change area: the auth surface. Execution APIs (`provider.execute`, `provider.createSession`, workspaces, skills, etc.) are unchanged.

### `testEnvironment` removed

`provider.testEnvironment()` and the `EnvironmentTestContext` / `EnvironmentTestResult` / `EnvironmentCheck` types are gone. The method was trying to do three unrelated things:

1. Check if the binary is installed.
2. Check if auth is configured.
3. Run a live hello probe to verify end-to-end.

(1) and (2) are now both answered by the enriched `provider.resolveAuth()`. (3) has no library method — do it in your app with the real API:

```typescript
await provider.execute({ prompt: "Respond with 'hello'.", config: { timeoutSec: 15 } });
```

### `resolveAuth()` is the single entry point

Before:

```typescript
const result = await provider.testEnvironment({ providerType: "claude" });
// result.status, result.checks, result.auth
```

After:

```typescript
const report = await provider.resolveAuth();
// report.binary, report.options, report.identity, report.source
```

### `AuthReport` shape changed

Added: `binary: BinaryStatus`, optional `identity: AuthIdentity`, required `source: "cli" | "filesystem"`.

`AuthOption.present` is now strictly `boolean`. The previous `"unknown"` third state (used for macOS keychain) is gone — the new CLI-status approach gives definitive truth, and the filesystem fallback reports `false` when it can't verify.

```typescript
// Before
interface AuthOption {
  method: AuthMethod;
  source: AuthSource;
  present: boolean | "unknown";
}

// After
interface AuthOption {
  method: AuthMethod;
  source: AuthSource;  // new kind: "cli"
  present: boolean;
}
```

If you had code branching on `"unknown"`, it's now dead — drop those branches.

### New: `AuthSource` `cli` kind

Subscription options now frequently come from a CLI call rather than filesystem inspection:

```typescript
{ kind: "cli", command: "claude auth status --json" }
```

### New: `identity` on `AuthReport`

Rich user info from the CLI, when available:

```typescript
report.identity
// { email: "you@example.com", orgName: "Acme", subscriptionType: "max", authMethod: "claude.ai" }
```

Populated for Claude (always, when `claude auth status --json` succeeds) and Codex (limited — just `authMethod`). Not populated for Gemini/Cursor/OpenCode/Pi.

### Cache behavior

`resolveAuth()` now caches results for 60s per `(providerType, env, command)`. Pass `{ fresh: true }` or call `clearAuthCache()` to invalidate. Old `resolveAuth()` was uncached but effectively instant; the new one spawns the CLI so the cache matters.

### Custom providers must drop `testEnvironment` and add `resolveAuth`

```typescript
// Before
const myProvider: ProviderModule = {
  // ...
  async testEnvironment(ctx) {
    return {
      providerType: ctx.providerType,
      status: "pass",
      auth: { providerType: ctx.providerType, options: [] },
      checks: [],
      testedAt: new Date().toISOString(),
    };
  },
};

// After
const myProvider: ProviderModule = {
  // ...
  async resolveAuth() {
    return {
      providerType: "my-agent",
      binary: { installed: true },
      options: [],
      source: "filesystem",
    };
  },
};
```

### Codex billing fix

`ExecutionResult.billingType` for Codex runs was incorrectly predicting `"api"` whenever `OPENAI_API_KEY` was set. Real Codex CLI behavior prefers the stored subscription over the env var (see openai/codex#2733, #3286). The library now stats `$CODEX_HOME/auth.json` before predicting, so `billingType` reflects what Codex will actually use at runtime.

No action needed — results are now more accurate.

### New exports

- `findBinary`, `ensureCommandResolvable`, `clearBinaryCache`, `ResolvedBinary` — for callers who want to check CLI installation separately.
- `clearAuthCache` — invalidate the 60s resolveAuth cache (e.g. after a login).
- `BinaryStatus`, `AuthIdentity` — new types.
