import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { resolveInstructions } from "../../src/utils/instructions.js";

describe("resolveInstructions", () => {
  const tempFiles: string[] = [];

  afterEach(async () => {
    for (const f of tempFiles) {
      try {
        await fs.unlink(f);
      } catch {
        // ignore
      }
    }
    tempFiles.length = 0;
  });

  it("returns null when filePath is undefined", async () => {
    const result = await resolveInstructions(undefined);
    expect(result).toBeNull();
  });

  it("returns null when filePath is empty string", async () => {
    const result = await resolveInstructions("");
    expect(result).toBeNull();
  });

  it("returns file content when file exists", async () => {
    const tmpFile = path.join(os.tmpdir(), `agex-test-instructions-${Date.now()}.txt`);
    tempFiles.push(tmpFile);
    await fs.writeFile(tmpFile, "You are a helpful assistant.", "utf-8");

    const result = await resolveInstructions(tmpFile);
    expect(result).toBe("You are a helpful assistant.");
  });

  it("throws a clear error when file does not exist (ENOENT)", async () => {
    const missing = path.join(os.tmpdir(), `agex-nonexistent-${Date.now()}.txt`);
    await expect(resolveInstructions(missing)).rejects.toThrow(
      `Instructions file not found: ${missing}`,
    );
  });

  it("re-throws non-ENOENT errors", async () => {
    // Reading a directory as a file triggers EISDIR on most platforms
    const tmpDir = path.join(os.tmpdir(), `agex-test-dir-${Date.now()}`);
    await fs.mkdir(tmpDir, { recursive: true });
    tempFiles.push(tmpDir); // cleanup won't unlink a dir, but that's fine

    await expect(resolveInstructions(tmpDir)).rejects.toThrow();
    // Ensure it's NOT the "Instructions file not found" wrapper
    try {
      await resolveInstructions(tmpDir);
    } catch (err) {
      expect((err as Error).message).not.toContain("Instructions file not found");
    }
  });
});
