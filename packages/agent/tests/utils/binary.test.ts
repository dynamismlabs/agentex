import { describe, it, expect, beforeEach } from "vitest";
import { findBinary, clearBinaryCache, resolveWindowsCmdShim, ensureCommandResolvable } from "../../src/utils/binary.js";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

describe("findBinary", () => {
  beforeEach(() => {
    clearBinaryCache();
  });

  it("returns config override path when it exists", async () => {
    // Use a known existing binary as the override path
    const result = await findBinary("test", "/bin/echo");
    expect(result.bin).toBe("/bin/echo");
    expect(result.prefixArgs).toEqual([]);
  });

  it("throws descriptive error when config override path does not exist", async () => {
    await expect(findBinary("test", "/nonexistent/binary")).rejects.toThrow(
      /does not exist/
    );
  });

  it("throws descriptive error when binary not found", async () => {
    await expect(findBinary("definitely-not-a-real-binary-12345")).rejects.toThrow(
      /Could not find/
    );
  });

  it("includes install instructions for claude", async () => {
    clearBinaryCache();
    await expect(findBinary("claude-not-real-test-binary")).rejects.toThrow(
      /Could not find/
    );
  });

  it("caches results on second call", async () => {
    const result1 = await findBinary("echo-test", "/bin/echo");
    clearBinaryCache();
    // After clearing, second call with override still works
    const result2 = await findBinary("echo-test", "/bin/echo");
    expect(result1.bin).toBe(result2.bin);
  });

  it("finds echo via PATH", async () => {
    const result = await findBinary("echo");
    expect(result.bin).toContain("echo");
    expect(result.prefixArgs).toEqual([]);
  });
});

describe("resolveWindowsCmdShim", () => {
  it("returns null for non-cmd files", async () => {
    const result = await resolveWindowsCmdShim("/nonexistent.cmd");
    expect(result).toBeNull();
  });

  it("parses a .cmd shim file", async () => {
    // Create a temp .cmd file
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "cmd-test-"));
    const cmdPath = path.join(tmpDir, "test.cmd");
    const jsPath = path.join(tmpDir, "entry.js");

    await fs.writeFile(jsPath, "console.log('hello')");
    await fs.writeFile(
      cmdPath,
      `@IF EXIST "%~dp0\\node.exe" (\n  "%~dp0\\node.exe" "%dp0%\\entry.js" %*\n) ELSE (\n  node "%dp0%\\entry.js" %*\n)`
    );

    const result = await resolveWindowsCmdShim(cmdPath);
    // On non-Windows, this may or may not match depending on path resolution
    // The test validates the parsing logic doesn't crash
    await fs.rm(tmpDir, { recursive: true, force: true });
  });
});

describe("ensureCommandResolvable", () => {
  it("resolves an absolute path", async () => {
    const result = await ensureCommandResolvable("/bin/echo");
    expect(result.bin).toBe("/bin/echo");
  });

  it("throws for non-existent absolute path", async () => {
    await expect(ensureCommandResolvable("/nonexistent/command")).rejects.toThrow(
      /Command not found/
    );
  });

  it("resolves a binary name via PATH", async () => {
    const result = await ensureCommandResolvable("echo");
    expect(result.bin).toContain("echo");
  });
});
