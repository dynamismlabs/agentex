import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as http from "node:http";
import { executeOpenclawProvider } from "../../../src/providers/openclaw/execute.js";
import { openclawSessionCodec } from "../../../src/providers/openclaw/codec.js";
import type { ExecutionContext } from "../../../src/types.js";

let server: http.Server;
let port: number;

function makeCtx(overrides: Partial<ExecutionContext> = {}): ExecutionContext {
  return {
    runId: "test-openclaw",
    prompt: "Hello openclaw",
    cwd: process.cwd(),
    ...overrides,
  };
}

beforeAll(async () => {
  server = http.createServer((req, res) => {
    if (req.url === "/health" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
      return;
    }

    if (req.url === "/api/agent/run" && req.method === "POST") {
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        const parsed = JSON.parse(body);

        // Check for delay request (for timeout testing)
        if (parsed.prompt === "DELAY") {
          setTimeout(() => {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ summary: "delayed", sessionKey: "sk-delayed" }));
          }, 5000);
          return;
        }

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          summary: `OpenClaw processed: ${parsed.prompt}`,
          sessionKey: parsed.sessionKey ?? "sk-new-session",
          model: "openclaw-default",
        }));
      });
      return;
    }

    res.writeHead(404);
    res.end("Not found");
  });

  await new Promise<void>((resolve) => {
    server.listen(0, () => {
      const addr = server.address();
      port = typeof addr === "object" && addr !== null ? addr.port : 0;
      resolve();
    });
  });
});

afterAll(() => {
  server.close();
});

describe("executeOpenclawProvider", () => {
  it("handles successful execution", async () => {
    const result = await executeOpenclawProvider(makeCtx({
      config: { command: `http://localhost:${port}` },
    }));

    expect(result.exitCode).toBe(0);
    expect(result.summary).toContain("OpenClaw processed");
    expect(result.sessionParams?.["sessionKey"]).toBe("sk-new-session");
    expect(result.model).toBe("openclaw-default");
  });

  it("passes session key for continuation", async () => {
    const result = await executeOpenclawProvider(makeCtx({
      config: { command: `http://localhost:${port}` },
      sessionParams: { sessionKey: "sk-existing" },
    }));

    expect(result.exitCode).toBe(0);
    expect(result.sessionParams?.["sessionKey"]).toBe("sk-existing");
  });

  it("handles timeout via AbortController", async () => {
    const result = await executeOpenclawProvider(makeCtx({
      prompt: "DELAY",
      config: { command: `http://localhost:${port}`, timeoutSec: 1 },
    }));

    expect(result.status).toBe("timeout");
    expect(result.errorCode).toBe("timeout");
  }, 10_000);

  it("handles unreachable gateway", async () => {
    const result = await executeOpenclawProvider(makeCtx({
      config: { command: "http://localhost:19999" },
    }));

    expect(result.exitCode).toBeNull();
    expect(result.errorMessage).toBeTruthy();
  });
});

describe("openclawSessionCodec", () => {
  it("roundtrip preserves data", () => {
    const original = { sessionKey: "sk-test", gatewayUrl: "http://localhost:3001" };
    const serialized = openclawSessionCodec.serialize(original);
    const deserialized = openclawSessionCodec.deserialize(serialized);
    expect(deserialized).toEqual(original);
  });

  it("returns null for missing sessionKey", () => {
    expect(openclawSessionCodec.deserialize({})).toBeNull();
  });

  it("getDisplayId returns sessionKey", () => {
    expect(openclawSessionCodec.getDisplayId!({ sessionKey: "sk-1" })).toBe("sk-1");
  });
});
