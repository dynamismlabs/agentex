import type { ProviderRuntimeContext } from "../../types.js";
import { findBinary, type ResolvedBinary } from "../../utils/binary.js";

export async function findCursorBinary(ctx: ProviderRuntimeContext = {}): Promise<ResolvedBinary> {
  if (ctx.config?.command) return findBinary("agent", ctx.config.command);
  try {
    return await findBinary("agent");
  } catch {
    return findBinary("cursor-agent");
  }
}
