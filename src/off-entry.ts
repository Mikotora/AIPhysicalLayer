import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { fileURLToPath, pathToFileURL } from "node:url";
import { findActionDefinition, listAiCallableActions, toActionRequest } from "./action-catalog.ts";
import type { ActionSource } from "./types.ts";
import { ClientAuthenticator } from "./auth.ts";
import { FileAiAccessLog, type AiAccessLogWriter } from "./ai-access-log.ts";

const HOST_PATTERN = /^127\.0\.0\.1(?::\d+)?$/;
const UPSTREAM_ACTION_URL = "http://127.0.0.1:8787/api/actions";
const SESSION_COOKIE = "off_entry_session";
export const SESSION_TTL_MS = 5 * 60 * 1_000;
const MAX_BODY_BYTES = 4 * 1_024;
const UPSTREAM_TIMEOUT_MS = 12_000;
const DEFAULT_ACTION_ID = "light.living_room.off";
const DEFAULT_AI_ACCESS_LOG_PATH = fileURLToPath(new URL("../data/ai-access.jsonl", import.meta.url));

type EntryOutcome = {
  status: "succeeded" | "failed" | "unknown";
  commandId?: string;
};

type EntryIntent = {
  requestId: string;
  actionId: string;
  idempotencyKey: string;
  execution?: Promise<EntryOutcome>;
  outcome?: EntryOutcome;
};

type EntrySession = {
  sessionId: string;
  csrfToken: string;
  expiresAt: number;
  intent: EntryIntent;
};

type OffEntryOptions = {
  fetchImpl?: typeof fetch;
  now?: () => number;
  publicOrigin?: string;
  authenticator?: ClientAuthenticator;
  aiAccessLog?: AiAccessLogWriter;
  remoteGatewayOrigin?: string;
};

const REMOTE_GATEWAY_PATHS = new Set([
  "/mcp",
  "/.well-known/oauth-protected-resource",
  "/.well-known/oauth-protected-resource/mcp",
  "/.well-known/oauth-authorization-server",
  "/.well-known/openid-configuration",
  "/oauth/authorize",
  "/oauth/token",
  "/oauth/register",
  "/oauth/google/callback",
  "/oauth/consent",
]);

class AuditUnavailableError extends Error {
  constructor(cause: unknown) {
    super("audit unavailable", { cause });
    this.name = "AuditUnavailableError";
  }
}

export type OffEntryServer = Server & {
  createIntent: (actionId?: string) => string;
};

function newIntent(actionId = DEFAULT_ACTION_ID): EntryIntent {
  const definition = findActionDefinition(actionId, "nature");
  if (!definition || definition.id !== DEFAULT_ACTION_ID) {
    throw new Error("action is not exposed by the entry gateway");
  }
  const requestId = randomUUID();
  return { requestId, actionId, idempotencyKey: `off-entry-${requestId}` };
}

export function createOffEntryServer(options: OffEntryOptions = {}): OffEntryServer {
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  const publicOrigin = normalizePublicOrigin(options.publicOrigin);
  const authenticator = options.authenticator ?? new ClientAuthenticator();
  const aiAccessLog = options.aiAccessLog ?? new FileAiAccessLog(DEFAULT_AI_ACCESS_LOG_PATH);
  const remoteGatewayOrigin = normalizeLoopbackOrigin(options.remoteGatewayOrigin);
  const sessions = new Map<string, EntrySession>();
  let currentIntent = newIntent();

  const createNextIntent = (actionId = DEFAULT_ACTION_ID): EntryIntent => {
    if (!currentIntent.outcome) throw new Error("current intent has not completed");
    currentIntent = newIntent(actionId);
    return currentIntent;
  };

  const server = createServer(async (request, response) => {
    setSecurityHeaders(response);
    try {
      const host = request.headers.host ?? "";
      const requestOrigin = resolveRequestOrigin(host, publicOrigin);
      if (!requestOrigin) return sendText(response, 400, "invalid host");

      const url = new URL(request.url ?? "/", requestOrigin);
      pruneExpiredSessions(sessions, now());

      if (request.method === "GET" && url.pathname === "/health") {
        return sendJson(response, 200, {
          service: "off-entry",
          status: "ok",
          listening_scope: "localhost",
          public_origin_configured: Boolean(publicOrigin),
          session_ttl_seconds: SESSION_TTL_MS / 1_000,
          current_intent: currentIntent.outcome ? "completed" : currentIntent.execution ? "executing" : "ready",
          allowed_actions: listAiCallableActions("nature").map((action) => action.id),
          actuation_performed: false,
          ai_direct_api: { path_prefix: "/ai/v1", configured_clients: authenticator.configuredClientCount },
          remote_mcp_gateway: { enabled: Boolean(remoteGatewayOrigin), exact_path_count: REMOTE_GATEWAY_PATHS.size },
        });
      }

      if (REMOTE_GATEWAY_PATHS.has(url.pathname)) {
        if (!remoteGatewayOrigin) return sendText(response, 404, "not found");
        return await proxyRemoteGateway(request, response, url, remoteGatewayOrigin);
      }

      if (url.pathname.startsWith("/ai/v1/")) {
        return await proxyAiApi(request, response, url.pathname, fetchImpl, authenticator, aiAccessLog);
      }

      if (request.method === "GET" && url.pathname === "/") {
        const { sessionId, session } = issueSession(sessions, currentIntent, now());
        setSessionCookie(response, sessionId, requestOrigin);
        if (currentIntent.execution) {
          return sendHtml(response, 200, renderResultPage(await currentIntent.execution, true, session));
        }
        const nonce = randomBytes(18).toString("base64url");
        setActionPageCsp(response, nonce);
        return sendHtml(response, 200, renderActionPage(session, nonce));
      }

      if (request.method === "GET" && url.pathname === "/api/session") {
        const { sessionId, session } = issueSession(sessions, currentIntent, now());
        setSessionCookie(response, sessionId, requestOrigin);
        return sendJson(response, 200, sessionPayload(session));
      }

      if (url.pathname === "/off" && request.method !== "POST") {
        response.setHeader("Allow", "POST");
        return sendText(response, 405, "method not allowed");
      }

      if (request.method === "POST" && url.pathname === "/off") {
        if (!isTrustedBrowserSubmission(request, requestOrigin)) return sendText(response, 403, "origin rejected");
        const contentType = request.headers["content-type"] ?? "";
        if (!contentType.toLowerCase().startsWith("application/x-www-form-urlencoded")) {
          return sendText(response, 415, "unsupported content type");
        }
        const session = validSession(request, sessions, now());
        if (!session) return sendHtml(response, 403, renderExpiredPage());
        const form = await readFormBody(request);
        if (form.size !== 1 || !form.has("csrf_token")) return sendText(response, 400, "unexpected form field");
        if (!safeEqual(form.get("csrf_token") ?? "", session.csrfToken)) return sendText(response, 403, "csrf rejected");

        const { outcome, replayed } = await executeIntent(fetchImpl, session.intent, "local-web");
        return sendHtml(response, 200, renderResultPage(outcome, replayed, session));
      }

      if (request.method === "POST" && url.pathname === "/intent") {
        if (!isTrustedBrowserSubmission(request, requestOrigin)) return sendText(response, 403, "origin rejected");
        const contentType = request.headers["content-type"] ?? "";
        if (!contentType.toLowerCase().startsWith("application/x-www-form-urlencoded")) {
          return sendText(response, 415, "unsupported content type");
        }
        const session = validSession(request, sessions, now());
        if (!session) return sendHtml(response, 403, renderExpiredPage());
        const form = await readFormBody(request);
        if (form.size !== 2 || form.get("action_id") !== DEFAULT_ACTION_ID || !safeEqual(form.get("csrf_token") ?? "", session.csrfToken)) {
          return sendText(response, 403, "intent issuance rejected");
        }
        try {
          session.intent = createNextIntent(DEFAULT_ACTION_ID);
          refreshSession(response, session, requestOrigin, now());
          response.writeHead(303, { Location: "/" });
          return response.end();
        } catch {
          return sendText(response, 409, "current intent has not completed");
        }
      }

      if (request.method === "POST" && url.pathname === "/api/intents") {
        const session = validApiSession(request, response, sessions, requestOrigin, now());
        if (!session) return;
        const body = await readJsonBody(request);
        if (!isExactIntentRequest(body)) return sendJson(response, 400, { error: "only light.living_room.off is allowed" });
        try {
          session.intent = createNextIntent(body.action_id);
          refreshSession(response, session, requestOrigin, now());
          return sendJson(response, 201, sessionPayload(session));
        } catch {
          return sendJson(response, 409, { error: "current intent has not completed" });
        }
      }

      if (request.method === "POST" && url.pathname === "/api/actions") {
        const session = validApiSession(request, response, sessions, requestOrigin, now());
        if (!session) return;
        const body = await readJsonBody(request);
        if (!isExactActionRequest(body, session.intent)) {
          return sendJson(response, 400, { error: "request does not match the active allowed intent" });
        }
        const { outcome, replayed } = await executeIntent(fetchImpl, session.intent, "ai-client");
        return sendJson(response, 200, {
          request_id: session.intent.requestId,
          action_id: session.intent.actionId,
          status: outcome.status,
          replayed,
          ...(outcome.commandId ? { command_id: outcome.commandId } : {}),
        });
      }

      return sendText(response, 404, "not found");
    } catch (error) {
      if (error instanceof AuditUnavailableError) {
        console.error("off entry audit unavailable");
        return sendJson(response, 503, { error: "audit unavailable" });
      }
      const message = error instanceof SyntaxError ? error.message : "internal error";
      const status = error instanceof SyntaxError ? 400 : 500;
      if (status === 500) console.error("off entry request failed");
      return sendText(response, status, message);
    }
  }) as OffEntryServer;

  server.createIntent = (actionId = DEFAULT_ACTION_ID) => createNextIntent(actionId).requestId;
  return server;
}

async function proxyAiApi(
  request: IncomingMessage,
  response: ServerResponse,
  pathname: string,
  fetchImpl: typeof fetch,
  authenticator: ClientAuthenticator,
  aiAccessLog: AiAccessLogWriter,
): Promise<void> {
  const authMetadata = describeAuthorization(request.headers.authorization);
  const clientId = authenticator.authenticate(request.headers.authorization);
  if (!clientId) {
    await recordAiAccess(aiAccessLog, null, request.method, pathname, "result", 401, authMetadata);
    response.setHeader("WWW-Authenticate", "Bearer");
    return sendJson(response, 401, { error: "AI client authentication failed" });
  }
  const routes: Record<string, { method: string; upstream: string }> = {
    "/ai/v1/capabilities": { method: "GET", upstream: "/api/v1/capabilities" },
    "/ai/v1/state": { method: "GET", upstream: "/api/v1/state" },
    "/ai/v1/actions": { method: "POST", upstream: "/api/v1/actions" },
  };
  const route = routes[pathname];
  if (!route) {
    await recordAiAccess(aiAccessLog, clientId, request.method, pathname, "result", 404, authMetadata);
    return sendJson(response, 404, { error: "not found" });
  }
  if (request.method !== route.method) {
    await recordAiAccess(aiAccessLog, clientId, request.method, pathname, "result", 405, authMetadata);
    response.setHeader("Allow", route.method);
    return sendJson(response, 405, { error: "method not allowed" });
  }
  const headers: Record<string, string> = { Authorization: String(request.headers.authorization), "X-AI-Gateway-Client": clientId };
  let body: Buffer | undefined;
  if (request.method === "POST") {
    const contentType = request.headers["content-type"] ?? "";
    if (!contentType.toLowerCase().startsWith("application/json")) {
      await recordAiAccess(aiAccessLog, clientId, request.method, pathname, "result", 415, authMetadata);
      return sendJson(response, 415, { error: "Content-Type must be application/json" });
    }
    const idempotencyKey = String(request.headers["idempotency-key"] ?? "");
    if (!idempotencyKey) {
      await recordAiAccess(aiAccessLog, clientId, request.method, pathname, "result", 400, authMetadata);
      return sendJson(response, 400, { error: "Idempotency-Key is required" });
    }
    headers["Content-Type"] = "application/json"; headers["Idempotency-Key"] = idempotencyKey;
    body = await readRequestBody(request);
  }

  await recordAiAccess(aiAccessLog, clientId, request.method, pathname, "attempt", null, authMetadata);

  let upstream: Response;
  let payload: string;
  try {
    upstream = await fetchImpl(`http://127.0.0.1:8787${route.upstream}`, { method: route.method, headers, ...(body ? { body } : {}), signal: AbortSignal.timeout(12_000) });
    payload = await upstream.text();
  } catch {
    await recordAiAccess(aiAccessLog, clientId, request.method, pathname, "result", 502, authMetadata);
    return sendJson(response, 502, { error: "Core is unavailable", outcome: "unknown" });
  }

  await recordAiAccess(aiAccessLog, clientId, request.method, pathname, "result", upstream.status, authMetadata);
  response.writeHead(upstream.status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  response.end(payload);
}

async function recordAiAccess(
  writer: AiAccessLogWriter,
  clientId: string | null,
  method: string | undefined,
  path: string,
  phase: "attempt" | "result",
  status: number | null,
  authentication: ReturnType<typeof describeAuthorization>,
): Promise<void> {
  try {
    await writer.append({
      timestamp: new Date().toISOString(),
      client_id: clientId,
      method: method ?? "UNKNOWN",
      path,
      phase,
      status,
      ...authentication,
    });
  } catch (error) {
    throw new AuditUnavailableError(error);
  }
}

function describeAuthorization(value: string | undefined): {
  auth_header: "missing" | "bearer" | "other";
  auth_scheme: "bearer" | "basic" | "other" | null;
  auth_header_length: number | null;
  credential_length: number | null;
} {
  if (value === undefined) {
    return { auth_header: "missing", auth_scheme: null, auth_header_length: null, credential_length: null };
  }
  const match = value.match(/^([^\s]+)\s+(.*)$/);
  if (!match) {
    return { auth_header: "other", auth_scheme: "other", auth_header_length: value.length, credential_length: null };
  }
  const scheme = match[1].toLowerCase();
  const authScheme = scheme === "bearer" || scheme === "basic" ? scheme : "other";
  if (scheme !== "bearer") {
    return { auth_header: "other", auth_scheme: authScheme, auth_header_length: value.length, credential_length: null };
  }
  return {
    auth_header: "bearer",
    auth_scheme: "bearer",
    auth_header_length: value.length,
    credential_length: match[2].length,
  };
}

function issueSession(sessions: Map<string, EntrySession>, intent: EntryIntent, timestamp: number) {
  const sessionId = randomUUID();
  const session: EntrySession = {
    sessionId,
    csrfToken: randomBytes(32).toString("base64url"),
    expiresAt: timestamp + SESSION_TTL_MS,
    intent,
  };
  sessions.set(sessionId, session);
  return { sessionId, session };
}

function validSession(request: IncomingMessage, sessions: Map<string, EntrySession>, timestamp: number): EntrySession | undefined {
  const sessionId = readCookie(request, SESSION_COOKIE);
  const session = sessionId ? sessions.get(sessionId) : undefined;
  return session && session.expiresAt > timestamp ? session : undefined;
}

function validApiSession(
  request: IncomingMessage,
  response: ServerResponse,
  sessions: Map<string, EntrySession>,
  requestOrigin: string,
  timestamp: number,
): EntrySession | undefined {
  if (!isTrustedApiSubmission(request, requestOrigin)) {
    sendJson(response, 403, { error: "origin rejected" });
    return undefined;
  }
  const contentType = request.headers["content-type"] ?? "";
  if (!contentType.toLowerCase().startsWith("application/json")) {
    sendJson(response, 415, { error: "Content-Type must be application/json" });
    return undefined;
  }
  const session = validSession(request, sessions, timestamp);
  if (!session) {
    sendJson(response, 403, { error: "session expired", reauthenticate: "/" });
    return undefined;
  }
  const csrfToken = String(request.headers["x-csrf-token"] ?? "");
  if (!safeEqual(csrfToken, session.csrfToken)) {
    sendJson(response, 403, { error: "csrf rejected" });
    return undefined;
  }
  return session;
}

function sessionPayload(session: EntrySession) {
  return {
    request_id: session.intent.requestId,
    action_id: session.intent.actionId,
    intent_status: session.intent.outcome ? "completed" : session.intent.execution ? "executing" : "ready",
    csrf_token: session.csrfToken,
    expires_at: new Date(session.expiresAt).toISOString(),
    allowed_actions: listAiCallableActions("nature").map((action) => action.id),
  };
}

function setSessionCookie(response: ServerResponse, sessionId: string, requestOrigin: string): void {
  response.setHeader(
    "Set-Cookie",
    `${SESSION_COOKIE}=${sessionId}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL_MS / 1_000}${requestOrigin.startsWith("https://") ? "; Secure" : ""}`,
  );
}

function refreshSession(response: ServerResponse, session: EntrySession, requestOrigin: string, timestamp: number): void {
  session.csrfToken = randomBytes(32).toString("base64url");
  session.expiresAt = timestamp + SESSION_TTL_MS;
  setSessionCookie(response, session.sessionId, requestOrigin);
}

function normalizePublicOrigin(rawOrigin: string | undefined): string | undefined {
  if (rawOrigin === undefined || rawOrigin === "") return undefined;
  let parsed: URL;
  try {
    parsed = new URL(rawOrigin);
  } catch {
    throw new Error("OFF_ENTRY_PUBLIC_ORIGIN must be one exact HTTPS origin");
  }
  if (parsed.protocol !== "https:" || parsed.username !== "" || parsed.password !== "" || parsed.pathname !== "/" || parsed.search !== "" || parsed.hash !== "" || rawOrigin !== parsed.origin) {
    throw new Error("OFF_ENTRY_PUBLIC_ORIGIN must be one exact HTTPS origin");
  }
  return parsed.origin;
}

function normalizeLoopbackOrigin(rawOrigin: string | undefined): string | undefined {
  if (rawOrigin === undefined || rawOrigin === "") return undefined;
  const parsed = new URL(rawOrigin);
  if (parsed.protocol !== "http:" || parsed.hostname !== "127.0.0.1" || parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash || parsed.origin !== rawOrigin) {
    throw new Error("REMOTE_MCP_GATEWAY_ORIGIN must be one exact loopback HTTP origin");
  }
  return parsed.origin;
}

async function proxyRemoteGateway(request: IncomingMessage, response: ServerResponse, url: URL, gatewayOrigin: string): Promise<void> {
  const upstream = new URL(`${url.pathname}${url.search}`, gatewayOrigin);
  const headers = { ...request.headers, host: upstream.host };
  delete headers.connection;
  delete headers["proxy-connection"];
  await new Promise<void>((resolve) => {
    const outbound = httpRequest({
      hostname: upstream.hostname,
      port: upstream.port,
      path: `${upstream.pathname}${upstream.search}`,
      method: request.method,
      headers,
      timeout: 30_000,
    }, (incoming) => {
      if (url.pathname === "/oauth/consent") {
        console.log(JSON.stringify({
          at: new Date().toISOString(),
          event: "remote_gateway_proxy_response",
          path: "/oauth/consent",
          status: incoming.statusCode ?? 502,
          location_shape: classifyProxyLocation(incoming.headers.location),
          set_cookie_shape: incoming.headers["set-cookie"] ? "present" : "absent",
        }));
      }
      response.writeHead(incoming.statusCode ?? 502, incoming.headers);
      incoming.pipe(response);
      incoming.once("end", resolve);
      incoming.once("error", () => { if (!response.writableEnded) response.end(); resolve(); });
    });
    outbound.once("timeout", () => outbound.destroy(new Error("remote MCP gateway timed out")));
    outbound.once("error", () => { if (!response.headersSent) sendJson(response, 502, { error: "remote MCP gateway is unavailable" }); else if (!response.writableEnded) response.end(); resolve(); });
    request.pipe(outbound);
  });
}

function classifyProxyLocation(value: string | undefined): "absent" | "https-external" | "loopback" | "other" {
  if (!value) return "absent";
  try {
    const location = new URL(value);
    if (location.protocol === "https:") return "https-external";
    if (location.protocol === "http:" && location.hostname === "127.0.0.1") return "loopback";
    return "other";
  } catch { return "other"; }
}

function resolveRequestOrigin(host: string, publicOrigin: string | undefined): string | undefined {
  if (HOST_PATTERN.test(host)) return `http://${host}`;
  if (publicOrigin && host.toLowerCase() === new URL(publicOrigin).host.toLowerCase()) return publicOrigin;
  return undefined;
}

export function createIntentControlServer(offEntryServer: OffEntryServer): Server {
  return createServer((request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    const host = request.headers.host ?? "";
    if (!HOST_PATTERN.test(host)) return sendText(response, 400, "invalid host");
    const url = new URL(request.url ?? "/", `http://${host}`);
    if (request.method === "GET" && url.pathname === "/health") {
      return sendJson(response, 200, { service: "intent-control", status: "ok", listening_scope: "localhost", actuation_performed: false });
    }
    if (request.method !== "POST" || url.pathname !== "/intents") {
      response.setHeader("Allow", "GET, POST");
      return sendText(response, 405, "method not allowed");
    }
    if (request.headers.origin !== undefined || request.headers["x-intent-request"] !== "new-light-off") {
      return sendText(response, 403, "intent issuance rejected");
    }
    const contentLength = request.headers["content-length"];
    if ((contentLength !== undefined && contentLength !== "0") || request.headers["transfer-encoding"] !== undefined) {
      return sendText(response, 400, "request body is not allowed");
    }
    try {
      return sendJson(response, 201, { request_id: offEntryServer.createIntent(DEFAULT_ACTION_ID), action_id: DEFAULT_ACTION_ID });
    } catch {
      return sendText(response, 409, "current intent has not completed");
    }
  });
}

async function executeIntent(fetchImpl: typeof fetch, intent: EntryIntent, source: ActionSource) {
  const replayed = Boolean(intent.execution);
  intent.execution ??= executeAllowedAction(fetchImpl, intent, source).then((outcome) => {
    intent.outcome = outcome;
    return outcome;
  });
  return { outcome: await intent.execution, replayed };
}

async function executeAllowedAction(fetchImpl: typeof fetch, intent: EntryIntent, source: ActionSource): Promise<EntryOutcome> {
  const definition = findActionDefinition(intent.actionId, "nature");
  if (!definition || definition.id !== DEFAULT_ACTION_ID) return { status: "failed" };
  try {
    const upstream = await fetchImpl(UPSTREAM_ACTION_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": intent.idempotencyKey, "X-Action-Source": source },
      body: JSON.stringify(toActionRequest(definition)),
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    const body = await readSafeJson(upstream);
    const commandId = readSafeCommandId(body);
    if (upstream.ok && body?.status === "succeeded") return { status: "succeeded", ...(commandId ? { commandId } : {}) };
    if (body?.outcome === "unknown") return { status: "unknown", ...(commandId ? { commandId } : {}) };
    return { status: "failed", ...(commandId ? { commandId } : {}) };
  } catch {
    return { status: "unknown" };
  }
}

async function readSafeJson(response: Response): Promise<Record<string, unknown> | null> {
  try {
    const value = await response.json();
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function readSafeCommandId(body: Record<string, unknown> | null): string | undefined {
  const value = body?.command_id;
  return typeof value === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(value) ? value : undefined;
}

async function readRequestBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new SyntaxError("request body is too large");
    chunks.push(buffer);
  }
  if (chunks.length === 0) throw new SyntaxError("request body is required");
  return Buffer.concat(chunks);
}

async function readFormBody(request: IncomingMessage): Promise<URLSearchParams> {
  return new URLSearchParams((await readRequestBody(request)).toString("utf8"));
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  return JSON.parse((await readRequestBody(request)).toString("utf8"));
}

function isExactIntentRequest(value: unknown): value is { action_id: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Object.keys(record).length === 1 && record.action_id === DEFAULT_ACTION_ID;
}

function isExactActionRequest(value: unknown, intent: EntryIntent): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Object.keys(record).length === 3 && record.request_id === intent.requestId && record.action_id === intent.actionId
    && Boolean(record.parameters) && typeof record.parameters === "object" && !Array.isArray(record.parameters)
    && Object.keys(record.parameters as Record<string, unknown>).length === 0;
}

function readCookie(request: IncomingMessage, name: string): string | undefined {
  const cookies = request.headers.cookie?.split(";") ?? [];
  for (const cookie of cookies) {
    const [key, ...valueParts] = cookie.trim().split("=");
    if (key === name) return valueParts.join("=");
  }
  return undefined;
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function isTrustedBrowserSubmission(request: IncomingMessage, expectedOrigin: string): boolean {
  const origin = request.headers.origin;
  const fetchSite = request.headers["sec-fetch-site"];
  const referer = request.headers.referer;
  if (origin && origin !== "null" && origin !== expectedOrigin) return false;
  if (fetchSite && fetchSite !== "same-origin" && fetchSite !== "none") return false;
  if (origin === expectedOrigin) return true;
  let sameOriginReferer = false;
  if (referer) {
    try { sameOriginReferer = new URL(referer).origin === expectedOrigin; } catch { return false; }
  }
  return fetchSite === "same-origin" || (fetchSite === "none" && sameOriginReferer);
}

function isTrustedApiSubmission(request: IncomingMessage, expectedOrigin: string): boolean {
  const origin = request.headers.origin;
  const fetchSite = request.headers["sec-fetch-site"];
  if (origin && origin !== expectedOrigin) return false;
  if (fetchSite && fetchSite !== "same-origin" && fetchSite !== "none") return false;
  return true;
}

function pruneExpiredSessions(sessions: Map<string, EntrySession>, timestamp: number): void {
  for (const [sessionId, session] of sessions) if (session.expiresAt <= timestamp) sessions.delete(sessionId);
}

function renderActionPage(session: EntrySession, nonce: string): string {
  return `<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>リビング照明OFF</title>
<style>:root{color-scheme:light;font-family:system-ui,sans-serif}body{min-height:100vh;margin:0;display:grid;place-items:center;background:#f4f1ea;color:#17202a}main{width:min(30rem,calc(100% - 2rem));text-align:center}button{width:100%;padding:1.15rem;border:0;border-radius:.8rem;color:white;background:#243447;font-size:1.1rem;font-weight:700;cursor:pointer}button:disabled{background:#78828c;cursor:not-allowed}button:focus-visible,a:focus-visible{outline:4px solid #c9782b;outline-offset:4px}.timer{margin-top:1rem;font-variant-numeric:tabular-nums}.expired{color:#8a2f20;font-weight:700}</style></head>
<body><main><h1>リビング照明OFF</h1><form method="post" action="/off"><input type="hidden" name="csrf_token" value="${session.csrfToken}"><button type="submit" id="off-button">リビング照明を消す</button></form>
<p class="timer" id="timer" aria-live="polite">有効期限を確認中…</p><p id="renew" hidden><a href="/">操作ページを開き直す</a></p></main>
<script nonce="${nonce}">(()=>{const expiresAt=${session.expiresAt};const button=document.getElementById("off-button");const timer=document.getElementById("timer");const renew=document.getElementById("renew");const update=()=>{const remaining=Math.max(0,Math.ceil((expiresAt-Date.now())/1000));if(remaining<=0){button.disabled=true;timer.textContent="この操作ページは期限切れです。再認証済みの入口から開き直してください。";timer.className="timer expired";renew.hidden=false;return}const minutes=Math.floor(remaining/60);const seconds=String(remaining%60).padStart(2,"0");timer.textContent="操作可能な残り時間 "+minutes+":"+seconds;setTimeout(update,250)};update()})();</script></body></html>`;
}

const CARD_STYLE = `:root{color-scheme:light;font-family:system-ui,sans-serif}body{min-height:100vh;margin:0;display:grid;place-items:center;background:#f4f1ea;color:#17202a}main{width:min(34rem,calc(100% - 2rem));padding:2rem;box-sizing:border-box;border-radius:.8rem;background:white;box-shadow:0 .5rem 2rem #0002}code{overflow-wrap:anywhere}button{width:100%;padding:.9rem;border:0;border-radius:.8rem;color:white;background:#243447;font-size:1rem;font-weight:700;cursor:pointer}a{color:#174f82}`;

function renderExpiredPage(): string {
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>操作ページの期限切れ</title><style>${CARD_STYLE}</style></head><body><main><h1>操作ページの期限が切れました</h1><p>実機操作は送信されていません。Google認証済みの入口から新しい操作ページを開いてください。</p><p><a href="/">操作ページを開き直す</a></p></main></body></html>`;
}

function renderResultPage(outcome: EntryOutcome, replayed: boolean, session?: EntrySession): string {
  const heading = outcome.status === "succeeded" ? "消灯要求を受理しました" : outcome.status === "unknown" ? "結果を確認できません" : "消灯要求は失敗しました";
  const detail = outcome.status === "unknown" ? "自動再送はしません。照明を目視で確認してください。" : replayed ? "同じ操作の結果を表示しています。実機への再送はしていません。" : "このページからの実機送信は完了しました。";
  const command = outcome.commandId ? `<p>command ID: <code>${escapeHtml(outcome.commandId)}</code></p>` : "";
  const nextIntent = session ? `<form method="post" action="/intent"><input type="hidden" name="csrf_token" value="${session.csrfToken}"><input type="hidden" name="action_id" value="${DEFAULT_ACTION_ID}"><button type="submit">新しい消灯操作を準備する</button></form>` : "";
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>消灯結果</title><style>${CARD_STYLE}</style></head><body><main><h1>${heading}</h1><p>${detail}</p>${command}${nextIntent}</main></body></html>`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" })[character]!);
}

function setSecurityHeaders(response: ServerResponse): void {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; script-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
}

function setActionPageCsp(response: ServerResponse, nonce: string): void {
  response.setHeader("Content-Security-Policy", `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'`);
}

function sendHtml(response: ServerResponse, statusCode: number, html: string): void {
  response.writeHead(statusCode, { "Content-Type": "text/html; charset=utf-8" }); response.end(html);
}
function sendJson(response: ServerResponse, statusCode: number, value: unknown): void {
  response.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" }); response.end(JSON.stringify(value));
}
function sendText(response: ServerResponse, statusCode: number, message: string): void {
  response.writeHead(statusCode, { "Content-Type": "text/plain; charset=utf-8" }); response.end(message);
}

function parsePort(rawPort: string | undefined, fallback: number, variableName: string): number {
  const port = Number(rawPort ?? String(fallback));
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`${variableName} must be an integer between 1 and 65535`);
  return port;
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === invokedPath) {
  const host = "127.0.0.1";
  const port = parsePort(process.env.OFF_ENTRY_PORT, 8790, "OFF_ENTRY_PORT");
  const controlPort = parsePort(process.env.OFF_ENTRY_CONTROL_PORT, 8791, "OFF_ENTRY_CONTROL_PORT");
  const publicOrigin = process.env.OFF_ENTRY_PUBLIC_ORIGIN;
  const remoteGatewayOrigin = process.env.REMOTE_MCP_GATEWAY_ORIGIN;
  const authenticator = ClientAuthenticator.fromFile(process.env.AI_CLIENT_KEYS_FILE);
  const server = createOffEntryServer({ publicOrigin, authenticator, remoteGatewayOrigin });
  const controlServer = createIntentControlServer(server);
  server.listen(port, host, () => {
    console.log(`Living-room light OFF entry listening at http://${host}:${port}`);
    console.log("Human session routes expose light.living_room.off only; /ai/v1 delegates exact requests to the Core Policy");
  });
  controlServer.listen(controlPort, host, () => console.log(`Local intent issuer listening at http://${host}:${controlPort}`));
  if (publicOrigin) console.log(`One exact public origin enabled: ${publicOrigin}`);
}
