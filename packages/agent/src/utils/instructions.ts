import * as fs from "node:fs/promises";

/**
 * Read an instructions file and return its content.
 * Returns null if no path is provided.
 * Throws a clear error if the file doesn't exist.
 */
export async function resolveInstructions(filePath?: string): Promise<string | null> {
  if (!filePath) return null;
  try {
    return await fs.readFile(filePath, "utf-8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new Error(`Instructions file not found: ${filePath}`);
    }
    throw err;
  }
}
