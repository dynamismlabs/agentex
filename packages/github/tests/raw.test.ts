import { describe, expect, it } from "vitest";
import { github } from "../src/index.js";
import { fail, ok, useStub, makeStub } from "./helpers.js";

const stub = useStub();
const repoPath = "/abs/path/to/repo";

describe("repo.raw", () => {
  it("threads args through to gh and returns the raw result", async () => {
    const s = makeStub([ok('{"login":"alice"}')]);
    stub.install(s);

    const result = await github
      .repo(repoPath)
      .raw(["api", "user", "--jq", ".login"]);

    expect(s.calls).toHaveLength(1);
    expect(s.calls[0].args).toEqual(["api", "user", "--jq", ".login"]);
    expect(s.calls[0].opts.cwd).toBe(repoPath);
    expect(s.calls[0].opts.input).toBeUndefined();
    expect(result).toEqual({
      stdout: '{"login":"alice"}',
      stderr: "",
      exitCode: 0,
    });
  });

  it("pipes input on stdin when provided (long-body escape hatch)", async () => {
    const s = makeStub([ok("https://github.com/owner/repo/issues/7\n")]);
    stub.install(s);

    const longBody = "x".repeat(300_000);
    const result = await github
      .repo(repoPath)
      .raw(["issue", "create", "--title", "t", "--body-file", "-"], {
        input: longBody,
      });

    expect(s.calls[0].opts.input).toBe(longBody);
    expect(result.exitCode).toBe(0);
  });

  it("returns non-zero exits without throwing — caller decides", async () => {
    const s = makeStub([fail(1, "some gh error\n")]);
    stub.install(s);

    const result = await github.repo(repoPath).raw(["pr", "view", "999999"]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe("some gh error\n");
  });

  it("rejects non-array args", async () => {
    const repo = github.repo(repoPath);
    await expect(
      // @ts-expect-error — intentional misuse
      repo.raw("pr list"),
    ).rejects.toThrow(/args must be an array/);
  });
});
