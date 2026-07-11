import type { ProviderRuntimeContext } from "../../types.js";
import { findBinary } from "../../utils/binary.js";
import { buildEnv, ensurePathInEnv } from "../../utils/env.js";
import { acquireOpenCodeServer } from "./server.js";

export async function acquireOpenCodeRuntime(ctx: ProviderRuntimeContext = {}) {
  const resolved = await findBinary("opencode", ctx.config?.command);
  const env = buildEnv(ctx.env);
  ensurePathInEnv(env);
  const cwd = ctx.cwd ?? process.cwd();
  const server = await acquireOpenCodeServer(resolved.bin, resolved.prefixArgs, env, cwd);
  return { resolved, env, cwd, server };
}
