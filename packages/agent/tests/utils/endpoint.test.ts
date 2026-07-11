import { describe, it, expect } from "vitest";
import {
  translateEndpoint,
  CODEX_CUSTOM_PROVIDER_ID,
  CODEX_CUSTOM_KEY_ENV,
} from "../../src/utils/endpoint.js";

/** Collapse codex `-c` arg pairs into a `{ key: rawValue }` map for assertions. */
function codexOverrides(args: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "-c") {
      const eq = args[i + 1] ?? "";
      const idx = eq.indexOf("=");
      out[eq.slice(0, idx)] = eq.slice(idx + 1);
    }
  }
  return out;
}

describe("translateEndpoint — no-op cases", () => {
  it("returns empty for undefined endpoint", () => {
    expect(translateEndpoint("claude", undefined)).toEqual({ env: {}, args: [], unset: [] });
  });

  it("returns empty for an unknown provider (silently ignored)", () => {
    expect(
      translateEndpoint("cursor", { baseUrl: "https://x", authToken: "t" }),
    ).toEqual({ env: {}, args: [], unset: [] });
  });
});

describe("translateEndpoint — claude (env-only)", () => {
  it("maps baseUrl + authToken (Bearer)", () => {
    const { env, args } = translateEndpoint("claude", {
      baseUrl: "https://gw.example.com",
      authToken: "sk-gw-abc",
    });
    expect(env["ANTHROPIC_BASE_URL"]).toBe("https://gw.example.com");
    expect(env["ANTHROPIC_AUTH_TOKEN"]).toBe("sk-gw-abc");
    expect(env["ANTHROPIC_API_KEY"]).toBeUndefined();
    expect(args).toEqual([]);
  });

  it("maps apiKey (x-api-key) when authToken absent", () => {
    const { env } = translateEndpoint("claude", {
      baseUrl: "https://gw",
      apiKey: "key-123",
    });
    expect(env["ANTHROPIC_API_KEY"]).toBe("key-123");
    expect(env["ANTHROPIC_AUTH_TOKEN"]).toBeUndefined();
  });

  it("prefers authToken over apiKey when both set", () => {
    const { env } = translateEndpoint("claude", {
      baseUrl: "https://gw",
      authToken: "bearer",
      apiKey: "xkey",
    });
    expect(env["ANTHROPIC_AUTH_TOKEN"]).toBe("bearer");
    expect(env["ANTHROPIC_API_KEY"]).toBeUndefined();
  });

  it("serializes headers as newline-separated Name: Value pairs", () => {
    const { env } = translateEndpoint("claude", {
      baseUrl: "https://gw",
      headers: { "X-Tenant-ID": "acme", "X-Priority": "high" },
    });
    expect(env["ANTHROPIC_CUSTOM_HEADERS"]).toBe("X-Tenant-ID: acme\nX-Priority: high");
  });

  it("maps tier aliases to ANTHROPIC_DEFAULT_*_MODEL", () => {
    const { env } = translateEndpoint("claude", {
      baseUrl: "https://gw",
      modelMap: { opus: "big", sonnet: "mid", haiku: "small", fable: "tiny" },
    });
    expect(env["ANTHROPIC_DEFAULT_OPUS_MODEL"]).toBe("big");
    expect(env["ANTHROPIC_DEFAULT_SONNET_MODEL"]).toBe("mid");
    expect(env["ANTHROPIC_DEFAULT_HAIKU_MODEL"]).toBe("small");
    expect(env["ANTHROPIC_DEFAULT_FABLE_MODEL"]).toBe("tiny");
  });

  it("only emits mapped tiers that are present", () => {
    const { env } = translateEndpoint("claude", { modelMap: { sonnet: "mid" } });
    expect(env["ANTHROPIC_DEFAULT_SONNET_MODEL"]).toBe("mid");
    expect(env["ANTHROPIC_DEFAULT_OPUS_MODEL"]).toBeUndefined();
  });

  it("allows authToken/modelMap without a baseUrl", () => {
    const { env } = translateEndpoint("claude", { authToken: "t" });
    expect(env["ANTHROPIC_AUTH_TOKEN"]).toBe("t");
    expect(env["ANTHROPIC_BASE_URL"]).toBeUndefined();
  });
});

describe("translateEndpoint — codex (model_providers via -c)", () => {
  it("requires a baseUrl — empty otherwise", () => {
    expect(translateEndpoint("codex", { authToken: "t" })).toEqual({ env: {}, args: [], unset: [] });
  });

  it("synthesizes a model_providers block and injects the key into env", () => {
    const { env, args } = translateEndpoint("codex", {
      baseUrl: "https://oai.example.com/v1",
      authToken: "sk-key",
    });
    const id = CODEX_CUSTOM_PROVIDER_ID;
    const c = codexOverrides(args);
    expect(c["model_provider"]).toBe(JSON.stringify(id));
    expect(c[`model_providers.${id}.base_url`]).toBe(JSON.stringify("https://oai.example.com/v1"));
    expect(c[`model_providers.${id}.wire_api`]).toBe(JSON.stringify("responses"));
    expect(c[`model_providers.${id}.env_key`]).toBe(JSON.stringify(CODEX_CUSTOM_KEY_ENV));
    expect(env[CODEX_CUSTOM_KEY_ENV]).toBe("sk-key");
  });

  it("falls back to apiKey when authToken absent", () => {
    const { env } = translateEndpoint("codex", { baseUrl: "https://x", apiKey: "ak" });
    expect(env[CODEX_CUSTOM_KEY_ENV]).toBe("ak");
  });

  it("omits env_key when no credential is provided", () => {
    const { env, args } = translateEndpoint("codex", { baseUrl: "https://x" });
    const id = CODEX_CUSTOM_PROVIDER_ID;
    expect(env[CODEX_CUSTOM_KEY_ENV]).toBeUndefined();
    expect(codexOverrides(args)[`model_providers.${id}.env_key`]).toBeUndefined();
  });

  it("routes header values through env_http_headers, never argv (no secret in ps)", () => {
    const { env, args } = translateEndpoint("codex", {
      baseUrl: "https://x",
      headers: { Authorization: "Bearer super-secret" },
    });
    const id = CODEX_CUSTOM_PROVIDER_ID;
    // argv references an env var name, and env holds the actual value.
    const envVar = JSON.parse(codexOverrides(args)[`model_providers.${id}.env_http_headers."Authorization"`]);
    expect(env[envVar]).toBe("Bearer super-secret");
    // The secret value itself must never appear in argv.
    expect(args.join(" ")).not.toContain("super-secret");
    // ...and we use the env-var form, not the static `http_headers` form.
    expect(args.join(" ")).toContain('env_http_headers."Authorization"=');
  });

  it("quotes dotted HTTP header names as one TOML key segment", () => {
    const { env, args } = translateEndpoint("codex", {
      baseUrl: "https://x",
      headers: { "X.Trace.Id": "trace-secret" },
    });
    const id = CODEX_CUSTOM_PROVIDER_ID;
    const envVar = JSON.parse(
      codexOverrides(args)[`model_providers.${id}.env_http_headers."X.Trace.Id"`],
    );
    expect(env[envVar]).toBe("trace-secret");
    expect(args.join(" ")).not.toContain("trace-secret");
  });

  it("ignores modelMap (codex has no tier aliases)", () => {
    const { args } = translateEndpoint("codex", {
      baseUrl: "https://x",
      modelMap: { sonnet: "mid" },
    });
    expect(args.join(" ")).not.toContain("DEFAULT");
    expect(args.join(" ")).not.toContain("mid");
  });

  it("emits -c args as flag/value pairs", () => {
    const { args } = translateEndpoint("codex", { baseUrl: "https://x", authToken: "t" });
    // Every override is a `-c` followed by its `key=value` token.
    for (let i = 0; i < args.length; i += 2) {
      expect(args[i]).toBe("-c");
      expect(args[i + 1]).toContain("=");
    }
  });

  it("emits no unset for codex (ambient key never routes to the endpoint)", () => {
    expect(translateEndpoint("codex", { baseUrl: "https://x", authToken: "t" }).unset).toEqual([]);
  });
});

describe("translateEndpoint — claude credential hygiene (unset)", () => {
  it("clears ANTHROPIC_API_KEY when routing to a baseUrl with a bearer token", () => {
    const { unset } = translateEndpoint("claude", { baseUrl: "https://gw", authToken: "t" });
    expect(unset).toContain("ANTHROPIC_API_KEY");
    expect(unset).not.toContain("ANTHROPIC_AUTH_TOKEN");
  });

  it("clears ANTHROPIC_AUTH_TOKEN when routing to a baseUrl with an apiKey", () => {
    const { unset } = translateEndpoint("claude", { baseUrl: "https://gw", apiKey: "k" });
    expect(unset).toContain("ANTHROPIC_AUTH_TOKEN");
    expect(unset).not.toContain("ANTHROPIC_API_KEY");
  });

  it("clears BOTH ambient creds for a baseUrl with no declared auth", () => {
    const { env, unset } = translateEndpoint("claude", { baseUrl: "https://gw" });
    expect(unset).toEqual(expect.arrayContaining(["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"]));
    expect(env["ANTHROPIC_AUTH_TOKEN"]).toBeUndefined();
    expect(env["ANTHROPIC_API_KEY"]).toBeUndefined();
  });

  it("prefers authToken and clears apiKey when both are declared", () => {
    const { env, unset } = translateEndpoint("claude", {
      baseUrl: "https://gw",
      authToken: "t",
      apiKey: "k",
    });
    expect(env["ANTHROPIC_AUTH_TOKEN"]).toBe("t");
    expect(env["ANTHROPIC_API_KEY"]).toBeUndefined();
    expect(unset).toContain("ANTHROPIC_API_KEY");
  });

  it("enforces exactly-one even without a baseUrl (authToken clears apiKey)", () => {
    expect(translateEndpoint("claude", { authToken: "t" }).unset).toContain("ANTHROPIC_API_KEY");
    expect(translateEndpoint("claude", { apiKey: "k" }).unset).toContain("ANTHROPIC_AUTH_TOKEN");
  });

  it("does not touch ambient auth for a modelMap-only endpoint (still real Anthropic)", () => {
    expect(translateEndpoint("claude", { modelMap: { sonnet: "mid" } }).unset).toEqual([]);
  });

  it("clears ambient alternate-routing (Bedrock/Vertex/Foundry) for a custom baseUrl", () => {
    const { unset } = translateEndpoint("claude", { baseUrl: "https://gw", authToken: "t" });
    expect(unset).toEqual(
      expect.arrayContaining([
        "ANTHROPIC_BEDROCK_BASE_URL",
        "CLAUDE_CODE_USE_BEDROCK",
        "CLAUDE_CODE_USE_VERTEX",
        "CLAUDE_CODE_USE_FOUNDRY",
      ]),
    );
  });

  it("leaves alternate-routing env alone when there is no baseUrl", () => {
    const { unset } = translateEndpoint("claude", { authToken: "t" });
    expect(unset).not.toContain("ANTHROPIC_BEDROCK_BASE_URL");
    expect(unset).not.toContain("CLAUDE_CODE_USE_BEDROCK");
  });

  it("closes the leak end-to-end: applying the translation removes the ambient key", () => {
    // Simulate the call-site apply: buildEnv seeded a real key, then the
    // endpoint routes to a third-party gateway with its own bearer token.
    const env: Record<string, string> = { ANTHROPIC_API_KEY: "real-anthropic-key", PATH: "/usr/bin" };
    const tx = translateEndpoint("claude", { baseUrl: "https://gateway.acme.com", authToken: "gw-token" });
    Object.assign(env, tx.env);
    for (const k of tx.unset) delete env[k];
    expect(env["ANTHROPIC_API_KEY"]).toBeUndefined();
    expect(env["ANTHROPIC_AUTH_TOKEN"]).toBe("gw-token");
    expect(env["ANTHROPIC_BASE_URL"]).toBe("https://gateway.acme.com");
  });
});
