import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as http from "node:http";
import { httpAgentProvider, runHttpAgent } from "../../src/index.js";
import type { StreamEvent } from "../../src/index.js";

let server: http.Server;
let baseUrl = "";

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (req.url === "/auth-fail") {
        res.writeHead(401);
        res.end("nope");
        return;
      }
      if (req.url === "/slow") {
        setTimeout(() => {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ summary: "slow" }));
        }, 2000);
        return;
      }
      const parsed = body ? (JSON.parse(body) as Record<string, unknown>) : {};
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          summary: `echo: ${parsed["prompt"]}`,
          sessionKey: parsed["sessionKey"] ?? "sk-new",
          model: "gw-model",
          costUsd: 0.01,
        }),
      );
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  baseUrl = `http://127.0.0.1:${(addr as { port: number }).port}`;
});

afterAll(() => new Promise<void>((r) => server.close(() => r())));

describe("httpAgentProvider / runHttpAgent", () => {
  it("executes against a gateway and returns a completed result + result event", async () => {
    const p = httpAgentProvider({ providerType: "mygw", defaultBaseUrl: baseUrl, runPath: "/run" });
    const events: StreamEvent[] = [];
    const result = await p.execute({ prompt: "hi", onEvent: (e) => events.push(e) });
    expect(result.status).toBe("completed");
    expect(result.summary).toBe("echo: hi");
    expect(result.sessionParams?.["sessionKey"]).toBe("sk-new");
    expect(result.model).toBe("gw-model");
    expect(result.costUsd).toBe(0.01);
    expect(events.some((e) => e.type === "result")).toBe(true);
  });

  it("round-trips the session key from sessionParams", async () => {
    const p = httpAgentProvider({ providerType: "mygw", defaultBaseUrl: baseUrl, runPath: "/run" });
    const result = await p.execute({
      prompt: "hi",
      sessionParams: { sessionKey: "sk-existing", gatewayUrl: baseUrl },
    });
    expect(result.sessionParams?.["sessionKey"]).toBe("sk-existing");
  });

  it("maps 401 to an auth_required event + errorCode", async () => {
    const events: StreamEvent[] = [];
    const result = await runHttpAgent(
      { providerType: "mygw", defaultBaseUrl: baseUrl, runPath: "/auth-fail", loginCommand: "mygw login" },
      { prompt: "x", onEvent: (e) => events.push(e) },
    );
    expect(result.status).toBe("failed");
    expect(result.errorCode).toBe("auth_required");
    const auth = events.find((e) => e.type === "auth_required");
    expect(auth?.type === "auth_required" && auth.loginCommand).toBe("mygw login");
  });

  it("honors a config.command URL override over the default base", async () => {
    const p = httpAgentProvider({ providerType: "mygw", defaultBaseUrl: "http://unused.invalid", runPath: "/run" });
    const result = await p.execute({ prompt: "hi", config: { command: baseUrl } });
    expect(result.status).toBe("completed");
  });

  it("supports custom buildBody + extractSummary hooks", async () => {
    const result = await runHttpAgent(
      {
        providerType: "mygw",
        defaultBaseUrl: baseUrl,
        runPath: "/run",
        buildBody: ({ prompt }) => ({ prompt: prompt.toUpperCase() }),
        extractSummary: (r) => (typeof r["summary"] === "string" ? `[${r["summary"]}]` : null),
      },
      { prompt: "hi" },
    );
    expect(result.summary).toBe("[echo: HI]");
  });

  it("times out via AbortController", async () => {
    const result = await runHttpAgent(
      { providerType: "mygw", defaultBaseUrl: baseUrl, runPath: "/slow" },
      { prompt: "x", config: { timeoutSec: 0.5 } },
    );
    expect(result.status).toBe("timeout");
    expect(result.errorCode).toBe("timeout");
  });

  it("distinguishes a caller-signal abort from a timeout", async () => {
    const ac = new AbortController();
    const p = runHttpAgent(
      { providerType: "mygw", defaultBaseUrl: baseUrl, runPath: "/slow" },
      { prompt: "x", signal: ac.signal },
    );
    ac.abort();
    const result = await p;
    expect(result.status).toBe("aborted");
    expect(result.errorCode).toBe("aborted");
  });

  it("preserves sessionParams on a transient network error (recoverable)", async () => {
    const result = await runHttpAgent(
      { providerType: "mygw", defaultBaseUrl: "http://127.0.0.1:1", runPath: "/run" },
      { prompt: "x", sessionParams: { sessionKey: "sk-keep", gatewayUrl: "http://127.0.0.1:1" } },
    );
    expect(result.status).toBe("failed");
    expect(result.sessionParams?.["sessionKey"]).toBe("sk-keep");
  });

  it("declares minimal (all-false) capabilities", () => {
    const caps = httpAgentProvider({ providerType: "mygw", defaultBaseUrl: baseUrl, runPath: "/run" }).capabilities;
    expect(caps.sessions).toBe(false);
    expect(Object.values(caps).every((v) => v === false)).toBe(true);
  });
});
