import { createHash, randomUUID } from "node:crypto";
import type {
  ProviderAuthFlow,
  ProviderAuthMethod,
  ProviderRuntimeContext,
  UpstreamProvider,
  UpstreamProviderManager,
} from "../../types.js";
import type { OpenCodeServerHandle } from "./server.js";
import { acquireOpenCodeRuntime } from "./runtime.js";

const FLOW_TTL_MS = 10 * 60 * 1000;
const MAX_FLOWS = 128;

interface FlowRecord {
  id: string;
  providerId: string;
  methodIndex: number;
  expiresAt: number;
  completion: "code" | "automatic";
  server: OpenCodeServerHandle;
  contextKey: string;
}

const flows = new Map<string, FlowRecord>();

export class OpenCodeDisconnectUnsupportedError extends Error {
  readonly code = "disconnect_unsupported";
  constructor() {
    super("The selected OpenCode protocol profile cannot safely remove this credential");
    this.name = "OpenCodeDisconnectUnsupportedError";
  }
}

export class OpenCodeAuthFlowExpiredError extends Error {
  readonly code = "auth_flow_expired_or_restarted";
  constructor() {
    super("The OpenCode authentication flow expired or the process restarted");
    this.name = "OpenCodeAuthFlowExpiredError";
  }
}

function rec(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stableMethodId(providerId: string, index: number, method: Record<string, unknown>): string {
  const hash = createHash("sha256")
    .update(`${providerId}\0${method["type"] ?? ""}\0${method["label"] ?? ""}\0${index}`)
    .digest("hex")
    .slice(0, 16);
  return `ocm_${hash}`;
}

function safeMethod(providerId: string, index: number, value: unknown): ProviderAuthMethod {
  const method = rec(value);
  const prompts = Array.isArray(method["prompts"])
    ? method["prompts"].map((raw) => {
        const prompt = rec(raw);
        const type = prompt["type"] === "select" ? "select" as const : "text" as const;
        return {
          id: typeof prompt["key"] === "string" ? prompt["key"] : "input",
          label: typeof prompt["message"] === "string" ? prompt["message"] : "Input",
          type,
          ...(type === "select" && Array.isArray(prompt["options"])
            ? { options: prompt["options"].map((item) => {
                const option = rec(item);
                return {
                  value: typeof option["value"] === "string" ? option["value"] : "",
                  label: typeof option["label"] === "string" ? option["label"] : "",
                };
              }).filter((item) => item.value) }
            : {}),
        };
      })
    : undefined;
  return {
    id: stableMethodId(providerId, index, method),
    name: typeof method["label"] === "string" ? method["label"] : "Authentication",
    type: method["type"] === "oauth" ? "oauth" : "api_key",
    ...(prompts?.length ? { prompts } : {}),
  };
}

function contextKey(ctx: ProviderRuntimeContext): string {
  return JSON.stringify({ cwd: ctx.cwd ?? process.cwd(), command: ctx.config?.command ?? null });
}

function cleanupFlows(): void {
  const now = Date.now();
  for (const [id, flow] of flows) {
    if (flow.expiresAt <= now) {
      flow.server.release();
      flows.delete(id);
    }
  }
  while (flows.size >= MAX_FLOWS) {
    const oldest = flows.keys().next().value as string | undefined;
    if (!oldest) break;
    flows.get(oldest)?.server.release();
    flows.delete(oldest);
  }
}

async function authPayload(ctx: ProviderRuntimeContext) {
  const runtime = await acquireOpenCodeRuntime(ctx);
  const payload = await runtime.server.client.json<Record<string, unknown>>("/provider/auth");
  return { runtime, payload };
}

async function methodIndex(providerId: string, methodId: string, ctx: ProviderRuntimeContext) {
  const { runtime, payload } = await authPayload(ctx);
  const methods = Array.isArray(payload[providerId]) ? payload[providerId] : [];
  const index = methods.findIndex((method, candidate) => stableMethodId(providerId, candidate, rec(method)) === methodId);
  if (index < 0) {
    runtime.server.release();
    throw new Error("OpenCode authentication method is unavailable");
  }
  return { runtime, index };
}

async function supportsProviderDelete(ctx: ProviderRuntimeContext): Promise<boolean> {
  const runtime = await acquireOpenCodeRuntime(ctx);
  try {
    const doc = await runtime.server.client.json<Record<string, unknown>>("/doc");
    const paths = rec(doc["paths"]);
    const route = rec(paths["/auth/{providerID}"]);
    return Boolean(route["delete"]);
  } finally {
    runtime.server.release();
  }
}

export const openCodeUpstreamProviders: UpstreamProviderManager = {
  async list(ctx = {}): Promise<UpstreamProvider[]> {
    const runtime = await acquireOpenCodeRuntime(ctx);
    try {
      const [providers, methods] = await Promise.all([
        runtime.server.client.json<Record<string, unknown>>("/provider"),
        runtime.server.client.json<Record<string, unknown>>("/provider/auth"),
      ]);
      const connected = new Set(Array.isArray(providers["connected"])
        ? providers["connected"].filter((item): item is string => typeof item === "string")
        : []);
      return (Array.isArray(providers["all"]) ? providers["all"] : []).map((raw) => {
        const provider = rec(raw);
        const id = typeof provider["id"] === "string" ? provider["id"] : "";
        const auth = Array.isArray(methods[id]) ? methods[id] : [];
        return {
          id,
          name: typeof provider["name"] === "string" ? provider["name"] : id,
          connected: connected.has(id),
          authMethodIds: auth.map((method, index) => stableMethodId(id, index, rec(method))),
        };
      }).filter((provider) => provider.id);
    } finally {
      runtime.server.release();
    }
  },

  async authMethods(providerId, ctx = {}) {
    const { runtime, payload } = await authPayload(ctx);
    try {
      const methods = Array.isArray(payload[providerId]) ? payload[providerId] : [];
      return methods.map((method, index) => safeMethod(providerId, index, method));
    } finally {
      runtime.server.release();
    }
  },

  async setApiKey(providerId, key, ctx = {}) {
    if (!key.trim()) throw new Error("OpenCode API key must not be empty");
    const runtime = await acquireOpenCodeRuntime(ctx);
    try {
      await runtime.server.client.ok(`/auth/${encodeURIComponent(providerId)}`, {
        method: "PUT",
        body: JSON.stringify({ type: "api", key }),
      });
      await runtime.server.retire();
    } finally {
      runtime.server.release();
    }
  },

  async beginOAuth(providerId, methodId, inputs, ctx = {}) {
    cleanupFlows();
    const { runtime, index } = await methodIndex(providerId, methodId, ctx);
    try {
      const response = await runtime.server.client.json<Record<string, unknown>>(
        `/provider/${encodeURIComponent(providerId)}/oauth/authorize`,
        { method: "POST", body: JSON.stringify({ method: index, ...(inputs ? { inputs } : {}) }) },
      );
      const id = `ocf_${randomUUID()}`;
      const expiresAt = Date.now() + FLOW_TTL_MS;
      const completion = response["method"] === "auto" ? "automatic" : "code";
      flows.set(id, {
        id,
        providerId,
        methodIndex: index,
        expiresAt,
        completion,
        server: runtime.server,
        contextKey: contextKey(ctx),
      });
      return {
        id,
        providerId,
        url: typeof response["url"] === "string" ? response["url"] : null,
        completion,
        instructions: typeof response["instructions"] === "string" ? response["instructions"] : null,
        expiresAt: new Date(expiresAt).toISOString(),
      } satisfies ProviderAuthFlow;
    } catch (error) {
      runtime.server.release();
      throw error;
    }
  },

  async completeOAuth(flowId, code, ctx = {}) {
    cleanupFlows();
    const flow = flows.get(flowId);
    if (!flow || flow.expiresAt <= Date.now() || flow.contextKey !== contextKey(ctx)) {
      throw new OpenCodeAuthFlowExpiredError();
    }
    flows.delete(flowId);
    try {
      await flow.server.client.ok(`/provider/${encodeURIComponent(flow.providerId)}/oauth/callback`, {
        method: "POST",
        body: JSON.stringify({ method: flow.methodIndex, ...(code ? { code } : {}) }),
      });
      await flow.server.retire();
    } finally {
      flow.server.release();
    }
  },

  canDisconnect(providerId, ctx = {}) {
    void providerId;
    return supportsProviderDelete(ctx);
  },

  async disconnect(providerId, ctx = {}) {
    if (!await supportsProviderDelete(ctx)) throw new OpenCodeDisconnectUnsupportedError();
    const runtime = await acquireOpenCodeRuntime(ctx);
    try {
      await runtime.server.client.ok(`/auth/${encodeURIComponent(providerId)}`, { method: "DELETE" });
      await runtime.server.retire({ force: true });
    } finally {
      runtime.server.release();
    }
  },
};
