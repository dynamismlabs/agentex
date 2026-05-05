import { describe, expect, it } from "vitest";
import { github } from "../src/index.js";
import type { PRDetail, PRSummary, CheckRun } from "../src/index.js";
import { fail, ok, useStub, makeStub } from "./helpers.js";

const stub = useStub();

const repoPath = "/abs/path/to/repo";

const samplePRSummary: PRSummary = {
  number: 42,
  title: "Add feature foo",
  state: "OPEN",
  url: "https://github.com/owner/repo/pull/42",
  isDraft: false,
  headRefName: "feature/foo",
  baseRefName: "main",
  author: { login: "alice" },
  createdAt: "2026-05-01T12:00:00Z",
  updatedAt: "2026-05-01T12:30:00Z",
};

const samplePRDetail: PRDetail = {
  ...samplePRSummary,
  body: "implements foo",
  reviews: [
    {
      author: { login: "bob" },
      state: "APPROVED",
      body: "lgtm",
      submittedAt: "2026-05-01T13:00:00Z",
    },
  ],
  comments: [
    { author: { login: "carol" }, body: "nice", createdAt: "2026-05-01T13:05:00Z" },
  ],
  statusCheckRollup: [
    {
      name: "ci/build",
      conclusion: "SUCCESS",
      status: "COMPLETED",
      url: "https://github.com/owner/repo/actions/runs/1",
    },
  ],
};

describe("repo.createPR", () => {
  it("formats args correctly and re-fetches as PRSummary", async () => {
    const s = makeStub([
      ok("Creating draft pull request for feature/foo into main in owner/repo\n\nhttps://github.com/owner/repo/pull/42\n"),
      ok(JSON.stringify(samplePRSummary)),
    ]);
    stub.install(s);

    const repo = github.repo(repoPath);
    const result = await repo.createPR({
      base: "main",
      head: "feature/foo",
      title: "Add feature foo",
      body: "implements foo",
      draft: true,
      reviewers: ["bob", "carol"],
      labels: ["needs-review"],
    });

    expect(result.number).toBe(42);
    expect(result.url).toBe("https://github.com/owner/repo/pull/42");

    const create = s.calls[0]!;
    expect(create.args).toEqual([
      "pr", "create",
      "--base", "main",
      "--head", "feature/foo",
      "--title", "Add feature foo",
      "--body-file", "-",
      "--draft",
      "--reviewer", "bob",
      "--reviewer", "carol",
      "--label", "needs-review",
    ]);
    expect(create.opts.cwd).toBe(repoPath);
    // Body is piped via stdin instead of passed as a CLI arg.
    expect(create.opts.input).toBe("implements foo");

    const view = s.calls[1]!;
    expect(view.args[0]).toBe("pr");
    expect(view.args[1]).toBe("view");
    expect(view.args[2]).toBe("42");
    expect(view.args[3]).toBe("--json");
  });

  it("validates required fields", async () => {
    const repo = github.repo(repoPath);
    await expect(
      // @ts-expect-error — intentionally missing fields
      repo.createPR({ base: "", head: "h", title: "t", body: "b" }),
    ).rejects.toThrow(/required/);
  });
});

describe("repo.listPRs / getPR", () => {
  it("listPRs threads --state and parses JSON array", async () => {
    const s = makeStub([ok(JSON.stringify([samplePRSummary]))]);
    stub.install(s);

    const repo = github.repo(repoPath);
    const result = await repo.listPRs({ state: "open" });

    expect(result).toHaveLength(1);
    expect(result[0]?.number).toBe(42);
    expect(s.calls[0]?.args).toContain("--state");
    expect(s.calls[0]?.args).toContain("open");
    expect(s.calls[0]?.args).toContain("--limit");
    expect(s.calls[0]?.args).toContain("200");
  });

  it("listPRs without state still works", async () => {
    const s = makeStub([ok(JSON.stringify([]))]);
    stub.install(s);

    const repo = github.repo(repoPath);
    const result = await repo.listPRs();
    expect(result).toEqual([]);
    expect(s.calls[0]?.args).not.toContain("--state");
  });

  it("listPRs threads --head, --base, --author when provided", async () => {
    const s = makeStub([ok(JSON.stringify([samplePRSummary]))]);
    stub.install(s);

    const repo = github.repo(repoPath);
    await repo.listPRs({
      state: "open",
      head: "feature/foo",
      base: "main",
      author: "demouser",
    });

    const args = s.calls[0]!.args;
    expect(args).toContain("--state");
    expect(args).toContain("open");
    expect(args).toContain("--head");
    expect(args).toContain("feature/foo");
    expect(args).toContain("--base");
    expect(args).toContain("main");
    expect(args).toContain("--author");
    expect(args).toContain("demouser");
  });

  it("listPRs without head/base/author doesn't add the flags", async () => {
    const s = makeStub([ok("[]")]);
    stub.install(s);

    const repo = github.repo(repoPath);
    await repo.listPRs({ state: "open" });

    const args = s.calls[0]!.args;
    expect(args).not.toContain("--head");
    expect(args).not.toContain("--base");
    expect(args).not.toContain("--author");
  });

  it("getPR fetches detail JSON", async () => {
    const s = makeStub([ok(JSON.stringify(samplePRDetail))]);
    stub.install(s);

    const repo = github.repo(repoPath);
    const detail = await repo.getPR(42);
    expect(detail.body).toBe("implements foo");
    expect(detail.reviews[0]?.state).toBe("APPROVED");
    expect(detail.statusCheckRollup[0]?.name).toBe("ci/build");
  });

  it("getPR accepts a URL string", async () => {
    const s = makeStub([ok(JSON.stringify(samplePRDetail))]);
    stub.install(s);

    const repo = github.repo(repoPath);
    await repo.getPR("https://github.com/owner/repo/pull/42");
    expect(s.calls[0]?.args[2]).toBe("https://github.com/owner/repo/pull/42");
  });

  it("PR-id accepting operations all accept number | string consistently", async () => {
    const s = makeStub([
      ok(""), // commentOnPR
      ok(""), // commentOnPR with string
      ok(""), // merge
      ok(""), // openInBrowser
      ok(JSON.stringify([])), // listChecks
      ok(""), // requestReviewers
    ]);
    stub.install(s);

    const repo = github.repo(repoPath);
    await repo.commentOnPR(42, "n");
    await repo.commentOnPR("https://github.com/o/r/pull/42", "s");
    await repo.merge("42");
    await repo.openInBrowser("https://github.com/o/r/pull/42");
    await repo.listChecks("42");
    await repo.requestReviewers(42, ["bob"]);

    expect(s.calls[0]?.args[2]).toBe("42");
    expect(s.calls[1]?.args[2]).toBe("https://github.com/o/r/pull/42");
    expect(s.calls[2]?.args[2]).toBe("42");
    expect(s.calls[3]?.args[2]).toBe("https://github.com/o/r/pull/42");
    expect(s.calls[4]?.args[2]).toBe("42");
    expect(s.calls[5]?.args[2]).toBe("42");
  });
});

describe("repo.commentOnPR / requestReviewers / merge / openInBrowser", () => {
  it("commentOnPR formats args + pipes body via stdin", async () => {
    const s = makeStub([ok("")]);
    stub.install(s);

    const repo = github.repo(repoPath);
    await repo.commentOnPR(42, "looks great");

    expect(s.calls[0]?.args).toEqual(["pr", "comment", "42", "--body-file", "-"]);
    expect(s.calls[0]?.opts.input).toBe("looks great");
  });

  it("commentOnPR with very long body (>200KB) doesn't hit OS arg-length limits", async () => {
    const s = makeStub([ok("")]);
    stub.install(s);

    // Sized to comfortably exceed Linux's E2BIG (~128KB) and macOS's (~256KB).
    const huge = "x".repeat(300_000);

    const repo = github.repo(repoPath);
    await repo.commentOnPR(42, huge);

    expect(s.calls[0]?.args).toEqual(["pr", "comment", "42", "--body-file", "-"]);
    expect(s.calls[0]?.opts.input).toBe(huge);
    expect(s.calls[0]?.opts.input?.length).toBe(300_000);
  });

  it("commentOnPR rejects empty body", async () => {
    const repo = github.repo(repoPath);
    await expect(repo.commentOnPR(42, "")).rejects.toThrow(/non-empty/);
  });

  it("requestReviewers formats one --add-reviewer per name", async () => {
    const s = makeStub([ok("")]);
    stub.install(s);

    const repo = github.repo(repoPath);
    await repo.requestReviewers(42, ["bob", "carol"]);
    expect(s.calls[0]?.args).toEqual([
      "pr", "edit", "42",
      "--add-reviewer", "bob",
      "--add-reviewer", "carol",
    ]);
  });

  it("requestReviewers rejects empty array", async () => {
    const repo = github.repo(repoPath);
    await expect(repo.requestReviewers(42, [])).rejects.toThrow(/non-empty/);
  });

  it("merge defaults to --merge", async () => {
    const s = makeStub([ok("")]);
    stub.install(s);

    const repo = github.repo(repoPath);
    await repo.merge(42);
    expect(s.calls[0]?.args).toContain("--merge");
  });

  it("merge with squash + deleteBranch", async () => {
    const s = makeStub([ok("")]);
    stub.install(s);

    const repo = github.repo(repoPath);
    await repo.merge(42, { method: "squash", deleteBranch: true });
    expect(s.calls[0]?.args).toContain("--squash");
    expect(s.calls[0]?.args).toContain("--delete-branch");
  });

  it("openInBrowser uses --web", async () => {
    const s = makeStub([ok("")]);
    stub.install(s);

    const repo = github.repo(repoPath);
    await repo.openInBrowser(42);
    expect(s.calls[0]?.args).toEqual(["pr", "view", "42", "--web"]);
  });
});

describe("repo.listChecks", () => {
  it("returns parsed CheckRun array", async () => {
    const checks: CheckRun[] = [
      { name: "build", conclusion: "SUCCESS", status: "COMPLETED", url: "https://x" },
      { name: "lint", conclusion: "FAILURE", status: "COMPLETED", url: "https://y" },
    ];
    const s = makeStub([ok(JSON.stringify(checks))]);
    stub.install(s);

    const repo = github.repo(repoPath);
    const result = await repo.listChecks(42);
    expect(result).toEqual(checks);
    expect(s.calls[0]?.args[0]).toBe("pr");
    expect(s.calls[0]?.args[1]).toBe("checks");
    expect(s.calls[0]?.args[2]).toBe("42");
  });
});

describe("createPR error path", () => {
  it("non-zero gh exit maps to typed error before the second JSON call", async () => {
    const s = makeStub([fail(1, "could not resolve to a repository\n")]);
    stub.install(s);

    const repo = github.repo(repoPath);
    await expect(
      repo.createPR({ base: "main", head: "f", title: "t", body: "b" }),
    ).rejects.toThrow();
    expect(s.calls).toHaveLength(1); // didn't fall through to view
  });
});
