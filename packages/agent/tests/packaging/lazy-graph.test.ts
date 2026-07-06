import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

/**
 * §7.3 — Prove the lazy boundary: importing the barrel (and calling the sync
 * registry) must NOT pull any provider's heavy machinery into the module graph;
 * a provider's heavy body loads only when one of its (already-async) methods is
 * actually called. A spawned probe records every module URL via a loader hook.
 */

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, "..", "..");
const registerHooks = resolve(here, "register-hooks.mjs");

/** Heavy per-provider modules that must never load from a bare barrel import. */
const HEAVY =
  /providers\/[^/]+\/(session|execute|mcp|modes|plan-mode|usage-scanner|server|http-session|event-parse|attach)\.js$/;

/** Budget: measured dist module count for a bare barrel import + ~10% headroom.
 *  Per spec §10.9 this may be tightened, never loosened, without editing the spec. */
const BARREL_DIST_BUDGET = 51;

function isDenied(url: string): boolean {
  return (
    HEAVY.test(url) ||
    url.includes("node_modules/uuid") ||
    url.includes("@agentclientprotocol")
  );
}

let probeSeq = 0;
function runProbe(probe: string): string[] {
  const log = join(tmpdir(), `agentex-loads-${process.pid}-${probeSeq++}.txt`);
  rmSync(log, { force: true });
  try {
    execFileSync(
      process.execPath,
      ["--import", registerHooks, "--input-type=module", "-e", probe],
      { cwd: pkgRoot, env: { ...process.env, AGENTEX_LOAD_LOG: log }, stdio: "pipe" },
    );
    return readFileSync(log, "utf8").split("\n").filter(Boolean);
  } finally {
    rmSync(log, { force: true });
  }
}

const distUrls = (urls: string[]): string[] => urls.filter((u) => u.includes("/dist/"));

describe("lazy provider graph", () => {
  it("bare barrel import loads no heavy provider module, no uuid, no ACP SDK", () => {
    const loaded = runProbe(`await import("@agentex/agent");`);
    const denied = loaded.filter(isDenied);
    expect(denied).toEqual([]);
  });

  it("barrel import stays within the dist module budget", () => {
    const loaded = runProbe(`await import("@agentex/agent");`);
    const dist = distUrls(loaded);
    // Surface the actual count on failure so the budget can be re-pinned.
    expect(dist.length, `dist modules loaded: ${dist.length}`).toBeLessThanOrEqual(
      BARREL_DIST_BUDGET,
    );
  });

  it("getProvider + listProviders still load no heavy module", () => {
    const loaded = runProbe(
      `const m = await import("@agentex/agent"); m.getProvider("claude"); m.listProviders();`,
    );
    expect(loaded.filter(isDenied)).toEqual([]);
  });

  it("calling execute() lazily loads ONLY that provider's heavy body", () => {
    const loaded = runProbe(
      `const m = await import("@agentex/agent");
       try { await m.getProvider("process").execute({ prompt: "hi", config: { command: "echo" } }); }
       catch { /* command result is irrelevant — the dynamic import already ran */ }`,
    );
    const heavy = loaded.filter((u) => HEAVY.test(u));
    // process/execute.js must have loaded...
    expect(heavy.some((u) => /providers\/process\/execute\.js$/.test(u))).toBe(true);
    // ...and NO other provider's heavy body.
    const others = heavy.filter((u) => !/providers\/process\/execute\.js$/.test(u));
    expect(others).toEqual([]);
  });
});
