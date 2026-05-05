import { afterEach, describe, expect, it } from "vitest";
import * as net from "node:net";
import * as path from "node:path";
import { workspace } from "../src/index.js";
import { makeTmpDir, removeTmpDir } from "./helpers.js";

const tmpDirs: string[] = [];

afterEach(async () => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop();
    if (dir) await removeTmpDir(dir);
  }
});

async function makeWorkspace(label: string) {
  const root = await makeTmpDir(label);
  tmpDirs.push(root);
  const wsPath = path.join(root, "ws");
  return workspace.create({ kind: "bare", path: wsPath });
}

function bind(port: number): Promise<net.Server> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen({ host: "127.0.0.1", port }, () => resolve(server));
  });
}

function close(server: net.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

describe("PortAllocator", () => {
  it("allocate(3) returns 3 distinct positive port numbers", async () => {
    const ws = await makeWorkspace("ports-3");
    const ports = await ws.ports.allocate(3);

    expect(ports).toHaveLength(3);
    expect(new Set(ports).size).toBe(3);
    for (const port of ports) {
      expect(port).toBeGreaterThan(0);
      expect(port).toBeLessThan(65_536);
    }
  });

  it("allocate returns ports that are actually bindable", async () => {
    const ws = await makeWorkspace("ports-bindable");
    const ports = await ws.ports.allocate(2);

    const servers: net.Server[] = [];
    try {
      for (const port of ports) {
        servers.push(await bind(port));
      }
    } finally {
      for (const s of servers) await close(s);
    }
  });

  it("held() reflects allocated ports; release removes from held", async () => {
    const ws = await makeWorkspace("ports-held");

    expect(ws.ports.held()).toEqual([]);

    const ports = await ws.ports.allocate(3);
    const held = ws.ports.held();
    expect(held).toEqual([...ports].sort((a, b) => a - b));

    ws.ports.release(ports[0]!);
    expect(ws.ports.held()).not.toContain(ports[0]);
    expect(ws.ports.held()).toHaveLength(2);
  });

  it("rejects non-positive or non-integer counts", async () => {
    const ws = await makeWorkspace("ports-bad-count");
    await expect(ws.ports.allocate(0)).rejects.toThrow(/positive integer/);
    await expect(ws.ports.allocate(-1)).rejects.toThrow(/positive integer/);
    await expect(ws.ports.allocate(1.5)).rejects.toThrow(/positive integer/);
  });
});
