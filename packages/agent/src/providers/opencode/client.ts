export class OpenCodeHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(`OpenCode request failed (${status})`);
    this.name = "OpenCodeHttpError";
  }
}

export class OpenCodeClient {
  private readonly authorization: string;

  constructor(
    readonly baseUrl: string,
    password: string,
  ) {
    this.authorization = `Basic ${Buffer.from(`opencode:${password}`, "utf8").toString("base64")}`;
  }

  async request(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set("authorization", this.authorization);
    if (init.body !== undefined && !headers.has("content-type")) {
      headers.set("content-type", "application/json");
    }
    return fetch(`${this.baseUrl}${path}`, { ...init, headers });
  }

  async json<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await this.request(path, init);
    if (!response.ok) {
      throw new OpenCodeHttpError(response.status, `http_${response.status}`);
    }
    return await response.json() as T;
  }

  async ok(path: string, init: RequestInit = {}): Promise<void> {
    const response = await this.request(path, init);
    if (!response.ok) {
      throw new OpenCodeHttpError(response.status, `http_${response.status}`);
    }
  }
}
