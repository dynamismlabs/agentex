import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";
import { killProcessTree } from "../../utils/process.js";
import { OpenCodeClient } from "./client.js";

export interface OpenCodeServerHandle {
  client: OpenCodeClient;
  generation: number;
  release: () => void;
  retire: (options?: { force?: boolean }) => Promise<void>;
  retireAuthStore: (options?: { force?: boolean }) => Promise<void>;
  isCurrent: () => boolean;
}

interface PooledServer {
  key: string;
  generation: number;
  client: OpenCodeClient;
  proc: ChildProcess;
  refCount: number;
  retired: boolean;
}

const pool = new Map<string, Promise<PooledServer>>();
const generations = new Map<string, number>();
const runtimeAuthStores = new Map<string, string>();

export function openCodeAuthStoreKey(env: Record<string, string>): string {
  const home = env["HOME"] || os.homedir();
  const dataHome = env["XDG_DATA_HOME"] || path.join(home, ".local", "share");
  return path.resolve(dataHome, "opencode", "auth.json");
}

export function openCodeRuntimeKey(
  binary: string,
  cwd: string,
  prefixArgs: string[],
  env: Record<string, string>,
): string {
  const h = createHash("sha256");
  h.update(JSON.stringify(prefixArgs));
  h.update("\0");
  for (const key of Object.keys(env).sort()) h.update(`${key}=${env[key]}\n`);
  return `${binary}\0${cwd}\0${h.digest("hex")}`;
}

function kill(entry: PooledServer): void {
  if (entry.proc.exitCode !== null || entry.proc.signalCode !== null) return;
  try {
    if (entry.proc.pid != null) killProcessTree(entry.proc.pid, "SIGTERM");
    else entry.proc.kill("SIGTERM");
    const force = setTimeout(() => {
      if (entry.proc.pid != null) killProcessTree(entry.proc.pid, "SIGKILL");
      else if (entry.proc.exitCode === null) entry.proc.kill("SIGKILL");
    }, 1_000);
    force.unref();
    let openOutputStreams = Number(Boolean(entry.proc.stdout)) + Number(Boolean(entry.proc.stderr));
    const outputClosed = (): void => {
      openOutputStreams -= 1;
      if (openOutputStreams <= 0) clearTimeout(force);
    };
    entry.proc.stdout?.once("close", outputClosed);
    entry.proc.stderr?.once("close", outputClosed);
  } catch {
    // Best effort process cleanup.
  }
}

async function waitForHealth(client: OpenCodeClient, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await client.request("/global/health");
      if (response.ok) return;
    } catch {
      // Server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error("opencode serve failed authenticated health check within 10s");
}

async function startServer(
  key: string,
  generation: number,
  binary: string,
  prefixArgs: string[],
  env: Record<string, string>,
  cwd: string,
): Promise<PooledServer> {
  const password = randomBytes(32).toString("base64url");
  const proc = spawn(
    binary,
    [...prefixArgs, "serve", "--port", "0", "--hostname", "127.0.0.1"],
    {
      cwd,
      env: { ...env, OPENCODE_SERVER_PASSWORD: password },
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    },
  );

  try {
    const url = await new Promise<string>((resolve, reject) => {
      let output = "";
      const onData = (chunk: string): void => {
        output += chunk;
        const match = output.match(/listening on (http:\/\/\S+)/i);
        if (match) {
          cleanup();
          resolve(match[1]!.trim());
        }
      };
      const onExit = (code: number | null): void => {
        cleanup();
        reject(new Error(`opencode serve exited (code=${code}) before reporting a listen URL`));
      };
      const onError = (error: Error): void => {
        cleanup();
        reject(error);
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error("opencode serve did not report a listen URL within 20s"));
      }, 20_000);
      const cleanup = (): void => {
        clearTimeout(timer);
        proc.stdout?.off("data", onData);
        proc.stderr?.off("data", onData);
        proc.off("exit", onExit);
        proc.off("error", onError);
      };
      proc.stdout?.setEncoding("utf-8");
      proc.stderr?.setEncoding("utf-8");
      proc.stdout?.on("data", onData);
      proc.stderr?.on("data", onData);
      proc.on("exit", onExit);
      proc.on("error", onError);
    });

    const client = new OpenCodeClient(url, password);
    await waitForHealth(client, 10_000);
    return { key, generation, client, proc, refCount: 0, retired: false };
  } catch (error) {
    try {
      proc.kill();
    } catch {
      // Best effort process cleanup.
    }
    throw error;
  }
}

export async function retireOpenCodeRuntime(
  binary: string,
  prefixArgs: string[],
  env: Record<string, string>,
  cwd: string,
  options: { force?: boolean } = {},
): Promise<number> {
  const key = openCodeRuntimeKey(binary, cwd, prefixArgs, env);
  return retireRuntimeKey(key, options);
}

async function retireRuntimeKey(
  key: string,
  options: { force?: boolean } = {},
): Promise<number> {
  const nextGeneration = (generations.get(key) ?? 0) + 1;
  generations.set(key, nextGeneration);
  const pending = pool.get(key);
  pool.delete(key);
  runtimeAuthStores.delete(key);
  if (pending) {
    try {
      const entry = await pending;
      entry.retired = true;
      if (options.force || entry.refCount === 0) kill(entry);
    } catch {
      // Startup failure has already cleaned up its process.
    }
  }
  return nextGeneration;
}

export async function retireOpenCodeAuthStore(
  env: Record<string, string>,
  options: { force?: boolean } = {},
): Promise<void> {
  const authStore = openCodeAuthStoreKey(env);
  const keys = [...runtimeAuthStores]
    .filter(([, candidate]) => candidate === authStore)
    .map(([key]) => key);
  await Promise.all(keys.map((key) => retireRuntimeKey(key, options)));
}

export async function acquireOpenCodeServer(
  binary: string,
  prefixArgs: string[],
  env: Record<string, string>,
  cwd: string,
): Promise<OpenCodeServerHandle> {
  const key = openCodeRuntimeKey(binary, cwd, prefixArgs, env);
  const authStore = openCodeAuthStoreKey(env);
  const generation = generations.get(key) ?? 0;
  let pending = pool.get(key);
  if (!pending) {
    pending = startServer(key, generation, binary, prefixArgs, env, cwd).catch((error) => {
      if (pool.get(key) === pending) {
        pool.delete(key);
        runtimeAuthStores.delete(key);
      }
      throw error;
    });
    pool.set(key, pending);
    runtimeAuthStores.set(key, authStore);
  }
  const entry = await pending;
  entry.refCount += 1;

  let released = false;
  return {
    client: entry.client,
    generation: entry.generation,
    isCurrent: () => !entry.retired && (generations.get(key) ?? 0) === entry.generation,
    retire: (options) => retireOpenCodeRuntime(binary, prefixArgs, env, cwd, options).then(() => undefined),
    retireAuthStore: (options) => retireOpenCodeAuthStore(env, options),
    release: () => {
      if (released) return;
      released = true;
      entry.refCount -= 1;
      if (entry.refCount <= 0) {
        if (pool.get(key) === pending) {
          pool.delete(key);
          runtimeAuthStores.delete(key);
        }
        kill(entry);
      }
    },
  };
}
