import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execSync } from "node:child_process";
import * as os from "node:os";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { prepareWorkspace } from "../../src/utils/workspace.js";

describe("prepareWorkspace", () => {
  let repoDir: string;

  beforeEach(async () => {
    // Create a temp directory with a valid git repo
    repoDir = await fs.mkdtemp(path.join(os.tmpdir(), "workspace-test-"));
    execSync("git init", { cwd: repoDir });
    execSync('git config user.email "test@test.com"', { cwd: repoDir });
    execSync('git config user.name "Test"', { cwd: repoDir });
    execSync("git commit --allow-empty -m 'initial commit'", { cwd: repoDir });
    // Rename the default branch to main so baseBranch defaults work
    execSync("git branch -M main", { cwd: repoDir });
  });

  afterEach(async () => {
    await fs.rm(repoDir, { recursive: true, force: true });
  });

  it("creates a worktree directory with the correct branch", async () => {
    const ws = await prepareWorkspace(repoDir, { strategy: "worktree" });

    try {
      // The worktree directory should exist
      const stat = await fs.stat(ws.cwd);
      expect(stat.isDirectory()).toBe(true);

      // The branch should be set on the workspace
      expect(ws.branch).toBeTruthy();
      expect(ws.strategy).toBe("worktree");

      // The branch should exist in the original repo's git refs
      const branches = execSync("git branch", { cwd: repoDir, encoding: "utf-8" });
      expect(branches).toContain(ws.branch);
    } finally {
      await ws.cleanup();
    }
  });

  it("returns a cwd that points to a valid directory", async () => {
    const ws = await prepareWorkspace(repoDir, { strategy: "worktree" });

    try {
      // cwd should be an absolute path
      expect(path.isAbsolute(ws.cwd)).toBe(true);

      // Should be able to list files in the directory
      const entries = await fs.readdir(ws.cwd);
      expect(Array.isArray(entries)).toBe(true);

      // Should be a git working directory
      const gitDir = execSync("git rev-parse --git-dir", {
        cwd: ws.cwd,
        encoding: "utf-8",
      }).trim();
      expect(gitDir).toBeTruthy();
    } finally {
      await ws.cleanup();
    }
  });

  it("diff() returns empty string when nothing changed", async () => {
    const ws = await prepareWorkspace(repoDir, { strategy: "worktree" });

    try {
      const diffResult = await ws.diff();
      expect(diffResult).toBe("");
    } finally {
      await ws.cleanup();
    }
  });

  it("diff() includes uncommitted changes to tracked files", async () => {
    // Create a tracked file on main first
    await fs.writeFile(path.join(repoDir, "tracked.txt"), "original\n");
    execSync("git add tracked.txt && git commit -m 'add tracked'", { cwd: repoDir });

    const ws = await prepareWorkspace(repoDir, { strategy: "worktree" });
    try {
      // Modify the tracked file in the worktree
      await fs.writeFile(path.join(ws.cwd, "tracked.txt"), "modified\n");

      const diff = await ws.diff();
      expect(diff).toContain("tracked.txt");
      expect(diff).toContain("-original");
      expect(diff).toContain("+modified");
    } finally {
      await ws.cleanup({ deleteBranch: true });
    }
  });

  it("diff() includes untracked (new) files", async () => {
    const ws = await prepareWorkspace(repoDir, { strategy: "worktree" });
    try {
      await fs.writeFile(path.join(ws.cwd, "newfile.txt"), "brand new\n");

      const diff = await ws.diff();
      expect(diff).toContain("newfile.txt");
      expect(diff).toContain("+brand new");
    } finally {
      await ws.cleanup({ deleteBranch: true });
    }
  });

  it("diff() includes committed changes on the worktree branch", async () => {
    const ws = await prepareWorkspace(repoDir, { strategy: "worktree" });
    try {
      await fs.writeFile(path.join(ws.cwd, "committed.txt"), "hello\n");
      execSync("git add committed.txt && git commit -m 'add committed'", { cwd: ws.cwd });

      const diff = await ws.diff();
      expect(diff).toContain("committed.txt");
      expect(diff).toContain("+hello");
    } finally {
      await ws.cleanup({ deleteBranch: true });
    }
  });

  it("diff({ scope: 'uncommitted' }) only shows unstaged/staged changes", async () => {
    await fs.writeFile(path.join(repoDir, "tracked.txt"), "original\n");
    execSync("git add tracked.txt && git commit -m 'add tracked'", { cwd: repoDir });

    const ws = await prepareWorkspace(repoDir, { strategy: "worktree" });
    try {
      // Commit a change (should NOT appear in uncommitted scope)
      await fs.writeFile(path.join(ws.cwd, "committed.txt"), "committed\n");
      execSync("git add committed.txt && git commit -m 'commit it'", { cwd: ws.cwd });

      // Modify tracked file (SHOULD appear)
      await fs.writeFile(path.join(ws.cwd, "tracked.txt"), "changed\n");

      const diff = await ws.diff({ scope: "uncommitted" });
      expect(diff).toContain("tracked.txt");
      expect(diff).not.toContain("committed.txt");
    } finally {
      await ws.cleanup({ deleteBranch: true });
    }
  });

  it("diff({ scope: 'committed' }) only shows branch commits", async () => {
    const ws = await prepareWorkspace(repoDir, { strategy: "worktree" });
    try {
      // Commit a file on the worktree branch
      await fs.writeFile(path.join(ws.cwd, "committed.txt"), "committed\n");
      execSync("git add committed.txt && git commit -m 'commit it'", { cwd: ws.cwd });

      // Also make an uncommitted change (should NOT appear in committed scope)
      await fs.writeFile(path.join(ws.cwd, "uncommitted.txt"), "wip\n");

      const diff = await ws.diff({ scope: "committed" });
      expect(diff).toContain("committed.txt");
      expect(diff).not.toContain("uncommitted.txt");
    } finally {
      await ws.cleanup({ deleteBranch: true });
    }
  });

  it("diff({ scope: 'untracked' }) only shows new files", async () => {
    await fs.writeFile(path.join(repoDir, "tracked.txt"), "original\n");
    execSync("git add tracked.txt && git commit -m 'add tracked'", { cwd: repoDir });

    const ws = await prepareWorkspace(repoDir, { strategy: "worktree" });
    try {
      // Modify tracked file (should NOT appear)
      await fs.writeFile(path.join(ws.cwd, "tracked.txt"), "changed\n");
      // Create new file (SHOULD appear)
      await fs.writeFile(path.join(ws.cwd, "brand-new.txt"), "new content\n");

      const diff = await ws.diff({ scope: "untracked" });
      expect(diff).toContain("brand-new.txt");
      expect(diff).not.toContain("tracked.txt");
    } finally {
      await ws.cleanup({ deleteBranch: true });
    }
  });

  it("diff({ stat: true }) returns summary instead of full patch", async () => {
    await fs.writeFile(path.join(repoDir, "tracked.txt"), "original\n");
    execSync("git add tracked.txt && git commit -m 'add tracked'", { cwd: repoDir });

    const ws = await prepareWorkspace(repoDir, { strategy: "worktree" });
    try {
      await fs.writeFile(path.join(ws.cwd, "tracked.txt"), "modified\n");
      await fs.writeFile(path.join(ws.cwd, "newfile.txt"), "new\n");

      const stat = await ws.diff({ stat: true });
      // Stat output should mention files but NOT have +/- patch lines
      expect(stat).toContain("tracked.txt");
      expect(stat).toContain("newfile.txt");
      expect(stat).not.toContain("+modified");
    } finally {
      await ws.cleanup({ deleteBranch: true });
    }
  });

  it("diff(string) works as shorthand for diff({ base: string })", async () => {
    const ws = await prepareWorkspace(repoDir, { strategy: "worktree" });
    try {
      await fs.writeFile(path.join(ws.cwd, "file.txt"), "content\n");
      execSync("git add file.txt && git commit -m 'add file'", { cwd: ws.cwd });

      // Pass base as plain string
      const diff = await ws.diff("main");
      expect(diff).toContain("file.txt");
      expect(diff).toContain("+content");
    } finally {
      await ws.cleanup({ deleteBranch: true });
    }
  });

  it("diff() combines committed, uncommitted, and untracked changes", async () => {
    await fs.writeFile(path.join(repoDir, "existing.txt"), "original\n");
    execSync("git add existing.txt && git commit -m 'add existing'", { cwd: repoDir });

    const ws = await prepareWorkspace(repoDir, { strategy: "worktree" });
    try {
      // Committed change
      await fs.writeFile(path.join(ws.cwd, "committed.txt"), "committed\n");
      execSync("git add committed.txt && git commit -m 'add committed'", { cwd: ws.cwd });

      // Uncommitted change to tracked file
      await fs.writeFile(path.join(ws.cwd, "existing.txt"), "changed\n");

      // Untracked new file
      await fs.writeFile(path.join(ws.cwd, "brand-new.txt"), "new\n");

      const diff = await ws.diff();
      expect(diff).toContain("committed.txt");
      expect(diff).toContain("existing.txt");
      expect(diff).toContain("brand-new.txt");
    } finally {
      await ws.cleanup({ deleteBranch: true });
    }
  });

  it("cleanup() removes the worktree directory", async () => {
    const ws = await prepareWorkspace(repoDir, { strategy: "worktree" });
    const worktreePath = ws.cwd;

    // Worktree should exist before cleanup
    const statBefore = await fs.stat(worktreePath);
    expect(statBefore.isDirectory()).toBe(true);

    await ws.cleanup();

    // Worktree directory should be removed after cleanup
    await expect(fs.stat(worktreePath)).rejects.toThrow();
  });

  it("cleanup({ deleteBranch: true }) also removes the branch", async () => {
    const ws = await prepareWorkspace(repoDir, { strategy: "worktree" });
    const branchName = ws.branch;

    // Branch should exist before cleanup
    const branchesBefore = execSync("git branch", { cwd: repoDir, encoding: "utf-8" });
    expect(branchesBefore).toContain(branchName);

    await ws.cleanup({ deleteBranch: true });

    // Branch should be removed after cleanup with deleteBranch
    const branchesAfter = execSync("git branch", { cwd: repoDir, encoding: "utf-8" });
    expect(branchesAfter).not.toContain(branchName);
  });

  it("throws when cwd is not a git repository", async () => {
    const nonGitDir = await fs.mkdtemp(path.join(os.tmpdir(), "non-git-"));

    try {
      await expect(
        prepareWorkspace(nonGitDir, { strategy: "worktree" }),
      ).rejects.toThrow("Not a git repository");
    } finally {
      await fs.rm(nonGitDir, { recursive: true, force: true });
    }
  });

  it("uses custom branchName when provided", async () => {
    const customBranch = `test-branch-${Date.now()}`;
    const ws = await prepareWorkspace(repoDir, {
      strategy: "worktree",
      branchName: customBranch,
    });

    try {
      expect(ws.branch).toBe(customBranch);

      const branches = execSync("git branch", { cwd: repoDir, encoding: "utf-8" });
      expect(branches).toContain(customBranch);
    } finally {
      await ws.cleanup({ deleteBranch: true });
    }
  });

  it("preserves originalCwd on the returned workspace", async () => {
    const ws = await prepareWorkspace(repoDir, { strategy: "worktree" });

    try {
      expect(ws.originalCwd).toBe(repoDir);
    } finally {
      await ws.cleanup();
    }
  });
});
