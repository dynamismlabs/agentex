import path from "node:path";
import { describe, expect, it } from "vitest";
import { acquireOpenCodeServer, openCodeRuntimeKey } from "../../../src/providers/opencode/server.js";

const MOCK_SERVER = path.resolve(import.meta.dirname, "../../fixtures/mock-opencode-server.mjs");
const env = Object.fromEntries(
  Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
);

async function eventuallyUnavailable(url: string): Promise<boolean> {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      await fetch(url);
    } catch {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return false;
}

describe("OpenCode authenticated server lifecycle", () => {
  it("keeps a shared server alive until its final handle is released", async () => {
    const first = await acquireOpenCodeServer(process.execPath, [MOCK_SERVER], env, process.cwd());
    const second = await acquireOpenCodeServer(process.execPath, [MOCK_SERVER], env, process.cwd());
    expect(second.client.baseUrl).toBe(first.client.baseUrl);
    expect((await fetch(`${first.client.baseUrl}/global/health`)).status).toBe(401);
    expect((await first.client.request("/global/health")).status).toBe(200);

    first.release();
    expect((await second.client.request("/global/health")).status).toBe(200);
    const url = second.client.baseUrl;
    second.release();
    expect(await eventuallyUnavailable(`${url}/global/health`)).toBe(true);
  });

  it("retires a runtime generation and marks existing handles stale", async () => {
    const handle = await acquireOpenCodeServer(process.execPath, [MOCK_SERVER], env, process.cwd());
    expect(handle.isCurrent()).toBe(true);
    await handle.retire({ force: true });
    expect(handle.isCurrent()).toBe(false);
    handle.release();
  });

  it("force-kills a daemon that ignores graceful termination", async () => {
    const handle = await acquireOpenCodeServer(
      process.execPath,
      [MOCK_SERVER],
      { ...env, MOCK_IGNORE_SIGTERM: "1" },
      process.cwd(),
    );
    const url = handle.client.baseUrl;
    handle.release();
    expect(await eventuallyUnavailable(`${url}/global/health`)).toBe(true);
  });

  it("hashes environment values out of runtime keys", () => {
    const key = openCodeRuntimeKey("opencode", "/repo", [], { TOKEN: "secret-value" });
    expect(key).not.toContain("secret-value");
  });
});
