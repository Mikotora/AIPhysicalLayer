import { readFile } from "node:fs/promises";

const REQUEST_TIMEOUT_MS = 15_000;

export type GatewayCoreFailure = "core_unavailable" | "core_rejected" | "failed" | "unknown";

export class GatewayCoreError extends Error {
  readonly classification: GatewayCoreFailure;
  readonly recording?: Record<string, unknown>;
  constructor(classification: GatewayCoreFailure, message: string, recording?: Record<string, unknown>) {
    super(message);
    this.classification = classification;
    this.recording = recording;
  }
}

export interface GatewayCore {
  getCapabilities(): Promise<Record<string, unknown>>;
  getState(): Promise<Record<string, unknown>>;
  executeAction(actionId: string, parameters: Record<string, unknown>, idempotencyKey: string): Promise<Record<string, unknown>>;
}

export class GatewayCoreClient implements GatewayCore {
  readonly tokenFile: string;
  readonly baseUrl: string;
  readonly fetchImpl: typeof fetch;
  constructor(tokenFile: string, baseUrl = "http://127.0.0.1:8787", fetchImpl: typeof fetch = fetch) {
    this.tokenFile = tokenFile; this.baseUrl = baseUrl; this.fetchImpl = fetchImpl;
  }
  getCapabilities(): Promise<Record<string, unknown>> { return this.request("GET", "/api/v1/capabilities"); }
  getState(): Promise<Record<string, unknown>> { return this.request("GET", "/api/v1/state"); }
  executeAction(actionId: string, parameters: Record<string, unknown>, idempotencyKey: string): Promise<Record<string, unknown>> {
    return this.request("POST", "/api/v1/actions", {
      body: JSON.stringify({ action_id: actionId, parameters }),
      headers: { "Content-Type": "application/json", "Idempotency-Key": idempotencyKey },
    });
  }

  private async request(method: "GET" | "POST", path: string, init: { body?: string; headers?: Record<string, string> } = {}): Promise<Record<string, unknown>> {
    const token = (await readFile(this.tokenFile, "utf8")).trim();
    if (!/^[A-Za-z0-9._~-]{32,256}$/.test(token)) throw new GatewayCoreError("core_unavailable", "Core credential is unavailable");
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, ...init.headers },
        ...(init.body ? { body: init.body } : {}),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw new GatewayCoreError(method === "POST" ? "unknown" : "core_unavailable", method === "POST"
        ? "Common physical layer is unavailable; the action outcome is unknown and must not be retried automatically"
        : "Common physical layer is unavailable");
    }
    const text = await response.text();
    let payload: unknown;
    try { payload = text ? JSON.parse(text) : {}; } catch { payload = {}; }
    const value = payload && typeof payload === "object" && !Array.isArray(payload) ? payload as Record<string, unknown> : undefined;
    if (!response.ok) {
      const unknown = value?.outcome === "unknown" || response.status >= 500;
      const classification = method === "POST" ? (unknown ? "unknown" : "failed") : (unknown ? "core_unavailable" : "core_rejected");
      const fallback = method === "POST" ? "Common physical layer rejected the action" : "Common physical layer rejected the read";
      const recording = value?.recording && typeof value.recording === "object" && !Array.isArray(value.recording) ? value.recording as Record<string, unknown> : undefined;
      throw new GatewayCoreError(classification, typeof value?.error === "string" ? value.error : fallback, recording);
    }
    if (!value) throw new GatewayCoreError(method === "POST" ? "unknown" : "core_unavailable", "Common physical layer returned an invalid response");
    return value;
  }
}
