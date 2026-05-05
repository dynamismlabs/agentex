import { afterEach, describe, expect, it } from "vitest";
import * as path from "node:path";
import { MalformedConfigError, workspace } from "../src/index.js";
import { makeTmpDir, removeTmpDir, writeUtf8 } from "./helpers.js";
import { setupSimpleRepo } from "./git-helpers.js";

const tmpDirs: string[] = [];

afterEach(async () => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop();
    if (dir) await removeTmpDir(dir);
  }
});

async function tmp(label: string): Promise<string> {
  const dir = await makeTmpDir(label);
  tmpDirs.push(dir);
  return dir;
}

describe("agentex.workspace.json malformed handling", () => {
  it("workspace-side malformed JSON surfaces as MalformedConfigError on operations that load config", async () => {
    const root = await tmp("config-bad-ws");
    const wsPath = path.join(root, "ws");
    const ws = await workspace.create({ kind: "bare", path: wsPath });
    await writeUtf8(path.join(ws.path, "agentex.workspace.json"), "{ this is not json");

    let caught: unknown = null;
    try {
      // Trigger config load via runScript.
      await ws.runScript("anything");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(MalformedConfigError);
    expect((caught as MalformedConfigError).path).toContain("agentex.workspace.json");
    expect((caught as MalformedConfigError).cause).toBeInstanceOf(SyntaxError);
  });

  it("source-side malformed JSON surfaces too (when source is set)", async () => {
    const root = await tmp("config-bad-source");
    const sourcePath = path.join(root, "source");
    const wsPath = path.join(root, "ws");

    await setupSimpleRepo(sourcePath);
    await writeUtf8(path.join(sourcePath, "agentex.workspace.json"), "not json {");

    let caught: unknown = null;
    try {
      await workspace.create({
        kind: "git",
        source: sourcePath,
        baseBranch: "main",
        path: wsPath,
        branch: "feature/bad-config",
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(MalformedConfigError);
    expect((caught as MalformedConfigError).path).toContain(sourcePath);
  });

  it("missing config files (neither side has one) is fine — no error", async () => {
    const root = await tmp("config-missing");
    const wsPath = path.join(root, "ws");
    const ws = await workspace.create({ kind: "bare", path: wsPath });

    // No agentex.workspace.json anywhere; archive should succeed (no archive
    // script, no fromSource).
    await expect(workspace.archive(ws.path)).resolves.toBeUndefined();
  });
});
