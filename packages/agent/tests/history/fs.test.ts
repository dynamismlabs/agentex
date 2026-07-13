import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { recentEligible } from "../../src/history/fs.js";

describe("recentEligible", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "agentex-recent-history-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("sorts by cheap metadata and stops inspecting once the result limit is met", async () => {
    const files: string[] = [];
    for (let index = 0; index < 20; index++) {
      const filePath = path.join(root, `${index}.jsonl`);
      await writeFile(filePath, "{}\n");
      const modified = new Date(Date.UTC(2026, 0, 1, 0, 0, index));
      await utimes(filePath, modified, modified);
      files.push(filePath);
    }

    const inspected: string[] = [];
    const selected = await recentEligible(files, { limit: 3, concurrency: 8 }, async (filePath) => {
      inspected.push(path.basename(filePath));
      return path.basename(filePath);
    });

    expect(selected).toEqual(["19.jsonl", "18.jsonl", "17.jsonl"]);
    expect(inspected).toHaveLength(3);
  });

  it("pulls another bounded batch when recent candidates are ineligible", async () => {
    const files: string[] = [];
    for (let index = 0; index < 8; index++) {
      const filePath = path.join(root, `${index}.jsonl`);
      await writeFile(filePath, "{}\n");
      const modified = new Date(Date.UTC(2026, 0, 1, 0, 0, index));
      await utimes(filePath, modified, modified);
      files.push(filePath);
    }

    let inspections = 0;
    const selected = await recentEligible(files, { limit: 2, concurrency: 4 }, async (filePath) => {
      inspections++;
      const id = Number(path.basename(filePath, ".jsonl"));
      return id >= 6 ? null : id;
    });

    expect(selected).toEqual([5, 4]);
    expect(inspections).toBe(4);
  });
});
