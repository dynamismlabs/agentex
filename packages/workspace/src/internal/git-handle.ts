import {
  createCheckpoint,
  deleteCheckpoint,
  listCheckpoints,
  restoreCheckpoint,
} from "../git/checkpoints.js";
import { checkout, rawGit } from "../git/commands.js";
import { commitChanges, pushCurrentBranch } from "../git/commit-push.js";
import { readStructuredDiff } from "../git/diff.js";
import { mergeFromInto, pullLatestBaseInto } from "../git/pull.js";
import { addRemote, setOrigin } from "../git/remotes.js";
import { readShortstat, readStatus } from "../git/status.js";
import { makeCommonHandle } from "./common-handle.js";
import type { DiffSpec, GitCapability, GitWorkspace } from "../types.js";

const CHECKPOINTS_PREFIX = "refs/worktree/agentex/checkpoints/";

function resolveDiffRef(spec: DiffSpec, baseSha: string): string {
  if (spec === "base") return baseSha;
  return `${CHECKPOINTS_PREFIX}${spec.checkpoint}`;
}

export function makeGitHandle(opts: {
  path: string;
  source: string;
  branch: string;
  base: string;
  baseSha: string;
  baseShaIsFreshlyDerived?: boolean;
}): GitWorkspace {
  const common = makeCommonHandle({
    path: opts.path,
    source: opts.source,
    requireSource: true,
  });

  const git: GitCapability = {
    branch: opts.branch,
    base: opts.base,
    baseSha: opts.baseSha,
    ...(opts.baseShaIsFreshlyDerived ? { baseShaIsFreshlyDerived: true as const } : {}),
    async status() {
      return readStatus(opts.path);
    },
    async shortstat(vs) {
      return readShortstat(opts.path, resolveDiffRef(vs, opts.baseSha));
    },
    async commit(message) {
      await commitChanges(opts.path, message);
    },
    async push() {
      await pushCurrentBranch(opts.path, opts.branch);
    },
    async pullLatestBase(pullOpts) {
      await pullLatestBaseInto({
        workspacePath: opts.path,
        base: opts.base,
        strategy: pullOpts?.strategy ?? "merge",
      });
    },
    async diff(vs) {
      return readStructuredDiff(opts.path, resolveDiffRef(vs, opts.baseSha));
    },
    async checkpoint(label) {
      await createCheckpoint(opts.path, label);
    },
    async restore(label) {
      await restoreCheckpoint(opts.path, label);
    },
    async checkpoints() {
      return listCheckpoints(opts.path);
    },
    async deleteCheckpoint(label) {
      await deleteCheckpoint(opts.path, label);
    },
    async checkout(ref) {
      if (typeof ref !== "string" || ref.length === 0) {
        throw new Error("ws.git.checkout: ref must be a non-empty string");
      }
      await checkout(opts.path, ref);
    },
    async mergeFrom(ref, mergeOpts) {
      if (typeof ref !== "string" || ref.length === 0) {
        throw new Error("ws.git.mergeFrom: ref must be a non-empty string");
      }
      await mergeFromInto({
        workspacePath: opts.path,
        ref,
        strategy: mergeOpts?.strategy ?? "merge",
      });
    },
    async addRemote(name, url) {
      await addRemote(opts.path, name, url);
    },
    async setOrigin(url) {
      await setOrigin(opts.path, url);
    },
    async raw(args) {
      if (!Array.isArray(args)) {
        throw new Error("ws.git.raw: args must be an array of strings");
      }
      for (const a of args) {
        if (typeof a !== "string") {
          throw new Error(`ws.git.raw: each arg must be a string (got ${typeof a})`);
        }
      }
      return rawGit(opts.path, args);
    },
  };

  return {
    kind: "git",
    ...common,
    source: opts.source,
    git,
  };
}
