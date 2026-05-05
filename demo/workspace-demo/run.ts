/**
 * @agentex/workspace + @agentex/github lifecycle demo.
 *
 * Walks every primitive in @agentex/workspace against a freshly-created
 * scratch source repo + bare remote in /tmp (so the workspace half needs no
 * real GitHub auth and no existing repo on disk).
 *
 * The @agentex/github half is gated on env vars:
 *   GH_DEMO_REPO=owner/name        — runs read-only ops against this repo
 *   GH_DEMO_CREATE_PR=1            — also creates a real *draft* PR + cleanup
 *
 * Inspect-the-filesystem mode:
 *   KEEP_DEMO=1                    — skip archive + cleanup so you can poke at
 *                                    the scratch source repo + worktree on disk.
 *                                    A "Verifying the worktree relationship"
 *                                    section explicitly demonstrates the
 *                                    worktree-of-parent linkage.
 *
 * Usage:
 *   npx tsx demo/workspace-demo/run.ts
 *   KEEP_DEMO=1 npx tsx demo/workspace-demo/run.ts
 *   GH_DEMO_REPO=your-org/your-sandbox-repo npx tsx demo/workspace-demo/run.ts
 *   GH_DEMO_REPO=your-org/your-sandbox-repo GH_DEMO_CREATE_PR=1 npx tsx demo/workspace-demo/run.ts
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";

import { workspace } from "../../packages/workspace/src/index.js";
import { github } from "../../packages/github/src/index.js";

const exec = promisify(execFile);
const _filename = fileURLToPath(import.meta.url);
void _filename;

/* -------------------------------------------------------------------------- */
/*                              tiny output helpers                           */
/* -------------------------------------------------------------------------- */

const c = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  gray: "\x1b[90m",
};

function banner(title: string): void {
  const line = "═".repeat(Math.max(60, title.length + 6));
  console.log(`\n${c.bold}${c.cyan}${line}${c.reset}`);
  console.log(`${c.bold}${c.cyan}   ${title}${c.reset}`);
  console.log(`${c.bold}${c.cyan}${line}${c.reset}`);
}

function section(title: string): void {
  console.log(`\n${c.bold}${c.magenta}▶ ${title}${c.reset}`);
}

function step(msg: string): void {
  console.log(`  ${c.dim}→${c.reset} ${msg}`);
}

function kv(label: string, value: string | number | boolean | undefined): void {
  console.log(`    ${c.gray}${label.padEnd(28)}${c.reset} ${String(value)}`);
}

function note(msg: string): void {
  console.log(`    ${c.dim}${msg}${c.reset}`);
}

function ok(msg: string): void {
  console.log(`  ${c.green}✓${c.reset} ${msg}`);
}

function warn(msg: string): void {
  console.log(`  ${c.yellow}![${c.reset}] ${msg}`);
}

function header(msg: string): void {
  console.log(`\n${c.bold}${msg}${c.reset}`);
}

/* -------------------------------------------------------------------------- */
/*                             scratch repo setup                             */
/* -------------------------------------------------------------------------- */

async function git(cwd: string, ...args: string[]): Promise<string> {
  const r = await exec("git", args, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
  return r.stdout.toString();
}

async function writeFile(p: string, body: string): Promise<void> {
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, body, "utf-8");
}

async function makeScratchRoot(): Promise<string> {
  const id = randomBytes(4).toString("hex");
  const dir = path.join(os.tmpdir(), `agentex-demo-${id}`);
  await fs.mkdir(dir, { recursive: true });
  return await fs.realpath(dir);
}

async function buildScratchSource(rootDir: string): Promise<{
  sourcePath: string;
  remotePath: string;
}> {
  const sourcePath = path.join(rootDir, "source");
  const remotePath = path.join(rootDir, "remote.git");

  // Bare remote so we can demo push/pull without a real GitHub.
  await fs.mkdir(remotePath, { recursive: true });
  await git(remotePath, "init", "--bare", "-b", "main");
  await git(remotePath, "symbolic-ref", "HEAD", "refs/heads/main");

  // Source repo with realistic structure.
  await fs.mkdir(sourcePath, { recursive: true });
  await git(sourcePath, "init", "-b", "main");
  await git(sourcePath, "config", "user.email", "demo@example.com");
  await git(sourcePath, "config", "user.name", "Demo");
  await git(sourcePath, "config", "commit.gpgsign", "false");

  await writeFile(path.join(sourcePath, "README.md"), "# scratch repo for the agentex demo\n");
  await writeFile(
    path.join(sourcePath, "src", "index.ts"),
    "export const hello = (name: string) => `hello ${name}`;\n",
  );
  await writeFile(
    path.join(sourcePath, "src", "lib", "utils.ts"),
    "export const add = (a: number, b: number) => a + b;\n",
  );
  await writeFile(
    path.join(sourcePath, "package.json"),
    JSON.stringify({ name: "scratch", version: "0.0.0" }, null, 2) + "\n",
  );
  // Mirrors the typical Conductor pattern: env holds secrets, shared holds
  // runtime data (db, caches). Both are gitignored so the worktree's checkout
  // doesn't include them — `fromSource` then copies/links them in fresh.
  // Use bare names (no trailing slash) so the pattern also matches a symlink
  // entry that points at a directory (which `dir/` would skip).
  await writeFile(path.join(sourcePath, ".gitignore"), "env\nshared\n");
  // Declarative config — exercises auto-applied fromSource + scripts.
  await writeFile(
    path.join(sourcePath, "agentex.workspace.json"),
    JSON.stringify(
      {
        scripts: {
          // Long-running script for the runScript demo. Emits a heartbeat then
          // sleeps; we kill it after a beat to demonstrate process-group
          // teardown.
          run: 'echo "[run] starting; AGENTEX_PORT=$AGENTEX_PORT"; while true; do echo "[run] beat"; sleep 0.5; done',
          archive: 'echo "[archive] tear-down ran for $AGENTEX_WORKSPACE"',
        },
        fromSource: {
          // env/.env will be auto-copied; `shared` will be auto-symlinked.
          copy: ["env/**"],
          link: ["shared"],
        },
      },
      null,
      2,
    ) + "\n",
  );

  await git(sourcePath, "add", "-A");
  await git(sourcePath, "commit", "-m", "initial scratch repo");

  // Untracked files in the source — kept around (gitignored) so the workspace
  // can pick them up via `fromSource`, but not part of the checkout.
  await writeFile(path.join(sourcePath, "env", ".env"), "API_KEY=demo-key\n");
  await writeFile(path.join(sourcePath, "shared", "blob.bin"), "shared bytes");

  // Wire to the bare remote so push/pull work.
  await git(sourcePath, "remote", "add", "origin", remotePath);
  await git(sourcePath, "push", "-u", "origin", "main");

  return { sourcePath, remotePath };
}

/* -------------------------------------------------------------------------- */
/*                          stream consumption helper                         */
/* -------------------------------------------------------------------------- */

async function readStreamFor(
  stream: ReadableStream<Uint8Array>,
  ms: number,
): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let collected = "";
  const deadline = Date.now() + ms;

  // Read until either the stream ends or we hit the deadline.
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    const raceTimer: Promise<{ done: true; value?: undefined }> = new Promise((resolve) =>
      setTimeout(() => resolve({ done: true }), remaining),
    );
    const next = reader.read() as Promise<{ done: boolean; value?: Uint8Array }>;
    const result = await Promise.race([next, raceTimer]);
    if (result.done) break;
    if (result.value) collected += decoder.decode(result.value);
  }

  // Best-effort: release reader so the stream isn't held open by us.
  try {
    reader.releaseLock();
  } catch {
    // ignore
  }
  return collected;
}

/* -------------------------------------------------------------------------- */
/*                         WORKSPACE — full lifecycle                         */
/* -------------------------------------------------------------------------- */

async function runWorkspaceDemo(rootDir: string): Promise<void> {
  banner("@agentex/workspace — full lifecycle");

  section("Building a scratch source repo + bare remote");
  const { sourcePath, remotePath } = await buildScratchSource(rootDir);
  kv("source repo", sourcePath);
  kv("bare remote", remotePath);

  /* ---- create ---- */
  section("workspace.create({ kind: 'git', ... })");
  const wsPath = path.join(rootDir, "ws-feature");
  const ws = await workspace.create({
    kind: "git",
    source: sourcePath,
    baseBranch: "main",
    path: wsPath,
    branch: "feature/demo",
  });
  if (ws.kind !== "git") throw new Error("expected git workspace");
  kv("kind", ws.kind);
  kv("path", ws.path);
  kv("source", ws.source);
  kv("git.branch", ws.git.branch);
  kv("git.base", ws.git.base);
  kv("git.baseSha", ws.git.baseSha.slice(0, 8) + "…");
  kv("baseShaIsFreshlyDerived", ws.git.baseShaIsFreshlyDerived ?? false);
  ok("worktree created on a fresh branch; baseSha captured atomically");

  /* ---- declarative fromSource auto-applied ---- */
  section("Declarative fromSource (auto-applied at create)");
  const envCopied = await fileExists(path.join(wsPath, "env", ".env"));
  const sharedStat = await fs.lstat(path.join(wsPath, "shared"));
  kv("env/.env copied", envCopied);
  kv("shared is symlink", sharedStat.isSymbolicLink());
  kv("fromSourceWarnings.skippedOutsideSparse", JSON.stringify(ws.fromSourceWarnings.skippedOutsideSparse));
  ok("agentex.workspace.json fromSource block applied without consumer code");

  /* ---- ContextDir ---- */
  section("ws.context — agent's freeform side-channel");
  kv("dir (lazy)", ws.context.dir);
  await ws.context.write("notes.md", "agent: starting work on feature/demo\n");
  await ws.context.write("plans/q3.md", "step 1: implement\nstep 2: test\n");
  // Attach an arbitrary file (collision-suffix demo).
  const attachSrc = path.join(rootDir, "scratch-photo.png");
  await writeFile(attachSrc, "fake-image-bytes");
  const attachA = await ws.context.attach(attachSrc);
  const attachB = await ws.context.attach(attachSrc);
  kv("attached (1st)", path.basename(attachA));
  kv("attached (2nd, suffixed)", path.basename(attachB));
  kv("list .context/", JSON.stringify(await ws.context.list()));

  /* ---- PortAllocator ---- */
  section("ws.ports — free TCP port probing");
  const ports = await ws.ports.allocate(3);
  kv("allocate(3)", JSON.stringify(ports));
  kv("held()", JSON.stringify(ws.ports.held()));
  ws.ports.release(ports[1]!);
  kv("after release([1])", JSON.stringify(ws.ports.held()));

  /* ---- runScript with process-group teardown ---- */
  section("ws.runScript — long-running subprocess + clean teardown");
  step("Starting `run` script (heartbeat loop with sleep)");
  const handle = await ws.runScript("run");
  kv("pid", handle.pid);
  kv("AGENTEX_PORT seen by script", `(should be ${ports[0]} — first held)`);
  step("Reading combined stdout/stderr for ~1.5s, then killing the process group");
  const out = await readStreamFor(handle.output, 1500);
  for (const line of out.trim().split("\n").slice(0, 4)) {
    note(line);
  }
  await handle.kill();
  ok("kill() torn down the script + the sleep child (process group), and resolved");

  /* ---- status walk ---- */
  section("ws.git.status() — the basis for commit/push/merge buttons");
  step("Initially clean");
  let s = await ws.git.status();
  kv("dirty", s.dirty);
  kv("ahead / behind", `${s.ahead} / ${s.behind}`);

  step("Edit a tracked file + add a new untracked file");
  await writeFile(path.join(wsPath, "src", "index.ts"), "export const hello = () => 'agentex';\n");
  await writeFile(path.join(wsPath, "src", "lib", "new-helper.ts"), "export const x = 42;\n");
  s = await ws.git.status();
  kv("dirty", s.dirty);
  kv("modified", JSON.stringify(s.modified));
  kv("untracked", JSON.stringify(s.untracked));

  step("Render-button-state derivation:");
  kv("showCommit", s.dirty);
  kv("showPush", !s.dirty && s.ahead > 0);
  ok("UI would render the commit button now");

  /* ---- shortstat + diff ---- */
  section("ws.git.shortstat / diff");
  const stat = await ws.git.shortstat("base");
  kv("shortstat vs base", `${stat.files} files / +${stat.additions} -${stat.deletions}`);
  const diff = await ws.git.diff("base");
  kv("diff.files.length", diff.files.length);
  for (const f of diff.files) {
    note(`${f.status.padEnd(8)} ${f.path}  (hunks: ${f.hunks.length})`);
  }
  ok("Untracked files surface as synthetic 'added' entries with all-add hunks");

  /* ---- commit ---- */
  section("ws.git.commit — git add -A + commit");
  await ws.git.commit("agent: feature work");
  s = await ws.git.status();
  kv("dirty after commit", s.dirty);
  kv("ahead after commit", s.ahead);
  step("Render-button-state derivation:");
  kv("showCommit", s.dirty);
  kv("showPush", !s.dirty && s.ahead > 0);
  ok("UI would now render the push button");

  /* ---- checkpoints ---- */
  section("ws.git.checkpoint / restore — per-worktree refs (auto-cleaned on archive)");
  await ws.git.checkpoint("before-experiment");
  kv("checkpoints()", JSON.stringify(await ws.git.checkpoints()));
  await writeFile(path.join(wsPath, "scratch.md"), "experimental\n");
  await ws.git.commit("agent: experiment");
  step("After the experiment commit:");
  kv("checkpoints()", JSON.stringify(await ws.git.checkpoints()));
  step("diff vs the checkpoint:");
  const cpDiff = await ws.git.diff({ checkpoint: "before-experiment" });
  for (const f of cpDiff.files) {
    note(`${f.status.padEnd(8)} ${f.path}`);
  }
  step("restore('before-experiment') — git reset --hard back");
  await ws.git.restore("before-experiment");
  s = await ws.git.status();
  kv("dirty after restore", s.dirty);
  kv("ahead after restore", s.ahead);
  await ws.git.deleteCheckpoint("before-experiment");
  kv("checkpoints() after delete", JSON.stringify(await ws.git.checkpoints()));

  /* ---- tree ---- */
  section("ws.tree — sorted recursive walk (.git always skipped)");
  const tree = await ws.tree();
  printTree(tree, 0);

  /* ---- watch ---- */
  section("ws.watch — debounced FS events");
  const events: string[] = [];
  const sub = ws.watch((batch) => {
    for (const e of batch) events.push(`${e.kind} ${path.relative(wsPath, e.path)}`);
  });
  await sub.ready;
  step("Ready. Writing 3 files in quick succession…");
  await writeFile(path.join(wsPath, "watched-a.txt"), "a");
  await writeFile(path.join(wsPath, "watched-b.txt"), "b");
  await writeFile(path.join(wsPath, "watched-c.txt"), "c");
  await sleep(300);
  for (const e of events.slice(0, 6)) note(e);
  sub.dispose();
  ok(`Received ${events.length} event(s) in batched form, then disposed cleanly`);

  /* ---- mergeFrom (local) ---- */
  section("ws.git.mergeFrom — local merge of another branch into current");
  step("Setting up a `develop` branch on the source with a non-conflicting commit");
  await git(sourcePath, "checkout", "-b", "develop");
  await writeFile(path.join(sourcePath, "from-develop.md"), "develop only\n");
  await git(sourcePath, "add", "-A");
  await git(sourcePath, "commit", "-m", "develop: add from-develop.md");
  await git(sourcePath, "checkout", "main");
  step("Merge develop into the worktree's current branch");
  await ws.git.mergeFrom("develop");
  kv("from-develop.md present in workspace", await fileExists(path.join(wsPath, "from-develop.md")));
  ok("ws.git.mergeFrom() merged a local branch (no fetch); MergeConflictError on conflicts");

  /* ---- push (sets up upstream) ---- */
  section("ws.git.push — first push sets upstream");
  await ws.git.push();
  s = await ws.git.status();
  kv("ahead after push", s.ahead);
  ok("Branch published to origin");

  /* ---- raw escape hatch ---- */
  section("ws.git.raw — escape hatch for ops the typed surface doesn't cover");
  const log = await ws.git.raw(["log", "--oneline", "-3"]);
  kv("exitCode", log.exitCode);
  for (const line of log.stdout.trim().split("\n")) note(line);

  /* ---- detect helpers ---- */
  section("workspace.detectKind / detectDefaultBranch");
  kv("detectKind(ws.path)", await workspace.detectKind(ws.path));
  kv("detectDefaultBranch(source)", await workspace.detectDefaultBranch(sourcePath));

  /* ---- open round-trip ---- */
  section("workspace.open — re-hydrate the same handle from path alone");
  const reopened = await workspace.open(wsPath);
  if (reopened.kind !== "git") throw new Error("expected git on reopen");
  kv("path matches", reopened.path === ws.path);
  kv("source matches", reopened.source === ws.source);
  kv("git.branch matches", reopened.git.branch === ws.git.branch);
  kv("git.baseSha matches", reopened.git.baseSha === ws.git.baseSha);
  kv("baseShaIsFreshlyDerived", reopened.git.baseShaIsFreshlyDerived ?? false);

  /* ---- worktree relationship ---- */
  section("Verifying the worktree-of-parent relationship");
  step("`.git` in the worktree is a *pointer file*, not a directory:");
  const dotGitStat = await fs.lstat(path.join(wsPath, ".git"));
  kv("type", dotGitStat.isFile() ? "file (worktree pointer)" : dotGitStat.isDirectory() ? "directory (main repo)" : "other");
  const dotGitContent = await fs.readFile(path.join(wsPath, ".git"), "utf-8");
  note(dotGitContent.trim());

  step("From the source: `git worktree list` shows our worktree:");
  const wtList = await git(sourcePath, "worktree", "list");
  for (const line of wtList.trim().split("\n")) note(line);

  step("Branches: source and worktree share the same ref database");
  const sourceBranches = await git(sourcePath, "branch", "-a");
  const wsBranches = await git(wsPath, "branch", "-a");
  step(`source: \`git branch -a\` →`);
  for (const line of sourceBranches.trim().split("\n").slice(0, 8)) note(line);
  step(`worktree: \`git branch -a\` →`);
  for (const line of wsBranches.trim().split("\n").slice(0, 8)) note(line);
  ok("Both see feature/demo, develop, main — they're the same git object database");

  step("Live proof: a commit in the worktree shows up in the source's view of the branch");
  await writeFile(path.join(wsPath, "live-proof.md"), "written in the worktree\n");
  await ws.git.commit("worktree commit visible from source");
  await ws.git.push(); // flush so the dirty-archive demo below stays clean
  const sourceLog = await git(sourcePath, "log", "--oneline", "-1", "feature/demo");
  kv("source: git log -1 feature/demo", sourceLog.trim());

  /* ---- bare workspace (mini) ---- */
  section("workspace.create({ kind: 'bare' }) — drafting / non-code work");
  const barePath = path.join(rootDir, "ws-bare");
  const bare = await workspace.create({ kind: "bare", path: barePath });
  if (bare.kind !== "bare") throw new Error("expected bare");
  await bare.context.write("draft.md", "# A research note\n");
  kv("bare.path", bare.path);
  kv("bare.kind", bare.kind);
  kv("bare.context.dir", bare.context.dir);
  kv(".context/draft.md exists", await fileExists(path.join(bare.context.dir, "draft.md")));

  /* ---- archive (clean dirty-check + auto checkpoint cleanup) ---- */
  if (process.env.KEEP_DEMO === "1") {
    section("Skipping workspace.archive (KEEP_DEMO=1)");
    note(`Source repo:   ${sourcePath}`);
    note(`Worktree:      ${ws.path}`);
    note(`Bare workspace: ${bare.path}`);
    note(`Bare remote:   ${remotePath}`);
    note("");
    note("Try poking at it:");
    note(`  cat ${path.join(ws.path, ".git")}                 # worktree pointer file`);
    note(`  git -C ${sourcePath} worktree list                # source's view of all worktrees`);
    note(`  git -C ${sourcePath} log --oneline -5 feature/demo  # source sees the worktree's commits`);
    note(`  git -C ${ws.path} log --oneline -5 main           # worktree sees the source's commits`);
    note(`  ls -la ${ws.path}                                 # full worktree contents`);
    note(`  ls -la ${ws.context.dir}                          # the agent's .context/ side-channel`);
    note("");
    note("When done inspecting, remove the scratch tree:");
    note(`  rm -rf ${rootDir}`);
    return; // keep `bare` and `ws` on disk; skip cleanup in main()
  }

  section("workspace.archive — status-checked teardown + per-worktree ref cleanup");
  // The watch + live-proof flow above already committed + pushed everything,
  // so the worktree is clean here. Show that archive succeeds without `force`
  // when status passes the dirty-check.
  await ws.git.checkpoint("doomed");
  step("Archive without force on a clean worktree (status passes)");
  await workspace.archive(ws.path);
  ok("Worktree removed; archive script ran; per-worktree checkpoints auto-cleaned");

  step("Verify the source has no leftover `refs/worktree/agentex/checkpoints/*`");
  const leftover = await git(sourcePath, "for-each-ref", "--format=%(refname)", "refs/worktree/");
  kv("leftover refs", leftover.trim() === "" ? "(none)" : leftover.trim());

  step("Archive the bare workspace too");
  await workspace.archive(bare.path);
  kv("bare path still exists", await fileExists(bare.path));
}

function printTree(node: { name: string; kind: string; children?: readonly { name: string; kind: string; children?: readonly unknown[] }[] }, depth: number): void {
  const indent = "    " + "  ".repeat(depth);
  const marker = node.kind === "dir" ? "/" : "";
  console.log(`${indent}${c.gray}${node.name}${marker}${c.reset}`);
  if (node.children && depth < 3) {
    for (const child of node.children.slice(0, 6)) {
      printTree(child as { name: string; kind: string; children?: readonly { name: string; kind: string; children?: readonly unknown[] }[] }, depth + 1);
    }
    if (node.children.length > 6) {
      console.log(`${indent}  ${c.gray}… and ${node.children.length - 6} more${c.reset}`);
    }
  }
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.lstat(p);
    return true;
  } catch {
    return false;
  }
}

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/* -------------------------------------------------------------------------- */
/*                            GITHUB — opt-in section                         */
/* -------------------------------------------------------------------------- */

async function runGithubDemo(rootDir: string): Promise<void> {
  const ghRepo = process.env.GH_DEMO_REPO;
  const allowCreate = process.env.GH_DEMO_CREATE_PR === "1";

  banner("@agentex/github");

  /* ---- preflight always runs ---- */
  section("github.checkInstalled / checkAuthenticated");
  const installed = await github.checkInstalled();
  kv("installed", installed.installed);
  kv("version", installed.version ?? "(unknown)");
  kv("path", installed.path ?? "(unknown)");
  if (!installed.installed) {
    warn("`gh` is not on PATH — install via `brew install gh` to exercise the github surface");
    return;
  }
  const authed = await github.checkAuthenticated();
  kv("authenticated", authed.authenticated);
  kv("user", authed.user ?? "(unknown)");
  kv("host", authed.host ?? "(unknown)");
  if (!authed.authenticated) {
    warn("`gh` is installed but not authenticated — run `gh auth login`");
    return;
  }

  if (!ghRepo) {
    note("");
    note("To exercise repo-scoped ops, set GH_DEMO_REPO=owner/name and re-run.");
    note("To also exercise PR creation against that repo, set GH_DEMO_CREATE_PR=1.");
    note("(The PR will be created as a draft and cleaned up at the end.)");
    return;
  }

  /* ---- read-only ops against the configured repo ---- */
  section(`Read-only ops against ${ghRepo}`);
  // Clone the repo into a tmp dir; create a workspace off the clone for the
  // PR-creation flow. Even for read-only ops we need a local clone because
  // `github.repo(path)` is path-scoped (cwd for the gh invocation).
  const cloneRoot = path.join(rootDir, "gh-clone");
  await fs.mkdir(cloneRoot, { recursive: true });
  step(`git clone https://github.com/${ghRepo} ${cloneRoot}`);
  await exec("git", ["clone", `https://github.com/${ghRepo}`, cloneRoot]);
  const repo = github.repo(cloneRoot);

  step("listPRs({ state: 'open' })");
  const openPRs = await repo.listPRs({ state: "open" });
  kv("open PRs", openPRs.length);
  for (const pr of openPRs.slice(0, 3)) {
    note(`#${pr.number}  ${pr.title}  (${pr.headRefName} → ${pr.baseRefName})`);
  }

  step("listIssues({ state: 'open' })");
  const openIssues = await repo.listIssues({ state: "open" });
  kv("open issues", openIssues.length);
  for (const issue of openIssues.slice(0, 3)) {
    note(`#${issue.number}  ${issue.title}`);
  }

  if (openPRs[0]) {
    step(`getPR(${openPRs[0].number}) — full detail`);
    const detail = await repo.getPR(openPRs[0].number);
    kv("state", detail.state);
    kv("isDraft", detail.isDraft);
    kv("review count", detail.reviews.length);
    kv("comment count", detail.comments.length);
    kv("statusCheckRollup", `${detail.statusCheckRollup.length} check(s)`);
    if (detail.statusCheckRollup.length > 0) {
      step("listChecks(<that PR>)");
      const checks = await repo.listChecks(openPRs[0].number);
      for (const ch of checks.slice(0, 5)) {
        note(`${(ch.conclusion || ch.status || "PENDING").padEnd(12)} ${ch.name}`);
      }
    }
  }

  if (!allowCreate) {
    note("");
    note("Skipping PR creation. Set GH_DEMO_CREATE_PR=1 to exercise the write flow.");
    return;
  }

  /* ---- write flow: create a draft PR via @agentex/workspace + cleanup ---- */
  section("Write flow: create + cleanup a draft PR");
  step("Creating an @agentex/workspace worktree off the cloned repo");

  const baseBranch = await workspace.detectDefaultBranch(cloneRoot);
  kv("detected default branch", baseBranch);

  const branch = `agentex-demo/${randomBytes(3).toString("hex")}`;
  const prWsPath = path.join(rootDir, "gh-ws");
  const prWs = await workspace.create({
    kind: "git",
    source: cloneRoot,
    baseBranch,
    path: prWsPath,
    branch,
  });
  if (prWs.kind !== "git") throw new Error("expected git");
  kv("worktree branch", prWs.git.branch);

  step("Making a tiny edit + commit + push");
  const docPath = path.join(prWsPath, "AGENTEX_DEMO.md");
  await writeFile(
    docPath,
    `# agentex lifecycle demo\n\nGenerated at ${new Date().toISOString()}\nbranch: ${branch}\n`,
  );
  await prWs.git.commit("agentex demo: tiny edit");
  await prWs.git.push();

  step("Creating draft PR via gh.createPR");
  // Long body to exercise the --body-file - / stdin path.
  const longBody = [
    "This PR was created by the @agentex/workspace + @agentex/github demo.",
    "",
    "Long body lorem ipsum: " + "lorem ipsum ".repeat(2_000),
  ].join("\n");
  const pr = await repo.createPR({
    base: baseBranch,
    head: branch,
    title: "agentex lifecycle demo (draft — safe to close)",
    body: longBody,
    draft: true,
  });
  kv("PR number", pr.number);
  kv("PR url", pr.url);
  kv("isDraft", pr.isDraft);

  step("listPRs({ head: branch }) — find the PR by branch");
  const found = await repo.listPRs({ head: branch });
  kv("matches", found.length);
  if (found[0]) kv("found PR url", found[0].url);

  step("commentOnPR — also exercises stdin-piped body");
  await repo.commentOnPR(pr.number, "Demo comment.");
  ok("Comment posted");

  step("listChecks(pr.number)");
  const checks = await repo.listChecks(pr.number);
  kv("checks", checks.length === 0 ? "(none configured on this repo)" : String(checks.length));
  for (const ch of checks.slice(0, 5)) {
    note(`${(ch.conclusion || ch.status || "PENDING").padEnd(12)} ${ch.name}`);
  }

  /* ---- cleanup: close PR + delete remote branch + archive workspace ---- */
  step("Cleanup: closing PR via raw gh, deleting the remote branch, archiving");
  // gh has no first-class `pr close` in our typed surface; use raw.
  const close = await prWs.git.raw([
    "-c",
    "core.editor=true",
    "log",
    "-1",
    "--oneline",
  ]);
  void close;
  await exec("gh", ["pr", "close", String(pr.number), "--delete-branch"], { cwd: cloneRoot });
  await workspace.archive(prWs.path, { force: true }); // dirty would have to be force; we just pushed so should be clean
  ok("Draft PR closed + branch deleted on the remote + worktree archived");
}

/* -------------------------------------------------------------------------- */
/*                                    main                                    */
/* -------------------------------------------------------------------------- */

async function main(): Promise<void> {
  const rootDir = await makeScratchRoot();
  let cleanupRoot: string | null = rootDir;

  banner("agentex lifecycle demo");
  console.log(`  ${c.dim}scratch root:${c.reset} ${rootDir}`);
  console.log(
    `  ${c.dim}env:${c.reset} GH_DEMO_REPO=${process.env.GH_DEMO_REPO ?? "(unset)"}, GH_DEMO_CREATE_PR=${process.env.GH_DEMO_CREATE_PR ?? "(unset)"}`,
  );

  try {
    await runWorkspaceDemo(rootDir);
    await runGithubDemo(rootDir);

    if (process.env.KEEP_DEMO === "1") {
      header("Done. Scratch dir left in place per KEEP_DEMO=1.");
      console.log(`  ${c.dim}${rootDir}${c.reset}`);
      cleanupRoot = null;
      return;
    }

    header("Done.");
    console.log(`  ${c.dim}Cleaning up scratch dir: ${rootDir}${c.reset}`);
    await fs.rm(rootDir, { recursive: true, force: true });
    cleanupRoot = null;
  } finally {
    if (cleanupRoot) {
      // On error, leave the scratch root in place so you can inspect it.
      console.log(
        `\n${c.yellow}![${c.reset}] Demo errored — scratch dir left for inspection: ${cleanupRoot}`,
      );
    }
  }
}

main().catch((err) => {
  console.error(`\n${c.red}Demo failed:${c.reset}`, err);
  process.exit(1);
});
