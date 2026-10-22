import { readFile } from "node:fs/promises";

const REQUEST_TIMEOUT_MS = 15_000;

export class CoreApiError extends Error {
  readonly statusCode: number;
  readonly outcome: "failed" | "unknown";
  readonly recording?: Record<string, unknown>;
  constructor(statusCode: number, outcome: "failed" | "unknown", message: string, recording?: Record<string, unknown>) {
    super(message);
    this.statusCode = statusCode;
    this.outcome = outcome;
    this.recording = recording;
  }
}

export type CoreTokenProvider = () => Promise<string>;

export function tokenFromFile(path: string): CoreTokenProvider {
  return async () => {
    const token = (await readFile(path, "utf8")).trim();
    if (!/^[A-Za-z0-9._~-]{32,256}$/.test(token)) throw new Error("MCP Core credential is unavailable");
    return token;
  };
}

export class McpCoreClient {
  readonly tokenProvider: CoreTokenProvider;
  readonly baseUrl: string;
  readonly fetchImpl: typeof fetch;
  constructor(
    tokenProvider: CoreTokenProvider,
    baseUrl = "http://127.0.0.1:8787",
    fetchImpl: typeof fetch = fetch,
  ) {
    this.tokenProvider = tokenProvider;
    this.baseUrl = baseUrl;
    this.fetchImpl = fetchImpl;
  }

  async getCapabilities(): Promise<Record<string, unknown>> {
    return this.request("GET", "/api/v1/capabilities");
  }

  async getState(): Promise<Record<string, unknown>> {
    return this.request("GET", "/api/v1/state");
  }

  async executeAction(actionId: string, parameters: Record<string, unknown>, intentId: string): Promise<Record<string, unknown>> {
    return this.request("POST", "/api/v1/actions", {
      body: JSON.stringify({ action_id: actionId, parameters }),
      headers: { "Content-Type": "application/json", "Idempotency-Key": intentId },
    });
  }

  private async request(method: "GET" | "POST", path: string, init: { body?: string; headers?: Record<string, string> } = {}): Promise<Record<string, unknown>> {
    const token = await this.tokenProvider();
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, ...init.headers },
        ...(init.body ? { body: init.body } : {}),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw new CoreApiError(502, "unknown", "Common physical layer is unavailable; do not retry this action automatically");
    }
    const text = await response.text();
    let payload: unknown;
    try { payload = text ? JSON.parse(text) : {}; } catch { payload = {}; }
    const body = payload && typeof payload === "object" && !Array.isArray(payload) ? payload as Record<string, unknown> : {};
    if (!response.ok) {
      const outcome = body.outcome === "unknown" || response.status >= 500 ? "unknown" : "failed";
      const safeMessage = typeof body.error === "string" ? body.error : `Common physical layer rejected the request (${response.status})`;
      const recording = body.recording && typeof body.recording === "object" && !Array.isArray(body.recording) ? body.recording as Record<string, unknown> : undefined;
      throw new CoreApiError(response.status, outcome, safeMessage, recording);
    }
    return body;
  }
}
