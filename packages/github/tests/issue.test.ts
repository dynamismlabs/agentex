import { describe, expect, it } from "vitest";
import { github } from "../src/index.js";
import type { IssueDetail, IssueSummary } from "../src/index.js";
import { ok, useStub, makeStub } from "./helpers.js";

const stub = useStub();
const repoPath = "/abs/path/to/repo";

const sampleIssueSummary: IssueSummary = {
  number: 7,
  title: "Investigate flake",
  state: "OPEN",
  url: "https://github.com/owner/repo/issues/7",
  author: { login: "alice" },
  labels: [{ name: "bug" }],
  assignees: [{ login: "bob" }],
  createdAt: "2026-05-01T10:00:00Z",
  updatedAt: "2026-05-01T10:30:00Z",
};

const sampleIssueDetail: IssueDetail = {
  ...sampleIssueSummary,
  body: "details",
  comments: [{ author: { login: "carol" }, body: "+1", createdAt: "2026-05-01T10:35:00Z" }],
};

describe("repo.listIssues", () => {
  it("formats --state, --label, --assignee", async () => {
    const s = makeStub([ok(JSON.stringify([sampleIssueSummary]))]);
    stub.install(s);

    const repo = github.repo(repoPath);
    const result = await repo.listIssues({
      state: "open",
      labels: ["bug", "needs-triage"],
      assignee: "alice",
    });

    expect(result).toHaveLength(1);
    expect(s.calls[0]?.args).toContain("--state");
    expect(s.calls[0]?.args).toContain("open");
    expect(s.calls[0]?.args).toContain("--label");
    expect(s.calls[0]?.args).toContain("bug,needs-triage");
    expect(s.calls[0]?.args).toContain("--assignee");
    expect(s.calls[0]?.args).toContain("alice");
  });

  it("works with no opts", async () => {
    const s = makeStub([ok("[]")]);
    stub.install(s);

    const repo = github.repo(repoPath);
    expect(await repo.listIssues()).toEqual([]);
    expect(s.calls[0]?.args).not.toContain("--state");
  });
});

describe("repo.getIssue", () => {
  it("fetches detail JSON", async () => {
    const s = makeStub([ok(JSON.stringify(sampleIssueDetail))]);
    stub.install(s);

    const repo = github.repo(repoPath);
    const issue = await repo.getIssue(7);
    expect(issue.body).toBe("details");
    expect(issue.comments[0]?.body).toBe("+1");
  });
});

describe("repo.createIssue", () => {
  it("formats args + pipes body via stdin and re-fetches as IssueSummary", async () => {
    const s = makeStub([
      ok("https://github.com/owner/repo/issues/7\n"),
      ok(JSON.stringify(sampleIssueSummary)),
    ]);
    stub.install(s);

    const repo = github.repo(repoPath);
    const result = await repo.createIssue({
      title: "Investigate flake",
      body: "details",
      labels: ["bug"],
      assignees: ["bob"],
    });

    expect(result.number).toBe(7);
    expect(s.calls[0]?.args).toEqual([
      "issue", "create",
      "--title", "Investigate flake",
      "--body-file", "-",
      "--label", "bug",
      "--assignee", "bob",
    ]);
    expect(s.calls[0]?.opts.input).toBe("details");
  });

  it("validates title is required", async () => {
    const repo = github.repo(repoPath);
    await expect(
      // @ts-expect-error — intentionally missing title
      repo.createIssue({ title: "", body: "b" }),
    ).rejects.toThrow(/title is required/);
  });
});

describe("repo.commentOnIssue", () => {
  it("formats args + pipes body via stdin", async () => {
    const s = makeStub([ok("")]);
    stub.install(s);

    const repo = github.repo(repoPath);
    await repo.commentOnIssue(7, "thx");
    expect(s.calls[0]?.args).toEqual(["issue", "comment", "7", "--body-file", "-"]);
    expect(s.calls[0]?.opts.input).toBe("thx");
  });

  it("commentOnIssue with very long body (>200KB) doesn't hit OS arg-length limits", async () => {
    const s = makeStub([ok("")]);
    stub.install(s);

    const huge = "y".repeat(300_000);
    const repo = github.repo(repoPath);
    await repo.commentOnIssue(7, huge);

    expect(s.calls[0]?.args).toEqual(["issue", "comment", "7", "--body-file", "-"]);
    expect(s.calls[0]?.opts.input).toBe(huge);
  });

  it("rejects empty body", async () => {
    const repo = github.repo(repoPath);
    await expect(repo.commentOnIssue(7, "")).rejects.toThrow(/non-empty/);
  });

  it("issue-id ops accept number | string consistently", async () => {
    const s = makeStub([
      ok(""), // commentOnIssue with number
      ok(""), // commentOnIssue with string
      ok(JSON.stringify(sampleIssueDetail)), // getIssue with URL
    ]);
    stub.install(s);

    const repo = github.repo(repoPath);
    await repo.commentOnIssue(7, "n");
    await repo.commentOnIssue("https://github.com/o/r/issues/7", "s");
    await repo.getIssue("https://github.com/o/r/issues/7");

    expect(s.calls[0]?.args[2]).toBe("7");
    expect(s.calls[1]?.args[2]).toBe("https://github.com/o/r/issues/7");
    expect(s.calls[2]?.args[2]).toBe("https://github.com/o/r/issues/7");
  });
});
