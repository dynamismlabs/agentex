import * as net from "node:net";
import type { PortAllocator } from "./types.js";

interface Probe {
  port: number;
  close: () => Promise<void>;
}

function probeFreePort(): Promise<Probe> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen({ host: "127.0.0.1", port: 0 }, () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        server.close();
        reject(new Error("Could not resolve port from server address"));
        return;
      }
      const port = addr.port;
      resolve({
        port,
        close: () =>
          new Promise<void>((res) => {
            server.close(() => res());
          }),
      });
    });
  });
}

export function createPortAllocator(): PortAllocator {
  const heldSet = new Set<number>();

  async function allocate(count: number): Promise<number[]> {
    if (!Number.isInteger(count) || count <= 0) {
      throw new Error(
        `PortAllocator.allocate: count must be a positive integer (got ${count})`,
      );
    }

    // Probe in parallel so the OS doesn't hand us the same port for two
    // simultaneous probes. Use allSettled so a single probe failure doesn't
    // strand the others holding sockets — we close every successful probe
    // before returning (or re-throwing).
    const results = await Promise.allSettled(
      Array.from({ length: count }, () => probeFreePort()),
    );

    const successes: Probe[] = [];
    let firstFailure: unknown = null;
    for (const r of results) {
      if (r.status === "fulfilled") successes.push(r.value);
      else if (firstFailure === null) firstFailure = r.reason;
    }

    // Always close every socket we opened so we don't leak fds — even on the
    // failure path.
    await Promise.all(successes.map((p) => p.close()));

    if (firstFailure !== null) throw firstFailure;

    const ports = successes.map((p) => p.port);
    for (const port of ports) heldSet.add(port);
    return ports;
  }

  function release(port: number): void {
    heldSet.delete(port);
  }

  function held(): number[] {
    return Array.from(heldSet).sort((a, b) => a - b);
  }

  return { allocate, release, held };
}
