import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { prepareOpenCodeSkillConfig } from "../../../src/providers/opencode/skill-config.js";

describe("OpenCode isolated skill config", () => {
  it("preserves native config, injects skills, and cleans up", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentex-opencode-skill-test-"));
    const nativeConfig = path.join(root, "native");
    const skill = path.join(root, "review-skill");
    await fs.mkdir(nativeConfig, { recursive: true });
    await fs.writeFile(path.join(nativeConfig, "opencode.json"), "{}");
    await fs.mkdir(skill, { recursive: true });
    await fs.writeFile(path.join(skill, "SKILL.md"), "---\nname: review-skill\ndescription: Review code\n---\n");

    const prepared = await prepareOpenCodeSkillConfig(
      { OPENCODE_CONFIG_DIR: nativeConfig },
      [skill],
    );
    const isolated = prepared.env["OPENCODE_CONFIG_DIR"]!;
    expect(isolated).not.toBe(nativeConfig);
    expect(await fs.readFile(path.join(isolated, "opencode.json"), "utf8")).toBe("{}");
    expect(await fs.realpath(path.join(isolated, "skills", "review-skill"))).toBe(await fs.realpath(skill));

    await prepared.cleanup();
    await expect(fs.stat(isolated)).rejects.toMatchObject({ code: "ENOENT" });
    await fs.rm(root, { recursive: true, force: true });
  });
});
