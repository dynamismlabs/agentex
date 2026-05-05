import { makeCommonHandle } from "./common-handle.js";
import type { BareWorkspace } from "../types.js";

export function makeBareHandle(opts: {
  path: string;
  source: string | undefined;
}): BareWorkspace {
  const common = makeCommonHandle({
    path: opts.path,
    source: opts.source,
    requireSource: false,
  });
  return {
    kind: "bare",
    ...common,
    source: opts.source,
  };
}
