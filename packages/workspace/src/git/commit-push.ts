import {
  addAll,
  commitMessage,
  pushDefault,
  pushSetUpstream,
} from "./commands.js";
import { looksLikeNoUpstream, readStderrFromUnknown } from "./stderr.js";
import { readStatus } from "./status.js";

const DEFAULT_REMOTE = "origin";

export async function commitChanges(workspacePath: string, message: string): Promise<void> {
  if (typeof message !== "string" || message.trim().length === 0) {
    throw new Error("commit: message must be a non-empty string");
  }
  const status = await readStatus(workspacePath);
  if (!status.dirty) {
    throw new Error("commit: nothing to commit (workspace is clean)");
  }
  await addAll(workspacePath);
  await commitMessage(workspacePath, message);
}

/**
 * Push the current branch. If git rejects with "no upstream branch," set
 * `<DEFAULT_REMOTE>/<branch>` as the upstream and retry.
 */
export async function pushCurrentBranch(workspacePath: string, branch: string): Promise<void> {
  try {
    await pushDefault(workspacePath);
  } catch (err) {
    const stderr = readStderrFromUnknown(err);
    if (looksLikeNoUpstream(stderr)) {
      await pushSetUpstream(workspacePath, DEFAULT_REMOTE, branch);
      return;
    }
    throw err;
  }
}
