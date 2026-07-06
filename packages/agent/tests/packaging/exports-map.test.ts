import { describe, it, expect, beforeAll } from "vitest";
import ts from "typescript";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

/**
 * §7.1 — Every subpath the exports map advertises must resolve at BOTH runtime
 * (Node's ESM resolver) and type-check time (TS `bundler` + `node16`). Wildcards
 * are expanded against the built `dist/` so a real file backs every entry.
 */

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, "..", "..");
const pkg = JSON.parse(readFileSync(join(pkgRoot, "package.json"), "utf8")) as {
  name: string;
  exports: Record<string, unknown>;
};

/** Concrete subpaths ("." plus each wildcard expanded, literal keys as-is). */
function concreteSubpaths(): string[] {
  const out = new Set<string>();
  for (const key of Object.keys(pkg.exports)) {
    if (key === "./package.json") continue;
    if (key === "./utils/*") {
      for (const f of readdirSync(join(pkgRoot, "dist", "utils"))) {
        if (f.endsWith(".js") && !f.endsWith(".js.map")) out.add(`./utils/${f.slice(0, -3)}`);
      }
    } else if (key === "./providers/*") {
      for (const d of readdirSync(join(pkgRoot, "dist", "providers"), { withFileTypes: true })) {
        if (d.isDirectory() && d.name !== "_shared") out.add(`./providers/${d.name}`);
      }
    } else {
      out.add(key); // "." and the literal deep keys
    }
  }
  return [...out].sort();
}

const subpaths = concreteSubpaths();
const importSpecifier = (s: string): string => pkg.name + s.slice(1); // "." -> name, "./x" -> name/x

function resolveTypes(specifier: string, kind: ts.ModuleResolutionKind): string | undefined {
  const options: ts.CompilerOptions = {
    moduleResolution: kind,
    module:
      kind === ts.ModuleResolutionKind.Bundler
        ? ts.ModuleKind.ESNext
        : ts.ModuleKind.Node16,
    target: ts.ScriptTarget.ES2022,
    // Resolve as if from a real file inside the package (enables self-reference).
    baseUrl: pkgRoot,
  };
  const containingFile = join(pkgRoot, "src", "index.ts");
  const res = ts.resolveModuleName(specifier, containingFile, options, ts.sys);
  return res.resolvedModule?.resolvedFileName;
}

describe("exports map — every advertised subpath resolves", () => {
  it("discovers the expected subpaths (barrel, wildcards, literals)", () => {
    expect(subpaths).toContain(".");
    expect(subpaths).toContain("./registry");
    expect(subpaths).toContain("./providers/claude");
    expect(subpaths).toContain("./providers/claude/parse");
    expect(subpaths).toContain("./utils/ask-user-question");
    // The private _shared dir must NOT be advertised.
    expect(subpaths).not.toContain("./providers/_shared");
  });

  it("resolves every subpath at runtime (Node ESM resolver, child process)", () => {
    const probe =
      `const specs = ${JSON.stringify(subpaths.map(importSpecifier))};\n` +
      `for (const s of specs) { try { await import(s); } catch (e) { console.error("FAIL " + s + ": " + e.message); process.exitCode = 1; } }`;
    // Throws (non-zero exit) if any import failed — the stderr names the culprit.
    expect(() =>
      execFileSync(process.execPath, ["--input-type=module", "-e", probe], {
        cwd: pkgRoot,
        stdio: "pipe",
      }),
    ).not.toThrow();
  });

  it.each(subpaths)("resolves types for %s (moduleResolution: bundler)", (s) => {
    const resolved = resolveTypes(importSpecifier(s), ts.ModuleResolutionKind.Bundler);
    expect(resolved, `bundler resolution for ${s}`).toBeDefined();
    expect(resolved!.endsWith(".d.ts")).toBe(true);
  });

  it.each(subpaths)("resolves types for %s (moduleResolution: node16)", (s) => {
    const resolved = resolveTypes(importSpecifier(s), ts.ModuleResolutionKind.Node16);
    expect(resolved, `node16 resolution for ${s}`).toBeDefined();
    expect(resolved!.endsWith(".d.ts")).toBe(true);
  });
});
