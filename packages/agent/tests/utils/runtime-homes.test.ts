import { describe, it, expect } from "vitest";
import * as path from "node:path";
import * as os from "node:os";
import { getRuntimeHomeEnvVar, getDefaultRuntimeHome } from "../../src/utils/runtime-homes.js";
import type { SkillRuntime } from "../../src/utils/skills.js";

describe("getRuntimeHomeEnvVar", () => {
  it("returns CLAUDE_CONFIG_DIR for claude", () => {
    expect(getRuntimeHomeEnvVar("claude")).toBe("CLAUDE_CONFIG_DIR");
  });

  it("returns CODEX_HOME for codex", () => {
    expect(getRuntimeHomeEnvVar("codex")).toBe("CODEX_HOME");
  });

  it("returns GEMINI_CONFIG_DIR for gemini", () => {
    expect(getRuntimeHomeEnvVar("gemini")).toBe("GEMINI_CONFIG_DIR");
  });

  it("returns CURSOR_CONFIG_DIR for cursor", () => {
    expect(getRuntimeHomeEnvVar("cursor")).toBe("CURSOR_CONFIG_DIR");
  });

  it("returns XDG_CONFIG_HOME for opencode", () => {
    expect(getRuntimeHomeEnvVar("opencode")).toBe("XDG_CONFIG_HOME");
  });

  it("returns PI_HOME for pi", () => {
    expect(getRuntimeHomeEnvVar("pi")).toBe("PI_HOME");
  });

  it("returns null for an unknown runtime", () => {
    expect(getRuntimeHomeEnvVar("unknown" as SkillRuntime)).toBeNull();
  });
});

describe("getDefaultRuntimeHome", () => {
  const home = os.homedir();

  it("returns ~/.claude for claude", () => {
    expect(getDefaultRuntimeHome("claude")).toBe(path.join(home, ".claude"));
  });

  it("returns ~/.codex for codex", () => {
    expect(getDefaultRuntimeHome("codex")).toBe(path.join(home, ".codex"));
  });

  it("returns ~/.gemini for gemini", () => {
    expect(getDefaultRuntimeHome("gemini")).toBe(path.join(home, ".gemini"));
  });

  it("returns ~/.cursor for cursor", () => {
    expect(getDefaultRuntimeHome("cursor")).toBe(path.join(home, ".cursor"));
  });

  it("returns ~/.config/opencode for opencode", () => {
    expect(getDefaultRuntimeHome("opencode")).toBe(path.join(home, ".config", "opencode"));
  });

  it("returns ~/.pi for pi", () => {
    expect(getDefaultRuntimeHome("pi")).toBe(path.join(home, ".pi"));
  });

  it("returns a fallback path ending with the runtime name for unknown runtimes", () => {
    const result = getDefaultRuntimeHome("foo" as SkillRuntime);
    expect(result).toBe(path.join(home, ".foo"));
    expect(result).toMatch(/foo$/);
  });
});
