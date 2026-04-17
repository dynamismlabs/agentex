import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { withTempConfig } from "../../src/utils/runtime-config.js";
import type { TempConfigResult } from "../../src/utils/runtime-config.js";

describe("withTempConfig", () => {
  const results: TempConfigResult[] = [];

  afterEach(async () => {
    for (const r of results) {
      try {
        await r.cleanup();
      } catch {
        // ignore
      }
    }
    results.length = 0;
  });

  it("creates a temp config directory", async () => {
    const result = await withTempConfig({ runtime: "claude" });
    results.push(result);

    const stat = await fs.stat(result.configDir);
    expect(stat.isDirectory()).toBe(true);
  });

  it("sets CLAUDE_CONFIG_DIR env var for claude runtime", async () => {
    const result = await withTempConfig({ runtime: "claude" });
    results.push(result);

    expect(result.env["CLAUDE_CONFIG_DIR"]).toBe(result.configDir);
  });

  it("sets CODEX_HOME env var for codex runtime", async () => {
    const result = await withTempConfig({ runtime: "codex" });
    results.push(result);

    expect(result.env["CODEX_HOME"]).toBe(result.configDir);
  });

  it("sets GEMINI_CONFIG_DIR env var for gemini runtime", async () => {
    const result = await withTempConfig({ runtime: "gemini" });
    results.push(result);

    expect(result.env["GEMINI_CONFIG_DIR"]).toBe(result.configDir);
  });

  it("preserves caller-provided env vars", async () => {
    const result = await withTempConfig({
      runtime: "claude",
      env: { MY_VAR: "hello" },
    });
    results.push(result);

    expect(result.env["MY_VAR"]).toBe("hello");
    expect(result.env["CLAUDE_CONFIG_DIR"]).toBe(result.configDir);
  });

  it("applies file overrides to the temp dir", async () => {
    const result = await withTempConfig({
      runtime: "claude",
      overrides: {
        "settings.json": '{"theme": "dark"}',
        "nested/config.yaml": "key: value",
      },
    });
    results.push(result);

    const settingsContent = await fs.readFile(
      path.join(result.configDir, "settings.json"),
      "utf-8",
    );
    expect(settingsContent).toBe('{"theme": "dark"}');

    const nestedContent = await fs.readFile(
      path.join(result.configDir, "nested/config.yaml"),
      "utf-8",
    );
    expect(nestedContent).toBe("key: value");
  });

  it("cleanup removes the temp directory", async () => {
    const result = await withTempConfig({ runtime: "claude" });
    const dir = result.configDir;

    // Verify it exists first
    const stat = await fs.stat(dir);
    expect(stat.isDirectory()).toBe(true);

    await result.cleanup();

    // Verify it's gone
    await expect(fs.stat(dir)).rejects.toThrow();
  });

  it("uses empty env when no caller env is provided", async () => {
    const result = await withTempConfig({ runtime: "claude" });
    results.push(result);

    // Should only have the config dir env var
    const keys = Object.keys(result.env);
    expect(keys).toContain("CLAUDE_CONFIG_DIR");
    expect(keys).toHaveLength(1);
  });
});
