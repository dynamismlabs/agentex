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
import { rec, serverApiVersion, v2DataArray, v2DataRecord } from "./v2.js";

const FLOW_TTL_MS = 10 * 60 * 1000;
const MAX_FLOWS = 128;

interface FlowRecord {
  id: string;
  apiVersion: 1 | 2;
  providerId: string;
  methodIndex: number;
  integrationId?: string;
  attemptId?: string;
  expiresAt: number;
  completion: "code" | "automatic";
  server: OpenCodeServerHandle;
  contextKey: string;
  expiryTimer: ReturnType<typeof setTimeout>;
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
      clearTimeout(flow.expiryTimer);
      flow.server.release();
      flows.delete(id);
    }
  }
  while (flows.size >= MAX_FLOWS) {
    const oldest = flows.keys().next().value as string | undefined;
    if (!oldest) break;
    const flow = flows.get(oldest);
    if (flow) {
      clearTimeout(flow.expiryTimer);
      flow.server.release();
    }
    flows.delete(oldest);
  }
}

async function methodIndex(
  server: OpenCodeServerHandle,
  providerId: string,
  methodId: string,
): Promise<number> {
  const payload = await server.client.json<Record<string, unknown>>("/provider/auth");
  const methods = Array.isArray(payload[providerId]) ? payload[providerId] : [];
  const index = methods.findIndex((method, candidate) => stableMethodId(providerId, candidate, rec(method)) === methodId);
  if (index < 0) {
    throw new Error("OpenCode authentication method is unavailable");
  }
  return index;
}

async function supportsProviderDelete(ctx: ProviderRuntimeContext): Promise<boolean> {
  const runtime = await acquireOpenCodeRuntime(ctx);
  try {
    const isV2 = serverApiVersion(runtime.server) === 2;
    const doc = await runtime.server.client.json<Record<string, unknown>>(isV2 ? "/openapi.json" : "/doc");
    const paths = rec(doc["paths"]);
    const route = rec(paths[isV2 ? "/api/credential/{credentialID}" : "/auth/{providerID}"]);
    return Boolean(route["delete"]);
  } finally {
    runtime.server.release();
  }
}

async function fetchV2Integration(
  server: OpenCodeServerHandle,
  providerId: string,
): Promise<{ integrationId: string; integration: Record<string, unknown> | null }> {
  const providerPayload = await server.client
    .json<unknown>(`/api/provider/${encodeURIComponent(providerId)}`)
    .catch(() => null);
  const provider = providerPayload ? v2DataRecord(providerPayload) : {};
  const integrationId = typeof provider["integrationID"] === "string" && provider["integrationID"]
    ? provider["integrationID"]
    : providerId;
  const integrationPayload = await server.client
    .json<unknown>(`/api/integration/${encodeURIComponent(integrationId)}`)
    .catch(() => null);
  return {
    integrationId,
    integration: integrationPayload ? v2DataRecord(integrationPayload) : null,
  };
}

function v2InteractiveMethods(
  providerId: string,
  integration: Record<string, unknown> | null,
): Array<{ method: ProviderAuthMethod; raw: Record<string, unknown> }> {
  if (!integration) return [];
  const methods = Array.isArray(integration["methods"]) ? integration["methods"] : [];
  const result: Array<{ method: ProviderAuthMethod; raw: Record<string, unknown> }> = [];
  for (let index = 0; index < methods.length; index += 1) {
    const raw = rec(methods[index]);
    const kind = raw["type"];
    if (kind !== "oauth" && kind !== "key") continue;
    const prompts = Array.isArray(raw["form"])
      ? raw["form"].map((item) => {
          const field = rec(item);
          const fieldType = field["type"] === "multiselect" && Array.isArray(field["options"])
            ? ("select" as const)
            : ("text" as const);
          return {
            id: typeof field["key"] === "string" ? field["key"] : "input",
            label: typeof field["title"] === "string"
              ? field["title"]
              : typeof field["key"] === "string" ? field["key"] : "Input",
            type: fieldType,
            ...(fieldType === "select"
              ? {
                  options: (field["options"] as unknown[])
                    .map((opt) => {
                      const o = rec(opt);
                      return {
                        value: typeof o["value"] === "string" ? o["value"] : "",
                        label: typeof o["label"] === "string" ? o["label"] : "",
                      };
                    })
                    .filter((o) => o.value),
                }
              : {}),
          };
        })
      : undefined;
    result.push({
      raw,
      method: {
        id: stableMethodId(providerId, index, raw),
        name: typeof raw["label"] === "string" ? raw["label"] : (kind === "oauth" ? "OAuth" : "API key"),
        type: kind === "oauth" ? "oauth" : "api_key",
        ...(prompts?.length ? { prompts } : {}),
      },
    });
  }
  return result;
}

export const openCodeUpstreamProviders: UpstreamProviderManager = {
  async list(ctx = {}): Promise<UpstreamProvider[]> {
    const runtime = await acquireOpenCodeRuntime(ctx);
    try {
      if (serverApiVersion(runtime.server) === 2) {
        const [providersPayload, integrationsPayload, credentialsPayload] = await Promise.all([
          runtime.server.client.json<unknown>("/api/provider"),
          runtime.server.client.json<unknown>("/api/integration").catch(() => []),
          runtime.server.client.json<unknown>("/api/credential").catch(() => []),
        ]);
        const integrationsById = new Map<string, Record<string, unknown>>();
        for (const raw of v2DataArray(integrationsPayload)) {
          const entry = rec(raw);
          if (typeof entry["id"] === "string" && entry["id"]) {
            integrationsById.set(entry["id"], entry);
          }
        }
        const credentialIntegrationIds = new Set<string>();
        for (const raw of v2DataArray(credentialsPayload)) {
          const entry = rec(raw);
          if (typeof entry["integrationID"] === "string" && entry["integrationID"]) {
            credentialIntegrationIds.add(entry["integrationID"]);
          }
        }
        return v2DataArray(providersPayload).map((raw) => {
          const provider = rec(raw);
          const id = typeof provider["id"] === "string" ? provider["id"] : "";
          const integrationId = typeof provider["integrationID"] === "string" && provider["integrationID"]
            ? provider["integrationID"]
            : id;
          const integration = integrationsById.get(integrationId) ?? null;
          const connections = integration && Array.isArray(integration["connections"])
            ? integration["connections"]
            : [];
          const connected = connections.length > 0
            || credentialIntegrationIds.has(integrationId)
            || provider["activation"] === "enabled";
          return {
            id,
            name: typeof provider["name"] === "string" ? provider["name"] : id,
            connected,
            authMethodIds: v2InteractiveMethods(id, integration).map((entry) => entry.method.id),
          };
        }).filter((provider) => provider.id);
      }

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
    const runtime = await acquireOpenCodeRuntime(ctx);
    try {
      if (serverApiVersion(runtime.server) === 2) {
        const { integration } = await fetchV2Integration(runtime.server, providerId);
        return v2InteractiveMethods(providerId, integration).map((entry) => entry.method);
      }
      const payload = await runtime.server.client.json<Record<string, unknown>>("/provider/auth");
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
      if (serverApiVersion(runtime.server) === 2) {
        const { integrationId } = await fetchV2Integration(runtime.server, providerId);
        await runtime.server.client.ok(`/api/integration/${encodeURIComponent(integrationId)}/connect/key`, {
          method: "POST",
          body: JSON.stringify({ key }),
        });
      } else {
        await runtime.server.client.ok(`/auth/${encodeURIComponent(providerId)}`, {
          method: "PUT",
          body: JSON.stringify({ type: "api", key }),
        });
      }
      await runtime.server.retireAuthStore();
    } finally {
      runtime.server.release();
    }
  },

  async beginOAuth(providerId, methodId, inputs, ctx = {}) {
    cleanupFlows();
    const runtime = await acquireOpenCodeRuntime(ctx);
    try {
      const apiVersion = serverApiVersion(runtime.server);
      let url: string | null = null;
      let completion: "code" | "automatic" = "code";
      let instructions: string | null = null;
      let methodIndexValue = 0;
      let integrationId: string | undefined;
      let attemptId: string | undefined;

      if (apiVersion === 2) {
        const resolved = await fetchV2Integration(runtime.server, providerId);
        integrationId = resolved.integrationId;
        const match = v2InteractiveMethods(providerId, resolved.integration).find(
          (entry) => entry.raw["type"] === "oauth" && (entry.method.id === methodId || entry.raw["id"] === methodId),
        );
        const v2MethodId = typeof match?.raw["id"] === "string" ? match.raw["id"] : "";
        if (!v2MethodId) {
          throw new Error("OpenCode authentication method is unavailable");
        }
        const rawResponse = await runtime.server.client.json<unknown>(
          `/api/integration/${encodeURIComponent(integrationId)}/connect/oauth`,
          {
            method: "POST",
            body: JSON.stringify({ methodID: v2MethodId, ...(inputs ? { answer: inputs } : {}) }),
          },
        );
        const response = v2DataRecord(rawResponse);
        attemptId = typeof response["attemptID"] === "string" ? response["attemptID"] : "";
        if (!attemptId) {
          throw new Error("OpenCode OAuth start response is missing attemptID");
        }
        url = typeof response["url"] === "string" ? response["url"] : null;
        completion = response["mode"] === "auto" ? "automatic" : "code";
        instructions = typeof response["instructions"] === "string" ? response["instructions"] : null;
      } else {
        methodIndexValue = await methodIndex(runtime.server, providerId, methodId);
        const response = await runtime.server.client.json<Record<string, unknown>>(
          `/provider/${encodeURIComponent(providerId)}/oauth/authorize`,
          { method: "POST", body: JSON.stringify({ method: methodIndexValue, ...(inputs ? { inputs } : {}) }) },
        );
        url = typeof response["url"] === "string" ? response["url"] : null;
        completion = response["method"] === "auto" ? "automatic" : "code";
        instructions = typeof response["instructions"] === "string" ? response["instructions"] : null;
      }

      const id = `ocf_${randomUUID()}`;
      const expiresAt = Date.now() + FLOW_TTL_MS;
      const expiryTimer = setTimeout(() => {
        const expired = flows.get(id);
        if (!expired) return;
        flows.delete(id);
        expired.server.release();
      }, FLOW_TTL_MS);
      expiryTimer.unref();
      flows.set(id, {
        id,
        apiVersion,
        providerId,
        methodIndex: methodIndexValue,
        integrationId,
        attemptId,
        expiresAt,
        completion,
        server: runtime.server,
        contextKey: contextKey(ctx),
        expiryTimer,
      });
      return {
        id,
        providerId,
        url,
        completion,
        instructions,
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
    clearTimeout(flow.expiryTimer);
    try {
      if (flow.apiVersion === 2) {
        const integrationId = flow.integrationId ?? flow.providerId;
        const attemptId = flow.attemptId ?? "";
        const basePath = `/api/integration/${encodeURIComponent(integrationId)}/connect/oauth/${encodeURIComponent(attemptId)}`;
        if (flow.completion === "code" || Boolean(code)) {
          await flow.server.client.ok(`${basePath}/complete`, {
            method: "POST",
            body: JSON.stringify({ code: code ?? null }),
          });
        }
        if (flow.completion === "automatic") {
          const deadline = Math.min(flow.expiresAt, Date.now() + FLOW_TTL_MS);
          while (true) {
            const statusPayload = await flow.server.client.json<unknown>(basePath);
            const attempt = v2DataRecord(statusPayload);
            const status = attempt["status"];
            if (status === "complete") break;
            if (status === "failed" || status === "expired") {
              throw new Error(typeof attempt["message"] === "string" ? attempt["message"] : `OpenCode OAuth ${status}`);
            }
            if (Date.now() >= deadline) {
              throw new OpenCodeAuthFlowExpiredError();
            }
            await new Promise((resolve) => setTimeout(resolve, 250));
          }
        }
      } else {
        await flow.server.client.ok(`/provider/${encodeURIComponent(flow.providerId)}/oauth/callback`, {
          method: "POST",
          body: JSON.stringify({ method: flow.methodIndex, ...(code ? { code } : {}) }),
        });
      }
      await flow.server.retireAuthStore();
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
      if (serverApiVersion(runtime.server) === 2) {
        const { integrationId, integration } = await fetchV2Integration(runtime.server, providerId);
        const credentialIds = new Set<string>();
        const connections = integration && Array.isArray(integration["connections"])
          ? integration["connections"]
          : [];
        for (const raw of connections) {
          const conn = rec(raw);
          if (conn["type"] === "credential" && typeof conn["id"] === "string" && conn["id"]) {
            credentialIds.add(conn["id"]);
          }
        }
        if (credentialIds.size === 0) {
          const allCredentials = await runtime.server.client.json<unknown>("/api/credential").catch(() => []);
          for (const raw of v2DataArray(allCredentials)) {
            const cred = rec(raw);
            if (cred["integrationID"] === integrationId && typeof cred["id"] === "string" && cred["id"]) {
              credentialIds.add(cred["id"]);
            }
          }
        }
        for (const credId of credentialIds) {
          await runtime.server.client.ok(`/api/credential/${encodeURIComponent(credId)}`, { method: "DELETE" });
        }
      } else {
        await runtime.server.client.ok(`/auth/${encodeURIComponent(providerId)}`, { method: "DELETE" });
      }
      await runtime.server.retireAuthStore({ force: true });
    } finally {
      runtime.server.release();
    }
  },
};
