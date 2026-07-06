// Node module-load hook — runs on the loader thread; sync fs is fine here.
// Appends every resolved module URL to $AGENTEX_LOAD_LOG so a probe process can
// prove exactly which files a given import pulls into the module graph.
import { appendFileSync } from "node:fs";

export async function load(url, context, nextLoad) {
  if (process.env.AGENTEX_LOAD_LOG && url.startsWith("file:")) {
    appendFileSync(process.env.AGENTEX_LOAD_LOG, url + "\n");
  }
  return nextLoad(url, context);
}
