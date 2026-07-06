import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

/**
 * §7.2 — Every provider index must import clean as the graph's *entry point*.
 *
 * The historical TDZ bug (`gemini`/`copilot` → acp → derived → registry →
 * gemini) only reproduces when the provider is the entry — an in-suite
 * `await import()` masks it because registry is already resolved. So we spawn a
 * child process per provider and assert exit 0.
 */

const here = dirname(fileURLToPath(import.meta.url));
const distProviders = resolve(here, "..", "..", "dist", "providers");

function providerEntries(): string[] {
  return readdirSync(distProviders, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name !== "_shared")
    .map((e) => join(distProviders, e.name, "index.js"))
    .sort();
}

describe("no TDZ: every provider index imports clean as an entry point", () => {
  const entries = providerEntries();

  it("discovers all 10 built-in provider modules", () => {
    expect(entries.length).toBe(10);
  });

  it.each(entries)("%s imports without error", (entry) => {
    // Child process — the bug only surfaces when the provider is the entry.
    const code = `await import(${JSON.stringify(entry)});`;
    expect(() =>
      execFileSync(process.execPath, ["--input-type=module", "-e", code], {
        stdio: "pipe",
      }),
    ).not.toThrow();
  });
});
