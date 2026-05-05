import { describe, expect, it } from "vitest";
import {
  BranchNotFoundError,
  GhCommandError,
  github,
  NotAuthenticatedError,
  RateLimitedError,
  RepoNotFoundError,
} from "../src/index.js";
import { fail, useStub, makeStub } from "./helpers.js";

const stub = useStub();
const repoPath = "/repo";

describe("error mapping", () => {
  it("exit 4 maps to NotAuthenticatedError", async () => {
    stub.install(makeStub([fail(4, "authentication required\n")]));
    await expect(github.repo(repoPath).listPRs()).rejects.toBeInstanceOf(NotAuthenticatedError);
  });

  it("'You are not logged into' on stderr maps to NotAuthenticatedError", async () => {
    stub.install(makeStub([fail(1, "You are not logged into any GitHub hosts.\n")]));
    await expect(github.repo(repoPath).listPRs()).rejects.toBeInstanceOf(NotAuthenticatedError);
  });

  it("'rate limit' on stderr maps to RateLimitedError", async () => {
    stub.install(makeStub([fail(1, "API rate limit exceeded for user xyz.\n")]));
    await expect(github.repo(repoPath).listPRs()).rejects.toBeInstanceOf(RateLimitedError);
  });

  it("'could not resolve to a repository' maps to RepoNotFoundError", async () => {
    stub.install(makeStub([fail(1, "could not resolve to a repository with this name\n")]));
    await expect(github.repo(repoPath).listPRs()).rejects.toBeInstanceOf(RepoNotFoundError);
  });

  it("'must first push the current branch' maps to BranchNotFoundError", async () => {
    stub.install(makeStub([fail(1, "fatal: must first push the current branch upstream\n")]));
    const repo = github.repo(repoPath);
    await expect(
      repo.createPR({ base: "main", head: "f", title: "t", body: "b" }),
    ).rejects.toBeInstanceOf(BranchNotFoundError);
  });

  it("falls back to GhCommandError for unrecognized failures", async () => {
    stub.install(makeStub([fail(1, "unknown disaster\n", "stdout-debris\n")]));
    let caught: unknown = null;
    try {
      await github.repo(repoPath).listPRs();
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(GhCommandError);
    expect((caught as GhCommandError).exitCode).toBe(1);
    expect((caught as GhCommandError).stderr).toContain("unknown disaster");
    expect((caught as GhCommandError).stdout).toContain("stdout-debris");
  });

  it("typed errors expose raw stderr both as `.stderr` and as `Error#cause`", async () => {
    stub.install(makeStub([fail(1, "API rate limit exceeded for user\n")]));
    const err = await github.repo(repoPath).listPRs().catch((e) => e);
    expect(err).toBeInstanceOf(RateLimitedError);
    expect((err as RateLimitedError).stderr).toContain("rate limit");
    expect((err as Error).cause).toBe((err as RateLimitedError).stderr);
  });
});
