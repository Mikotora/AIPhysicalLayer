import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { join } from "node:path";
import { ActionCore, ActionValidationError } from "./core.ts";
import { AdapterExecutionError, type DeviceAdapter } from "./adapters/base.ts";
import { FileActionLog, type ActionLogWriter } from "./logger.ts";
import { MockAdapter } from "./adapters/mock.ts";
import { NatureAdapter } from "./adapters/nature.ts";
import { readAppConfig, type AppConfig } from "./config.ts";
import { createDeviceRegistry } from "./registry.ts";
import { ActionPolicy } from "./action-policy.ts";
import { ClientAuthenticator } from "./auth.ts";
import { buildCapabilityDocument } from "./capabilities.ts";
import { ResilientCommandStore, type CommandStore, type CommandStoreAvailabilityEvent } from "./command-store.ts";

const WEB_ROOT = fileURLToPath(new URL("../web/", import.meta.url));
const DEFAULT_LOG_PATH = fileURLToPath(new URL("../data/actions.jsonl", import.meta.url));
const DEFAULT_COMMAND_DB_PATH = fileURLToPath(new URL("../data/commands.sqlite", import.meta.url));
const MAX_BODY_BYTES = 16 * 1024;

type ServerOptions = { logWriter?: ActionLogWriter; config?: AppConfig; fetchImpl?: typeof fetch; policy?: ActionPolicy; authenticator?: ClientAuthenticator; commandStore?: CommandStore; adapter?: DeviceAdapter };

export function createAppServer(options: ServerOptions = {}): Server {
  const config = options.config ?? readAppConfig();
  const logWriter = options.logWriter ?? new FileActionLog(process.env.ACTION_LOG_PATH ?? DEFAULT_LOG_PATH);
  const registry = createDeviceRegistry(config.mode);
  const policy = options.policy ?? (config.mode === "nature" ? ActionPolicy.forNature(config.nature.bindings) : new ActionPolicy());
  const authenticator = options.authenticator ?? ClientAuthenticator.fromFile(config.aiClientKeysFile);
  const commandStore = options.commandStore ?? openCommandStore(process.env.COMMAND_DB_PATH ?? DEFAULT_COMMAND_DB_PATH);
  const adapter: DeviceAdapter = options.adapter ?? (config.mode === "nature" ? new NatureAdapter(config.nature, options.fetchImpl) : new MockAdapter());
  const core = new ActionCore([adapter], logWriter, registry, policy, commandStore);

  const server = createServer(async (request, response) => {
    setSecurityHeaders(response);
    try {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (request.method === "GET" && url.pathname === "/api/status") return sendJson(response, 200, {
        service: "ok", phase: 3, stage: "daily-prototype", mode: config.mode, listening_scope: "localhost", adapters: [adapter.name],
        nature_api_enabled: config.mode === "nature", real_device_operations: config.mode === "nature", external_publishing: false,
        ai_client_authentication: { configured_clients: authenticator.configuredClientCount, key_storage: "sha256" }, real_action_allowlist: policy.list(),
      });
      if (request.method === "GET" && url.pathname === "/api/health") {
        const health = await adapter.healthCheck();
        return sendJson(response, health.status === "ok" ? 200 : 503, { service: "ok", listening_scope: "localhost", mode: config.mode, adapter: health, actuation_performed: false });
      }
      if (request.method === "GET" && url.pathname === "/api/devices") return sendJson(response, 200, { devices: registry.listDevices(policy) });
      if (request.method === "GET" && url.pathname === "/api/logs") {
        const requested = Number(url.searchParams.get("limit") ?? "20"); const limit = Number.isInteger(requested) ? Math.min(Math.max(requested, 1), 100) : 20;
        return sendJson(response, 200, { entries: await logWriter.list(limit) });
      }

      if (url.pathname.startsWith("/api/v1/")) {
        const clientId = authenticateAiClient(request, response, authenticator); if (!clientId) return;
        if (request.method === "GET" && url.pathname === "/api/v1/capabilities") return sendJson(response, 200, buildCapabilityDocument(registry, policy));
        if (request.method === "GET" && url.pathname === "/api/v1/state") return sendJson(response, 200, await core.readState());
        if (request.method === "POST" && url.pathname === "/api/v1/actions") {
          requireJson(request); const body = await readJsonBody(request); const parsed = readAiActionRequest(body);
          const result = await core.executeById(parsed.actionId, parsed.parameters, { idempotencyKey: String(request.headers["idempotency-key"] ?? ""), source: "ai-client", clientId });
          return sendJson(response, result.replayed ? 200 : 201, result);
        }
        return sendJson(response, 404, { error: "not found" });
      }

      if (request.method === "POST" && url.pathname === "/api/actions") {
        requireJson(request); const body = await readJsonBody(request);
        const result = await core.execute(body, { idempotencyKey: String(request.headers["idempotency-key"] ?? ""), source: request.headers["x-action-source"] === "local-web" ? "local-web" : "local-api" });
        return sendJson(response, result.replayed ? 200 : 201, result);
      }
      if (request.method === "GET") {
        const staticFile = staticFileFor(url.pathname);
        if (staticFile) { const contents = await readFile(join(WEB_ROOT, staticFile.name)); response.writeHead(200, { "Content-Type": staticFile.contentType }); return response.end(contents); }
      }
      return sendJson(response, 404, { error: "not found" });
    } catch (error) {
      if (error instanceof ActionValidationError) return sendJson(response, error.statusCode, { error: error.message, ...(error.recording ? { recording: error.recording } : {}) });
      if (error instanceof AdapterExecutionError) return sendJson(response, error.statusCode, { error: error.message, outcome: error.outcome, ...(error.recording ? { recording: error.recording } : {}) });
      if (error instanceof SyntaxError) return sendJson(response, Number((error as SyntaxError & { statusCode?: number }).statusCode ?? 400), { error: error.message });
      console.error("request failed", error instanceof Error ? error.message : "unknown error");
      return sendJson(response, 500, { error: "internal error" });
    }
  });
  if (!options.commandStore && commandStore.close) server.once("close", () => commandStore.close?.());
  return server;
}

function authenticateAiClient(request: IncomingMessage, response: ServerResponse, authenticator: ClientAuthenticator): string | undefined {
  const clientId = authenticator.authenticate(request.headers.authorization);
  if (!clientId) { response.setHeader("WWW-Authenticate", "Bearer"); sendJson(response, 401, { error: "AI client authentication failed" }); }
  return clientId;
}
function readAiActionRequest(value: unknown): { actionId: string; parameters: Record<string, unknown> } {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new SyntaxError("request body must be an object");
  const item = value as Record<string, unknown>;
  if (Object.keys(item).some((key) => key !== "action_id" && key !== "parameters") || typeof item.action_id !== "string" || !item.parameters || typeof item.parameters !== "object" || Array.isArray(item.parameters)) throw new SyntaxError("request requires action_id and parameters only");
  return { actionId: item.action_id, parameters: item.parameters as Record<string, unknown> };
}
function requireJson(request: IncomingMessage): void { if (!(request.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) throw Object.assign(new SyntaxError("Content-Type must be application/json"), { statusCode: 415 }); }
async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of request) { const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); size += buffer.length; if (size > MAX_BODY_BYTES) throw new SyntaxError("request body is too large"); chunks.push(buffer); }
  if (!chunks.length) throw new SyntaxError("request body is required"); return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
function staticFileFor(pathname: string) { return ({ "/": { name: "index.html", contentType: "text/html; charset=utf-8" }, "/app.js": { name: "app.js", contentType: "text/javascript; charset=utf-8" }, "/styles.css": { name: "styles.css", contentType: "text/css; charset=utf-8" } } as Record<string, { name: string; contentType: string }>)[pathname] ?? null; }
function setSecurityHeaders(response: ServerResponse): void { response.setHeader("Cache-Control", "no-store"); response.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"); response.setHeader("Referrer-Policy", "no-referrer"); response.setHeader("X-Content-Type-Options", "nosniff"); response.setHeader("X-Frame-Options", "DENY"); }
function sendJson(response: ServerResponse, statusCode: number, value: unknown): void { response.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" }); response.end(JSON.stringify(value)); }
function openCommandStore(path: string): CommandStore {
  return new ResilientCommandStore(path, { report: reportCommandStoreAvailability });
}
function reportCommandStoreAvailability(event: CommandStoreAvailabilityEvent): void {
  console.error(JSON.stringify(event.event === "degraded"
    ? { at: new Date().toISOString(), event: "command_store_degraded", reason: event.reason, action_execution: "continued", idempotency: "temporary_memory" }
    : { at: new Date().toISOString(), event: "command_store_recovered", action_execution: "persistent", idempotency: "sqlite" }));
}
function parsePort(raw: string | undefined): number { const port = Number(raw ?? "8787"); if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("PORT must be an integer between 1 and 65535"); return port; }

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === invokedPath) {
  const host = "127.0.0.1"; const port = parsePort(process.env.PORT); const server = createAppServer();
  server.listen(port, host, () => {
    const config = readAppConfig();
    console.log(`AIPhysicalLayer daily prototype listening at http://${host}:${port}`);
    console.log(config.mode === "nature" ? "Mode: Nature (Catalog-bound direct-action Policy)" : "Mode: Mock");
  });
}
