import { describe, it, expect } from "vitest";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

/**
 * §7.4 — Executable proof of `sideEffects: false` + no cross-module side
 * effects: bundling a single-util import from the barrel must tree-shake the
 * entire provider registry away. If any module-scope side effect survived
 * (e.g. a cross-module `registerAcpFactory`, or `sideEffects` left unset), the
 * bundler would be forced to retain `providers.set(...)` / `claudeProvider`.
 */

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, "..", "..");

describe("tree-shaking", () => {
  it("a one-util barrel import bundles to a tiny, registry-free module", async () => {
    const result = await build({
      stdin: {
        contents: `export { parseAskUserQuestion } from "@agentex/agent";`,
        resolveDir: pkgRoot,
        sourcefile: "probe.ts",
        loader: "ts",
      },
      bundle: true,
      format: "esm",
      platform: "node",
      write: false,
    });
    const out = result.outputFiles[0]!.text;
    expect(out).not.toContain("providers.set");
    expect(out).not.toContain("claudeProvider");
    expect(out.length).toBeLessThan(20_000);
  });
});
