import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenCodeClient, OpenCodeHttpError } from "../../../src/providers/opencode/client.js";

describe("OpenCodeClient", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("authenticates every request with the per-server password", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe(
        `Basic ${Buffer.from("opencode:secret-password").toString("base64")}`,
      );
      expect(headers.get("content-type")).toBe("application/json");
      return Response.json({ ok: true });
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new OpenCodeClient("http://127.0.0.1:1234", "secret-password");
    await expect(client.json("/provider", { method: "POST", body: "{}" })).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledWith("http://127.0.0.1:1234/provider", expect.any(Object));
  });

  it("does not include response bodies or credentials in errors", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("token=super-secret", { status: 401 })));
    const client = new OpenCodeClient("http://127.0.0.1:1234", "secret-password");
    const error = await client.json("/provider").catch((value) => value);
    expect(error).toBeInstanceOf(OpenCodeHttpError);
    expect(error.message).toBe("OpenCode request failed (401)");
    expect(JSON.stringify(error)).not.toContain("super-secret");
    expect(JSON.stringify(error)).not.toContain("secret-password");
  });
});
