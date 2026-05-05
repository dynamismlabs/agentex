- Tunnel
- Plugins
- Build out gateway
- Connectors?

## Package exports — CJS consumer ergonomics

`packages/agent/package.json` ships as pure ESM with only `"import"` and
`"types"` conditions. A consumer that imports `@agentex/agent` from CJS source
(the canonical case: a repo without `"type": "module"` running TS via tsx)
hits `ERR_PACKAGE_PATH_NOT_EXPORTED` at static import time — Node's CJS loader
finds no matching condition and refuses to resolve the package.

**Workaround on the consumer side:** dynamic `import('@agentex/agent')`.
Always uses Node's ESM resolver, which matches `"import"` and succeeds.
Flow's CLI (`ai-task-manager/src/cli/commands/skills.ts`) uses this pattern
today. Any other consumer hitting this will need the same dance.

**Fix:** add a `"default"` fallback to the exports condition. On Node 22.12+
(where `require(esm)` is on by default), this makes static CJS imports work
transparently:

```json
"exports": {
  ".": {
    "types": "./dist/index.d.ts",
    "import": "./dist/index.js",
    "default": "./dist/index.js"
  }
}
```

If we commit to this, bump `engines.node` to `>=22.12.0` so the support matrix
is honest — on older Node, `"default"` resolves but `require()` of an ESM file
throws `ERR_REQUIRE_ESM` instead of the current resolution error.

For full compat with Node 18/20, dual-build (ESM + CJS) is the right shape,
but that swaps `tsc` for `tsup` and ships two bundles. Not urgent — the
ecosystem is moving ESM-only.

