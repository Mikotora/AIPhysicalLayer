import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { isIP } from "node:net";
import { pathToFileURL } from "node:url";
import { McpServer, OAuthError, OAuthErrorCode, bearerAuthChallengeResponse, createMcpHandler, verifyBearerToken } from "@modelcontextprotocol/server";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { z } from "zod";
import { findActionDefinition, listActionDefinitions, type CommonActionDefinition } from "../../src/action-catalog.ts";
import { FileGatewayAudit, type GatewayAuditWriter } from "./audit.ts";
import { readGatewayConfig, type GatewayConfig } from "./config.ts";
import { GatewayCoreClient, GatewayCoreError, type GatewayCore } from "./core-client.ts";
import { GoogleOAuthClient, type GoogleIdentityProvider } from "./google.ts";
import { MacKeychainSecretStore } from "./keychain.ts";
import { GatewayStore, MAX_CLIENT_REDIRECT_URIS, sha256, type DoorClient, type DoorClientRegistration, type OAuthTransaction } from "./store.ts";

const HOST_PATTERN = /^127\.0\.0\.1(?::\d+)?$/;
const READ_SCOPE = "mcp:read";
const ACTION_SCOPE = "mcp:act";
const PHASE_THREE_SCOPE = `${ACTION_SCOPE} ${READ_SCOPE}`;
const ACTION_IDS = listActionDefinitions("nature").map((item) => item.id) as [string, ...string[]];
const ExecuteActionInput = z.object({
  action_id: z.enum(ACTION_IDS).describe("Action ID selected from get_capabilities; all 48 common Catalog actions are represented"),
  parameters: z.record(z.string(), z.unknown()).describe("Exact parameters allowed by the selected capability"),
  intent_id: z.string().min(8).max(128).regex(/^[A-Za-z0-9._~-]+$/).describe("Stable identifier for this one user intent; never reuse it for a new request"),
}).strict();
const MAX_BODY_BYTES = 16 * 1024;
const MCP_PROTOCOL_VERSIONS = ["2026-07-28", "2025-11-25", "2025-06-18", "2025-03-26"];

type GatewayOptions = {
  config?: GatewayConfig;
  store?: GatewayStore;
  audit?: GatewayAuditWriter;
  core?: GatewayCore;
  google?: GoogleIdentityProvider;
  fetchImpl?: typeof fetch;
  now?: () => number;
  cleanupIntervalMs?: number;
  registrationRejectionLogger?: RegistrationRejectionLogger;
};

export type GatewayServer = Server & { closeDependencies: () => void };

export type RegistrationRejectionLog = {
  at: string;
  event: "oauth_client_registration_rejected";
  rejection_reason: "rate-limit" | "content-type" | "body-json" | "metadata-shape" | "redirect-uri" | "token-auth-method" | "grant-types" | "client-limit" | "pending-client-limit" | "registration-audit";
  client_name_shape: "absent" | "non-string" | "empty" | "too-long" | "control-character" | "valid-string";
  redirect_uris: {
    container: "absent" | "array" | "other";
    count: number | null;
    items: Array<{
      value_shape: "string" | "non-string";
      scheme?: "https" | "http" | "other" | "invalid";
      host_kind?: "domain" | "ip" | "loopback-v4" | "loopback-v6" | "localhost" | "absent" | "invalid";
      host?: string;
      port?: "present" | "absent" | "unknown";
    }>;
    truncated: boolean;
  };
  grant_types: {
    container: "absent" | "array" | "other";
    count: number | null;
    values: Array<"authorization_code" | "refresh_token" | "client_credentials" | "implicit" | "device_code" | "jwt_bearer" | "other-string" | "non-string">;
    truncated: boolean;
  };
  token_endpoint_auth_method_shape: "absent" | "non-string" | "none" | "client_secret_basic" | "client_secret_post" | "client_secret_jwt" | "private_key_jwt" | "other-string";
};

type RegistrationRejectionLogger = (entry: RegistrationRejectionLog) => void;

type CompletedConsent = { csrfHash: string; location: string; formActionRedirectUris: string[]; expiresAt: number };

export function createRemoteMcpGateway(options: GatewayOptions = {}): GatewayServer {
  const config = options.config ?? readGatewayConfig();
  const store = options.store ?? new GatewayStore(config.databaseFile);
  const audit = options.audit ?? new FileGatewayAudit(config.auditLogFile);
  const core = options.core ?? new GatewayCoreClient(config.coreTokenFile);
  const secrets = new MacKeychainSecretStore(config.keychainService);
  const google = options.google ?? new GoogleOAuthClient(config, secrets, options.fetchImpl);
  const now = options.now ?? (() => Math.floor(Date.now() / 1_000));
  const registrationRejectionLogger = options.registrationRejectionLogger ?? ((entry) => console.log(JSON.stringify(entry)));
  store.seedApprovedRedirectUris(config.bootstrapApprovedRedirectUris, now());
  const resource = `${config.publicOrigin}/mcp`;
  const resourceMetadataUrl = `${config.publicOrigin}/.well-known/oauth-protected-resource/mcp`;
  const limiter = new RateLimiter(now);
  const completedConsents = new Map<string, CompletedConsent>();
  const cleanupTimer = setInterval(() => {
    try {
      const timestamp = now();
      cleanupExpiredRegistrations(store, audit, timestamp, config.pendingClientTtlSeconds);
      for (const [id, completed] of completedConsents) if (completed.expiresAt <= timestamp) completedConsents.delete(id);
    }
    catch { console.error("remote MCP gateway cleanup failed"); }
  }, options.cleanupIntervalMs ?? 60_000);
  cleanupTimer.unref();

  const mcpHandler = createMcpHandler((context) => {
    const clientId = context.authInfo?.clientId;
    const client = clientId ? store.getClient(clientId) : undefined;
    const scopes = context.authInfo?.scopes ?? [];
    const server = new McpServer({ name: "AIPhysicalLayer common gateway", version: "1.1.0" }, {
      capabilities: { tools: {} },
      supportedProtocolVersions: MCP_PROTOCOL_VERSIONS,
    });
    server.registerTool("get_capabilities", {
      title: "Get physical capabilities",
      description: "Read the device capability catalog. This tool cannot operate devices.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    }, async () => executeReadTool("get_capabilities", client, store, audit, core, now, () => core.getCapabilities()));
    server.registerTool("get_state", {
      title: "Get current physical state",
      description: "Read observed device state and perceptions. Unknown values remain unknown; this tool cannot operate devices.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    }, async () => executeReadTool("get_state", client, store, audit, core, now, () => core.getState()));
    if (scopes.includes(ACTION_SCOPE)) {
      server.registerTool("execute_action", {
        title: "Execute a physical action",
        description: "Execute one of the 48 common Catalog actions only after the AI client has obtained the user's own tool approval. Use get_capabilities for allowed parameters. A fresh user intent requires a fresh intent_id. Reuse intent_id only for transport replay of that same intent. If the result or state_after is unknown, report it as unknown: do not guess success and do not retry automatically. If recording.status is temporary, explicitly relay its warning to the user.",
        inputSchema: ExecuteActionInput,
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      }, async ({ action_id, parameters, intent_id }) => executeActionTool(action_id, parameters, intent_id, client, store, audit, core, now));
    }
    return server;
  }, { legacy: "stateless", responseMode: "auto", maxRequestBodySize: MAX_BODY_BYTES, onerror: () => console.error("remote MCP request failed") });
  const nodeMcpHandler = toNodeHandler(mcpHandler, { maxRequestBodySize: MAX_BODY_BYTES, onerror: () => console.error("remote MCP adapter failed") });

  const server = createServer(async (request, response) => {
    setSecurityHeaders(response);
    try {
      if (!HOST_PATTERN.test(request.headers.host ?? "")) return sendJson(response, 400, { error: "invalid host" });
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      cleanupExpiredRegistrations(store, audit, now(), config.pendingClientTtlSeconds);

      if (request.method === "GET" && url.pathname === "/health") {
        const clients = store.listClients();
        return sendJson(response, audit.isWritable?.() === false ? 503 : 200, {
          service: "remote-mcp-gateway",
          status: audit.isWritable?.() === false ? "degraded" : "ok",
          listening_scope: "localhost",
          mode: "read-and-actuate",
          tools: ["get_capabilities", "get_state", "execute_action"],
          clients: clients.map(safeClientSummary),
          google_master_switch: store.masterSwitch(),
          audit_writable: audit.isWritable?.() !== false,
          actuation_performed: false,
        });
      }

      if (request.method === "GET" && (url.pathname === "/.well-known/oauth-protected-resource/mcp" || url.pathname === "/.well-known/oauth-protected-resource")) {
        return sendJson(response, 200, {
          resource,
          authorization_servers: [config.publicOrigin],
          scopes_supported: [READ_SCOPE, ACTION_SCOPE],
          bearer_methods_supported: ["header"],
          resource_name: "AIPhysicalLayer common gateway",
        });
      }
      if (request.method === "GET" && (url.pathname === "/.well-known/oauth-authorization-server" || url.pathname === "/.well-known/openid-configuration")) {
        return sendJson(response, 200, authorizationMetadata(config));
      }
      if (url.pathname === "/oauth/register") {
        if (request.method !== "POST") return methodNotAllowed(response, "POST");
        if (!limiter.allow(`register:${remoteAddress(request)}`, config.registrationRateLimitPerHour, 3_600)) {
          logRegistrationRejection(registrationRejectionLogger, "rate-limit", undefined, now());
          return oauthError(response, 429, "temporarily_unavailable", "registration rate limit exceeded");
        }
        return await handleRegistration(request, response, config, store, audit, now(), registrationRejectionLogger);
      }
      if (url.pathname === "/oauth/authorize") {
        if (request.method !== "GET") return methodNotAllowed(response, "GET");
        if (!limiter.allow(`authorize:${remoteAddress(request)}`, config.oauthRateLimitPerMinute, 60)) return oauthError(response, 429, "temporarily_unavailable", "authorization rate limit exceeded");
        return await handleAuthorize(url, response, config, store, audit, google, options.fetchImpl ?? fetch, now());
      }
      if (url.pathname === "/oauth/google/callback") {
        if (request.method !== "GET") return methodNotAllowed(response, "GET");
        return await handleGoogleCallback(url, response, config, store, google, now());
      }
      if (url.pathname === "/oauth/consent") {
        if (request.method === "GET") return handleConsentPage(url, response, store, now());
        if (request.method === "POST") return await handleConsentDecision(request, response, config, store, completedConsents, now());
        return methodNotAllowed(response, "GET, POST");
      }
      if (url.pathname === "/oauth/token") {
        if (request.method !== "POST") return methodNotAllowed(response, "POST");
        if (!limiter.allow(`token:${remoteAddress(request)}`, config.oauthRateLimitPerMinute, 60)) return oauthError(response, 429, "temporarily_unavailable", "token rate limit exceeded");
        return await handleToken(request, response, config, store, google, now());
      }
      if (url.pathname === "/mcp") {
        if (!request.method || !["POST", "GET", "DELETE"].includes(request.method)) return methodNotAllowed(response, "POST, GET, DELETE");
        try {
          const auth = await verifyBearerToken(request.headers.authorization, {
            verifier: {
              async verifyAccessToken(token: string) {
                const record = store.accessToken(sha256(token), now());
                if (!record) throw new OAuthError(OAuthErrorCode.InvalidToken, "access token is invalid or expired");
                return { token, clientId: record.clientId, scopes: record.scopes, expiresAt: record.expiresAt, resource: record.resource, resourceMetadataUrl };
              },
            },
            requiredScopes: [READ_SCOPE],
            expectedResource: new URL(resource),
            resourceMetadataUrl,
          });
          (request as IncomingMessage & { auth?: unknown }).auth = auth;
          return await nodeMcpHandler(request, response);
        } catch (error) {
          const challenge = bearerAuthChallengeResponse(error, { requiredScopes: [READ_SCOPE], resourceMetadataUrl });
          return await sendWebResponse(response, challenge);
        }
      }
      return sendJson(response, 404, { error: "not found" });
    } catch (error) {
      console.error("remote MCP gateway request failed", error instanceof SyntaxError ? error.message : "internal error");
      return sendJson(response, error instanceof SyntaxError ? 400 : 500, { error: error instanceof SyntaxError ? error.message : "internal error" });
    }
  }) as GatewayServer;

  server.closeDependencies = () => { clearInterval(cleanupTimer); void mcpHandler.close(); if (!options.store) store.close(); };
  server.once("close", server.closeDependencies);
  return server;
}

async function executeReadTool(
  tool: "get_capabilities" | "get_state",
  client: DoorClient | undefined,
  store: GatewayStore,
  audit: GatewayAuditWriter,
  _core: GatewayCore,
  now: () => number,
  read: () => Promise<Record<string, unknown>>,
) {
  if (!client || client.status !== "active") return toolError("OAuth client is unavailable");
  const base = { timestamp: new Date(now() * 1_000).toISOString(), client_id: client.clientId, client_name_claimed: client.clientName, tool } as const;
  try { await audit.append({ ...base, phase: "attempt", result: "pending" }); }
  catch { return toolError("Audit unavailable; the read was not sent to Core"); }
  let payload: Record<string, unknown>;
  try { payload = await read(); }
  catch (error) {
    const result = error instanceof GatewayCoreError ? error.classification : "failed";
    try { await audit.append({ ...base, phase: "result", result }); } catch { return toolError("Audit unavailable"); }
    return toolError(error instanceof GatewayCoreError ? error.message : "Read failed");
  }
  try { await audit.append({ ...base, phase: "result", result: "succeeded" }); }
  catch { return toolError("Audit unavailable"); }
  store.markClientUsed(client.clientId, now());
  return { content: [{ type: "text" as const, text: JSON.stringify(payload) }], structuredContent: payload };
}

type ActionClassification = "succeeded" | "replayed" | "failed" | "unknown";
type PostActionState = {
  classification: "observed" | "unknown";
  device_id: string;
  relevant_field: string | null;
  field?: Record<string, unknown>;
  note: string;
};

async function executeActionTool(
  actionId: string,
  parameters: Record<string, unknown>,
  intentId: string,
  client: DoorClient | undefined,
  store: GatewayStore,
  audit: GatewayAuditWriter,
  core: GatewayCore,
  now: () => number,
) {
  if (!client || client.status !== "active") return toolError("OAuth client is unavailable");
  const definition = findActionDefinition(actionId, "nature");
  if (!definition) return toolError("Action is not in the common Catalog");
  const base = {
    timestamp: new Date(now() * 1_000).toISOString(), client_id: client.clientId, client_name_claimed: client.clientName,
    tool: "execute_action" as const, action_id: definition.id, action_name: definition.label,
  };
  try { await audit.append({ ...base, phase: "attempt", result: "pending" }); }
  catch { return actionToolError(actionReport(definition, "failed", unknownPostActionState(definition), "Audit unavailable; the action was not sent to Core")); }

  let classification: ActionClassification;
  let message: string | undefined;
  let recording: Record<string, unknown> | undefined;
  try {
    const response = await core.executeAction(actionId, parameters, scopedIdempotencyKey(client.clientId, intentId));
    classification = response.replayed === true ? "replayed" : "succeeded";
    recording = object(response.recording);
  } catch (error) {
    classification = error instanceof GatewayCoreError && (error.classification === "failed" || error.classification === "core_rejected") ? "failed" : "unknown";
    message = error instanceof Error ? error.message : "The action outcome is unknown";
    recording = error instanceof GatewayCoreError ? error.recording : undefined;
  }

  const stateAfter = await readPostActionState(core, definition);
  try { await audit.append({ ...base, phase: "result", result: classification }); }
  catch {
    return actionToolError(actionReport(definition, "unknown", unknownPostActionState(definition), "The action may have been sent, but its audit result could not be recorded. Do not retry automatically.", recording));
  }
  store.markClientUsed(client.clientId, now());
  const report = actionReport(definition, classification, stateAfter, message, recording);
  return classification === "failed" || classification === "unknown" ? actionToolError(report) : toolResult(report);
}

function scopedIdempotencyKey(clientId: string, intentId: string): string {
  return `door.${sha256(`${clientId}\u0000${intentId}`)}`;
}

async function readPostActionState(core: GatewayCore, definition: CommonActionDefinition): Promise<PostActionState> {
  const relevantField = relevantStateField(definition);
  if (!relevantField) return unknownPostActionState(definition);
  try {
    const snapshot = await core.getState();
    const devices = Array.isArray(snapshot.devices) ? snapshot.devices : [];
    const device = devices.find((item) => object(item)?.device_id === definition.device);
    const fields = object(object(device)?.fields);
    const field = object(fields?.[relevantField]);
    if (field?.status === "observed") return {
      classification: "observed", device_id: definition.device, relevant_field: relevantField, field,
      note: "This is an observed value returned after the action, not an inference from the command.",
    };
  } catch { /* a read failure leaves post-action state unknown */ }
  return unknownPostActionState(definition, relevantField);
}

function unknownPostActionState(definition: CommonActionDefinition, relevantField = relevantStateField(definition)): PostActionState {
  return {
    classification: "unknown", device_id: definition.device, relevant_field: relevantField,
    note: "The post-action state is not observed. Do not infer it from the command or report it as confirmed.",
  };
}

function relevantStateField(definition: CommonActionDefinition): string | null {
  const action = definition.action;
  if (action === "set_mode") return "mode";
  if (action === "set_temperature") return "setpoint_temperature";
  if (action === "set_fan_speed") return "fan_speed";
  if (action === "set_vertical_direction") return "vertical_direction";
  if (action === "set_horizontal_direction") return "horizontal_direction";
  if (action.startsWith("input.")) return "input";
  if (action.startsWith("channel.")) return "channel";
  if (action.startsWith("volume.")) return "volume";
  if (action === "mute_toggle") return "muted";
  if (action === "brighten" || action === "dim") return "brightness";
  if (["on", "off", "full", "favorite", "night", "power_toggle", "cycle"].includes(action) || definition.device === "appliance.generic") return "power";
  return null;
}

function actionReport(definition: CommonActionDefinition, resultClassification: ActionClassification, stateAfter: PostActionState, detail?: string, recording?: Record<string, unknown>): Record<string, unknown> {
  return {
    action: { id: definition.id, name: definition.label },
    result_classification: resultClassification,
    state_after: stateAfter,
    reporting_rule: stateAfter.classification === "unknown"
      ? "Report the post-action state as unknown. Never convert the sent command or last_command history into an observed state."
      : "Report only the included observed field as observed.",
    ...(recording ? {
      recording,
      recording_reporting_rule: "Tell the user that this operation was not persistently recorded and duplicate prevention is temporary.",
    } : {}),
    ...(detail ? { detail } : {}),
  };
}

function toolResult(payload: Record<string, unknown>) {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload) }], structuredContent: payload };
}

function actionToolError(payload: Record<string, unknown>) {
  return { isError: true, content: [{ type: "text" as const, text: JSON.stringify(payload) }], structuredContent: payload };
}

function toolError(message: string) {
  return { isError: true, content: [{ type: "text" as const, text: message }] };
}

async function handleRegistration(
  request: IncomingMessage,
  response: ServerResponse,
  config: GatewayConfig,
  store: GatewayStore,
  audit: GatewayAuditWriter,
  now: number,
  rejectionLogger: RegistrationRejectionLogger,
): Promise<void> {
  if (!isJson(request)) {
    logRegistrationRejection(rejectionLogger, "content-type", undefined, now);
    return oauthError(response, 415, "invalid_client_metadata", "Content-Type must be application/json");
  }
  let parsed: unknown;
  try { parsed = await readBody(request, "json"); }
  catch (error) {
    logRegistrationRejection(rejectionLogger, "body-json", undefined, now);
    throw error;
  }
  const body = object(parsed);
  const redirectUris = body && Array.isArray(body.redirect_uris) ? body.redirect_uris : [];
  const clientName = validateClientName(body?.client_name);
  if (!body || !clientName || redirectUris.length < 1 || redirectUris.some((item) => typeof item !== "string")) {
    logRegistrationRejection(rejectionLogger, "metadata-shape", body, now);
    return oauthError(response, 400, "invalid_client_metadata", "one client name and one or more redirect URIs are required");
  }
  const uniqueRedirectUris = [...new Set(redirectUris as string[])];
  if (uniqueRedirectUris.length > MAX_CLIENT_REDIRECT_URIS) {
    logRegistrationRejection(rejectionLogger, "metadata-shape", body, now);
    return oauthError(response, 400, "invalid_client_metadata", `at most ${MAX_CLIENT_REDIRECT_URIS} unique redirect URIs are supported`);
  }
  if (uniqueRedirectUris.some((redirectUri) => !validateRedirectUri(redirectUri))) {
    logRegistrationRejection(rejectionLogger, "redirect-uri", body, now);
    return oauthError(response, 400, "invalid_redirect_uri", "every redirect URI must be an exact HTTPS URI without userinfo, fragment, or wildcard");
  }
  if (body.token_endpoint_auth_method !== undefined && body.token_endpoint_auth_method !== "none") {
    logRegistrationRejection(rejectionLogger, "token-auth-method", body, now);
    return oauthError(response, 400, "invalid_client_metadata", "only public clients are supported");
  }
  if (body.grant_types !== undefined && (!Array.isArray(body.grant_types) || !body.grant_types.includes("authorization_code") || !body.grant_types.includes("refresh_token"))) {
    logRegistrationRejection(rejectionLogger, "grant-types", body, now);
    return oauthError(response, 400, "invalid_client_metadata", "authorization_code and refresh_token grants are required");
  }
  const clientId = `dcr_${randomBytes(24).toString("base64url")}`;
  const approvalStatus = store.areRedirectsApproved(uniqueRedirectUris) ? "approved" : "pending";
  if (store.clientCount() >= config.maxClients) {
    logRegistrationRejection(rejectionLogger, "client-limit", body, now);
    return oauthError(response, 429, "invalid_client_metadata", "client limit reached");
  }
  if (approvalStatus === "pending" && store.pendingClientCount() >= config.maxPendingClients) {
    logRegistrationRejection(rejectionLogger, "pending-client-limit", body, now);
    return oauthError(response, 429, "invalid_client_metadata", "pending client limit reached");
  }
  const candidate = { clientId, clientName, redirectUris: uniqueRedirectUris, kind: "dcr" as const };
  try { await audit.append(registrationAudit(candidate, approvalStatus, now)); }
  catch {
    logRegistrationRejection(rejectionLogger, "registration-audit", body, now);
    return oauthError(response, 503, "temporarily_unavailable", "registration audit is unavailable");
  }
  store.registerClient(candidate, now, approvalStatus);
  return sendJson(response, 201, {
    client_id: clientId,
    client_name: clientName,
    redirect_uris: uniqueRedirectUris,
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  });
}

async function handleAuthorize(
  url: URL,
  response: ServerResponse,
  config: GatewayConfig,
  store: GatewayStore,
  audit: GatewayAuditWriter,
  google: GoogleIdentityProvider,
  fetchImpl: typeof fetch,
  now: number,
): Promise<void> {
  const clientId = url.searchParams.get("client_id") ?? "";
  const requestedScope = resolveAuthorizationScope(url.searchParams.get("scope"));
  let client = store.getClient(clientId);
  if (!client && clientId.startsWith("https://")) {
    if (store.clientCount() >= config.maxClients) {
      logAuthorizeRequest("rejected", "client_limit", "cimd", "absent", requestedScope);
      return oauthError(response, 429, "temporarily_unavailable", "client limit reached");
    }
    const metadata = await fetchClientMetadata(clientId, fetchImpl);
    if (!metadata) {
      logAuthorizeRequest("rejected", "client_metadata", "cimd", "absent", requestedScope);
      return oauthError(response, 400, "invalid_request", "client metadata is invalid or not allowed");
    }
    const approvalStatus = store.areRedirectsApproved(metadata.redirectUris ?? []) ? "approved" : "pending";
    if (approvalStatus === "pending" && store.pendingClientCount() >= config.maxPendingClients) {
      logAuthorizeRequest("rejected", "pending_client_limit", "cimd", "absent", requestedScope);
      return oauthError(response, 429, "temporarily_unavailable", "pending client limit reached");
    }
    try { await audit.append(registrationAudit(metadata, approvalStatus, now)); }
    catch {
      logAuthorizeRequest("rejected", "registration_audit", "cimd", "absent", requestedScope);
      return oauthError(response, 503, "temporarily_unavailable", "registration audit is unavailable");
    }
    client = store.upsertCimdClient(metadata, now, approvalStatus);
  }
  if (!client || client.status === "revoked") {
    logAuthorizeRequest("rejected", "client_registration", clientId.startsWith("https://") ? "cimd" : clientId.startsWith("dcr_") ? "dcr" : "other", client?.status ?? "absent", requestedScope);
    return oauthError(response, 400, "unauthorized_client", "client is not registered");
  }
  if (client.approvalStatus !== "approved") {
    logAuthorizeRequest("rejected", "registration_pending", client.kind, client.status, requestedScope);
    return oauthError(response, 403, "authorization_pending", "client registration awaits owner approval");
  }
  const redirectUri = url.searchParams.get("redirect_uri") ?? "";
  const state = url.searchParams.get("state") ?? "";
  const requestedResource = url.searchParams.get("resource") ?? "";
  const challenge = url.searchParams.get("code_challenge") ?? "";
  const rejectionReason = url.searchParams.get("response_type") !== "code" ? "response_type"
    : !client.redirectUris.includes(redirectUri) ? "redirect_uri"
      : !safeOpaque(state, 1, 1_024) ? "state"
        : !requestedScope.accepted ? "scope"
          : requestedResource !== `${config.publicOrigin}/mcp` ? "resource"
            : url.searchParams.get("code_challenge_method") !== "S256" ? "pkce_method"
              : !/^[A-Za-z0-9_-]{43,128}$/.test(challenge) ? "pkce_challenge"
                : undefined;
  if (rejectionReason) {
    logAuthorizeRequest("rejected", rejectionReason, client.kind, client.status, requestedScope);
    return oauthError(response, 400, "invalid_request", "authorization request is invalid");
  }
  logAuthorizeRequest("accepted", "none", client.kind, client.status, requestedScope);
  const scope = PHASE_THREE_SCOPE;
  const csrf = randomBytes(32).toString("base64url");
  const transaction: OAuthTransaction = {
    id: randomUUID(), clientId, redirectUri, clientState: state, scope, resource: requestedResource, codeChallenge: challenge,
    googleState: randomBytes(32).toString("base64url"), googleNonce: randomBytes(32).toString("base64url"), csrfHash: sha256(csrf),
    expiresAt: now + 600, googleVerified: false,
  };
  store.createTransaction(transaction);
  setCookie(response, "door_consent_csrf", csrf, 600);
  response.writeHead(302, { Location: google.authorizationUrl(transaction.googleState, transaction.googleNonce) }); response.end();
}

async function handleGoogleCallback(url: URL, response: ServerResponse, config: GatewayConfig, store: GatewayStore, google: GoogleIdentityProvider, now: number): Promise<void> {
  const state = url.searchParams.get("state") ?? "";
  const transaction = store.transactionByGoogleState(state);
  if (!transaction || transaction.expiresAt <= now) return sendHtml(response, 400, renderMessage("認証を続けられません", "認証手続きの期限が切れました。AIクライアントから接続をやり直してください。"));
  if (url.searchParams.has("error")) { store.deleteTransaction(transaction.id); return redirectOAuthError(response, transaction, "access_denied"); }
  const code = url.searchParams.get("code") ?? "";
  if (!safeOpaque(code, 8, 2_048)) return redirectOAuthError(response, transaction, "access_denied");
  try {
    const identity = await google.exchangeCode(code, transaction.googleNonce);
    if (identity.sub !== config.allowedGoogleSub) { store.deleteTransaction(transaction.id); return sendHtml(response, 403, renderMessage("許可されていないアカウントです", "この玄関を使えるGoogleアカウントではありません。")); }
    google.acceptIdentity(identity);
    store.markGoogleVerified(transaction.id);
    store.setMasterSwitch("alive", now);
    response.writeHead(302, { Location: `${config.publicOrigin}/oauth/consent?transaction=${encodeURIComponent(transaction.id)}` }); response.end();
  } catch {
    store.setMasterSwitch("unknown", now);
    return sendHtml(response, 502, renderMessage("Google認証を確認できません", "鍵は発行していません。時間を置いて接続をやり直してください。"));
  }
}

function handleConsentPage(url: URL, response: ServerResponse, store: GatewayStore, now: number): void {
  const transaction = store.transactionById(url.searchParams.get("transaction") ?? "");
  if (!transaction?.googleVerified || transaction.expiresAt <= now) return sendHtml(response, 400, renderMessage("同意画面を開けません", "認証手続きをやり直してください。"));
  const client = store.getClient(transaction.clientId);
  const approvedRedirectUris = client ? approvedClientRedirectUris(store, client) : undefined;
  if (!client || !approvedRedirectUris?.includes(transaction.redirectUri)) return sendHtml(response, 400, renderMessage("クライアントを確認できません", "接続をやり直してください。"));
  setConsentSecurityHeaders(response, approvedRedirectUris);
  return sendHtml(response, 200, renderConsent(client, transaction.id));
}

async function handleConsentDecision(
  request: IncomingMessage,
  response: ServerResponse,
  config: GatewayConfig,
  store: GatewayStore,
  completedConsents: Map<string, CompletedConsent>,
  now: number,
): Promise<void> {
  const source = classifyBrowserPost(request, config.publicOrigin);
  console.log(JSON.stringify({
    at: new Date().toISOString(),
    event: "oauth_consent_source_check",
    outcome: source.accepted ? "accepted" : "rejected",
    origin_shape: source.originShape,
    referer_shape: source.refererShape,
    fetch_site: source.fetchSite,
    fetch_mode: source.fetchMode,
    fetch_dest: source.fetchDest,
  }));
  if (!source.accepted) return sendHtml(response, 403, renderMessage("送信元を確認できません", "鍵は発行していません。"));
  const form = objectFromForm(await readBody(request, "form"));
  const transactionId = form.transaction ?? "";
  const transaction = store.transactionById(transactionId);
  const client = transaction ? store.getClient(transaction.clientId) : undefined;
  const approvedRedirectUris = client ? approvedClientRedirectUris(store, client) : undefined;
  const csrf = cookie(request, "door_consent_csrf") ?? "";
  const csrfHash = sha256(csrf);
  if (!transaction?.googleVerified || transaction.expiresAt <= now || !client || !approvedRedirectUris?.includes(transaction.redirectUri)
    || !safeEqual(csrfHash, transaction.csrfHash)) {
    const completed = completedConsents.get(transactionId);
    const completedCookieMatches = Boolean(completed && safeEqual(csrfHash, completed.csrfHash));
    if (form.decision === "allow" && completed && completed.expiresAt > now && completedCookieMatches) {
      console.log(JSON.stringify({ at: new Date().toISOString(), event: "oauth_consent_decision", outcome: "duplicate-replayed", cookie_shape: csrf ? "present-match" : "absent" }));
      setConsentSecurityHeaders(response, completed.formActionRedirectUris);
      return redirectCompletedConsent(response, completed.location);
    }
    console.log(JSON.stringify({
      at: new Date().toISOString(),
      event: "oauth_consent_decision",
      outcome: "rejected-invalid-context",
      transaction_shape: transaction ? transaction.expiresAt <= now ? "expired" : "present-invalid" : "absent",
      completed_shape: completed ? completed.expiresAt <= now ? "expired" : "present" : "absent",
      cookie_shape: !csrf ? "absent" : completedCookieMatches ? "present-match" : "present-mismatch",
    }));
    return sendHtml(response, 403, renderMessage("同意を確認できません", "認証手続きをやり直してください。"));
  }
  if (form.decision !== "allow") { store.deleteTransaction(transaction.id); return redirectOAuthError(response, transaction, "access_denied"); }
  const code = randomBytes(32).toString("base64url");
  store.createAuthorizationCode(sha256(code), transaction, now + config.authorizationCodeTtlSeconds, now);
  const callback = new URL(transaction.redirectUri);
  callback.searchParams.set("code", code); callback.searchParams.set("state", transaction.clientState);
  completedConsents.set(transaction.id, {
    csrfHash: transaction.csrfHash,
    location: callback.href,
    formActionRedirectUris: [...approvedRedirectUris],
    expiresAt: Math.min(transaction.expiresAt, now + 30),
  });
  console.log(JSON.stringify({ at: new Date().toISOString(), event: "oauth_consent_decision", outcome: "authorized", cookie_shape: "present-match" }));
  setConsentSecurityHeaders(response, approvedRedirectUris);
  return redirectCompletedConsent(response, callback.href);
}

function redirectCompletedConsent(response: ServerResponse, location: string): void {
  response.writeHead(302, { Location: location }); response.end();
}

async function handleToken(request: IncomingMessage, response: ServerResponse, config: GatewayConfig, store: GatewayStore, google: GoogleIdentityProvider, now: number): Promise<void> {
  if (!isForm(request)) return oauthError(response, 415, "invalid_request", "Content-Type must be application/x-www-form-urlencoded");
  const form = objectFromForm(await readBody(request, "form"));
  const grantType = form.grant_type;
  if (grantType === "authorization_code") {
    const code = form.code ?? ""; const clientId = form.client_id ?? ""; const redirectUri = form.redirect_uri ?? ""; const verifier = form.code_verifier ?? "";
    if (!safeOpaque(code, 32, 256) || !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) return oauthError(response, 400, "invalid_grant", "authorization code or PKCE verifier is invalid");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const authorized = store.consumeAuthorizationCode(sha256(code), clientId, redirectUri, challenge, now);
    if (!authorized) return oauthError(response, 400, "invalid_grant", "authorization code is invalid or expired");
    const pair = newTokenPair(config, clientId, authorized.scope, authorized.resource, now);
    store.issueTokenPair({ ...pair.store, familyId: randomUUID(), now });
    return sendJson(response, 200, pair.response);
  }
  if (grantType === "refresh_token") {
    const rawRefresh = form.refresh_token ?? ""; const clientId = form.client_id ?? "";
    if (!safeOpaque(rawRefresh, 32, 256)) return oauthError(response, 400, "invalid_grant", "refresh token is invalid");
    const oldHash = sha256(rawRefresh); const current = store.refreshToken(oldHash);
    if (!current || current.clientId !== clientId || current.expiresAt <= now || current.status === "revoked") return oauthError(response, 400, "invalid_grant", "refresh token is invalid or expired");
    if (current.status === "used") { store.revokeClient(clientId, now); return oauthError(response, 400, "invalid_grant", "refresh token reuse detected; client access revoked"); }
    const master = await google.checkMasterSwitch(); store.setMasterSwitch(master, now);
    if (master !== "alive") {
      if (master === "revoked") store.revokeAll(now);
      return oauthError(response, 400, "invalid_grant", master === "revoked" ? "Google authorization was revoked" : "Google authorization could not be verified");
    }
    const pair = newTokenPair(config, clientId, current.scope, current.resource || `${config.publicOrigin}/mcp`, now);
    const rotated = store.rotateRefreshToken({ ...pair.store, oldHash, clientId, familyId: current.familyId, now });
    if (rotated === "reused") return oauthError(response, 400, "invalid_grant", "refresh token reuse detected; client access revoked");
    if (rotated !== "rotated") return oauthError(response, 400, "invalid_grant", "refresh token is invalid or expired");
    return sendJson(response, 200, pair.response);
  }
  return oauthError(response, 400, "unsupported_grant_type", "only authorization_code and refresh_token are supported");
}

function newTokenPair(config: GatewayConfig, clientId: string, scope: string, resource: string, now: number) {
  const accessToken = randomBytes(32).toString("base64url"); const refreshToken = randomBytes(32).toString("base64url");
  const accessExpiresAt = now + config.accessTokenTtlSeconds; const refreshExpiresAt = now + config.refreshTokenTtlSeconds;
  return {
    store: { accessHash: sha256(accessToken), refreshHash: sha256(refreshToken), clientId, scope, resource, accessExpiresAt, refreshExpiresAt },
    response: { access_token: accessToken, token_type: "Bearer", expires_in: config.accessTokenTtlSeconds, refresh_token: refreshToken, scope, resource },
  };
}

async function fetchClientMetadata(
  clientId: string,
  fetchImpl: typeof fetch,
): Promise<DoorClientRegistration | undefined> {
  let url: URL;
  try { url = new URL(clientId); } catch { return undefined; }
  if (!safeClientMetadataUrl(url)) return undefined;
  let response: Response;
  try { response = await fetchImpl(url, { redirect: "error", signal: AbortSignal.timeout(8_000), headers: { Accept: "application/json" } }); } catch { return undefined; }
  if (!response.ok || !(response.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json") || Number(response.headers.get("content-length") ?? "0") > MAX_BODY_BYTES) return undefined;
  const text = await response.text().catch(() => "");
  if (Buffer.byteLength(text) > MAX_BODY_BYTES) return undefined;
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return undefined; }
  const metadata = object(parsed);
  const redirectUris = metadata && Array.isArray(metadata.redirect_uris) ? metadata.redirect_uris : [];
  const clientName = validateClientName(metadata?.client_name);
  if (!metadata || metadata.client_id !== clientId || !clientName || redirectUris.length !== 1 || typeof redirectUris[0] !== "string") return undefined;
  const redirectUri = validateRedirectUri(redirectUris[0]); if (!redirectUri) return undefined;
  return { clientId, clientName, redirectUris: [redirectUri], kind: "cimd" };
}

function authorizationMetadata(config: GatewayConfig) {
  return {
    issuer: config.publicOrigin,
    authorization_endpoint: `${config.publicOrigin}/oauth/authorize`,
    token_endpoint: `${config.publicOrigin}/oauth/token`,
    registration_endpoint: `${config.publicOrigin}/oauth/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: [READ_SCOPE, ACTION_SCOPE],
    client_id_metadata_document_supported: true,
  };
}

class RateLimiter {
  readonly buckets = new Map<string, { startedAt: number; count: number }>();
  readonly now: () => number;
  constructor(now: () => number) { this.now = now; }
  allow(key: string, limit: number, windowSeconds: number): boolean {
    const timestamp = this.now(); const current = this.buckets.get(key);
    if (!current || timestamp - current.startedAt >= windowSeconds) { this.buckets.set(key, { startedAt: timestamp, count: 1 }); return true; }
    current.count += 1; return current.count <= limit;
  }
}

async function readBody(request: IncomingMessage, kind: "json" | "form"): Promise<unknown> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of request) { const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); size += buffer.length; if (size > MAX_BODY_BYTES) throw new SyntaxError("request body is too large"); chunks.push(buffer); }
  const text = Buffer.concat(chunks).toString("utf8");
  if (kind === "json") { try { return JSON.parse(text); } catch { throw new SyntaxError("request body must be JSON"); } }
  return new URLSearchParams(text);
}

function object(value: unknown): Record<string, unknown> | undefined { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined; }
function objectFromForm(value: unknown): Record<string, string> { const form = value as URLSearchParams; return Object.fromEntries(form.entries()); }
function isJson(request: IncomingMessage): boolean { return (request.headers["content-type"] ?? "").toLowerCase().startsWith("application/json"); }
function isForm(request: IncomingMessage): boolean { return (request.headers["content-type"] ?? "").toLowerCase().startsWith("application/x-www-form-urlencoded"); }
function normalizeScope(value: string): string { return [...new Set(value.split(/\s+/).filter(Boolean))].sort().join(" "); }
type AuthorizationScopeResolution = {
  accepted: boolean;
  shape: "absent" | "read-only" | "read-act" | "other";
  resolution: "defaulted-to-consent" | "upgraded-by-consent" | "exact" | "rejected";
};
function resolveAuthorizationScope(value: string | null): AuthorizationScopeResolution {
  const normalized = normalizeScope(value ?? "");
  if (!normalized) return { accepted: true, shape: "absent", resolution: "defaulted-to-consent" };
  if (normalized === READ_SCOPE) return { accepted: true, shape: "read-only", resolution: "upgraded-by-consent" };
  if (normalized === PHASE_THREE_SCOPE) return { accepted: true, shape: "read-act", resolution: "exact" };
  return { accepted: false, shape: "other", resolution: "rejected" };
}
function logAuthorizeRequest(
  outcome: "accepted" | "rejected",
  reason: string,
  clientKind: "dcr" | "cimd" | "other",
  clientStatus: DoorClient["status"] | "absent",
  scope: AuthorizationScopeResolution,
): void {
  console.log(JSON.stringify({
    at: new Date().toISOString(), event: "oauth_authorize_request", outcome, rejection_reason: reason,
    client_kind: clientKind, client_status: clientStatus, scope_shape: scope.shape, scope_resolution: scope.resolution,
  }));
}

function logRegistrationRejection(
  logger: RegistrationRejectionLogger,
  rejectionReason: RegistrationRejectionLog["rejection_reason"],
  body: Record<string, unknown> | undefined,
  now: number,
): void {
  try {
    logger({
      at: new Date(now * 1_000).toISOString(),
      event: "oauth_client_registration_rejected",
      rejection_reason: rejectionReason,
      client_name_shape: classifyClientName(body?.client_name),
      redirect_uris: classifyRedirectUris(body),
      grant_types: classifyGrantTypes(body),
      token_endpoint_auth_method_shape: classifyTokenAuthMethod(body?.token_endpoint_auth_method),
    });
  } catch { console.error("remote MCP registration rejection log failed"); }
}

function classifyClientName(value: unknown): RegistrationRejectionLog["client_name_shape"] {
  if (value === undefined) return "absent";
  if (typeof value !== "string") return "non-string";
  if (value.length === 0) return "empty";
  if (value.length > 128) return "too-long";
  if (/[\u0000-\u001f\u007f]/.test(value)) return "control-character";
  return "valid-string";
}

function classifyRedirectUris(body: Record<string, unknown> | undefined): RegistrationRejectionLog["redirect_uris"] {
  if (!body || body.redirect_uris === undefined) return { container: "absent", count: null, items: [], truncated: false };
  if (!Array.isArray(body.redirect_uris)) return { container: "other", count: null, items: [], truncated: false };
  const limit = 10;
  return {
    container: "array",
    count: body.redirect_uris.length,
    items: body.redirect_uris.slice(0, limit).map(classifyRedirectUri),
    truncated: body.redirect_uris.length > limit,
  };
}

function classifyRedirectUri(value: unknown): RegistrationRejectionLog["redirect_uris"]["items"][number] {
  if (typeof value !== "string") return { value_shape: "non-string" };
  let url: URL;
  try { url = new URL(value); }
  catch { return { value_shape: "string", scheme: "invalid", host_kind: "invalid", port: "unknown" }; }
  const scheme = url.protocol === "https:" ? "https" : url.protocol === "http:" ? "http" : "other";
  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  const ipCandidate = hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
  const hostKind = ipCandidate === "127.0.0.1" ? "loopback-v4"
    : ipCandidate === "::1" ? "loopback-v6"
      : hostname === "localhost" ? "localhost"
        : !hostname ? "absent"
          : isIP(ipCandidate) ? "ip"
            : "domain";
  return {
    value_shape: "string",
    scheme,
    host_kind: hostKind,
    ...(scheme === "https" && hostKind === "domain" ? { host: hostname } : {}),
    port: url.port ? "present" : "absent",
  };
}

function classifyGrantTypes(body: Record<string, unknown> | undefined): RegistrationRejectionLog["grant_types"] {
  if (!body || body.grant_types === undefined) return { container: "absent", count: null, values: [], truncated: false };
  if (!Array.isArray(body.grant_types)) return { container: "other", count: null, values: [], truncated: false };
  const limit = 10;
  return {
    container: "array",
    count: body.grant_types.length,
    values: body.grant_types.slice(0, limit).map(classifyGrantType),
    truncated: body.grant_types.length > limit,
  };
}

function classifyGrantType(value: unknown): RegistrationRejectionLog["grant_types"]["values"][number] {
  if (typeof value !== "string") return "non-string";
  if (value === "authorization_code" || value === "refresh_token" || value === "client_credentials" || value === "implicit") return value;
  if (value === "urn:ietf:params:oauth:grant-type:device_code") return "device_code";
  if (value === "urn:ietf:params:oauth:grant-type:jwt-bearer") return "jwt_bearer";
  return "other-string";
}

function classifyTokenAuthMethod(value: unknown): RegistrationRejectionLog["token_endpoint_auth_method_shape"] {
  if (value === undefined) return "absent";
  if (typeof value !== "string") return "non-string";
  if (value === "none" || value === "client_secret_basic" || value === "client_secret_post" || value === "client_secret_jwt" || value === "private_key_jwt") return value;
  return "other-string";
}

type RegistrationCandidate = Pick<DoorClient, "clientId" | "clientName" | "kind"> & Partial<Pick<DoorClient, "redirectUri" | "redirectHost" | "redirectUris" | "redirectHosts">>;
function registrationAudit(client: RegistrationCandidate, decision: "pending" | "approved" | "rejected" | "expired", now: number) {
  const redirectUris = client.redirectUris ?? (client.redirectUri ? [client.redirectUri] : []);
  const redirectHosts = [...new Set(client.redirectHosts ?? redirectUris.map((redirectUri) => new URL(redirectUri).hostname))];
  return {
    timestamp: new Date(now * 1_000).toISOString(),
    event: "client_registration" as const,
    decision,
    client_ref: sha256(client.clientId).slice(0, 16),
    client_name_claimed: client.clientName,
    client_kind: client.kind,
    redirect_host: redirectHosts[0] ?? client.redirectHost ?? "unknown",
    redirect_hosts: redirectHosts,
    redirect_uri_count: redirectUris.length,
  };
}
function cleanupExpiredRegistrations(store: GatewayStore, audit: GatewayAuditWriter, now: number, pendingTtlSeconds: number): void {
  for (const client of store.cleanup(now, pendingTtlSeconds)) {
    try {
      const result = audit.append(registrationAudit(client, "expired", now));
      if (result instanceof Promise) void result.catch(() => console.error("remote MCP registration expiry audit failed"));
    } catch { console.error("remote MCP registration expiry audit failed"); }
  }
}
function approvedClientRedirectUris(store: GatewayStore, client: DoorClient): string[] | undefined {
  if (client.approvalStatus !== "approved") return undefined;
  const approved = client.redirectUris.filter((redirectUri) => store.isRedirectApproved(redirectUri));
  return approved.length === client.redirectUris.length ? approved : undefined;
}
function validateRedirectUri(value: string): string | undefined {
  try {
    const url = new URL(value);
    return url.href === value && url.protocol === "https:" && !url.username && !url.password && !url.hash && !value.includes("*") && value.length <= 2_048 ? value : undefined;
  } catch { return undefined; }
}
function validateClientName(value: unknown): string | undefined {
  return typeof value === "string" && value.length >= 1 && value.length <= 128 && !/[\u0000-\u001f\u007f]/.test(value) ? value : undefined;
}
function safeClientMetadataUrl(url: URL): boolean {
  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  const ipCandidate = hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
  return url.protocol === "https:" && !url.username && !url.password && !url.hash && Boolean(url.pathname && url.pathname !== "/")
    && (!url.port || url.port === "443") && isIP(ipCandidate) === 0 && hostname !== "localhost"
    && ![".localhost", ".local", ".internal", ".home.arpa"].some((suffix) => hostname.endsWith(suffix));
}
function safeOpaque(value: string, min: number, max: number): boolean { return value.length >= min && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value); }
function safeEqual(a: string, b: string): boolean { const left = Buffer.from(a); const right = Buffer.from(b); return left.length === right.length && timingSafeEqual(left, right); }
function remoteAddress(request: IncomingMessage): string { return request.socket.remoteAddress ?? "unknown"; }
function cookie(request: IncomingMessage, name: string): string | undefined { for (const item of (request.headers.cookie ?? "").split(";")) { const [key, ...rest] = item.trim().split("="); if (key === name) return rest.join("="); } }
type BrowserPostSource = {
  accepted: boolean;
  originShape: "exact" | "opaque" | "absent" | "other";
  refererShape: "exact-consent" | "same-origin-other-path" | "absent" | "invalid" | "other-origin";
  fetchSite: "same-origin" | "same-site" | "cross-site" | "none" | "absent" | "other";
  fetchMode: "navigate" | "cors" | "no-cors" | "same-origin" | "absent" | "other";
  fetchDest: "document" | "empty" | "absent" | "other";
};

function classifyBrowserPost(request: IncomingMessage, publicOrigin: string): BrowserPostSource {
  const origin = request.headers.origin;
  const originShape = origin === publicOrigin ? "exact" : origin === "null" ? "opaque" : origin === undefined ? "absent" : "other";
  const refererShape = classifyConsentReferer(request.headers.referer, publicOrigin);
  const fetchSite = classifyHeader(request.headers["sec-fetch-site"], ["same-origin", "same-site", "cross-site", "none"] as const);
  const fetchMode = classifyHeader(request.headers["sec-fetch-mode"], ["navigate", "cors", "no-cors", "same-origin"] as const);
  const fetchDest = classifyHeader(request.headers["sec-fetch-dest"], ["document", "empty"] as const);
  const exactOrigin = originShape === "exact";
  const exactRefererFallback = (originShape === "opaque" || originShape === "absent") && refererShape === "exact-consent";
  const sameOriginNavigationFallback = (originShape === "opaque" || originShape === "absent")
    && fetchSite === "same-origin" && fetchMode === "navigate" && fetchDest === "document";
  return { accepted: exactOrigin || exactRefererFallback || sameOriginNavigationFallback, originShape, refererShape, fetchSite, fetchMode, fetchDest };
}

function classifyConsentReferer(value: string | undefined, publicOrigin: string): BrowserPostSource["refererShape"] {
  if (value === undefined) return "absent";
  try {
    const referer = new URL(value);
    if (referer.origin !== publicOrigin) return "other-origin";
    return referer.pathname === "/oauth/consent" ? "exact-consent" : "same-origin-other-path";
  } catch { return "invalid"; }
}

function classifyHeader<const Values extends readonly string[]>(value: string | undefined, allowed: Values): Values[number] | "absent" | "other" {
  if (value === undefined) return "absent";
  return allowed.includes(value) ? value as Values[number] : "other";
}
function setCookie(response: ServerResponse, name: string, value: string, maxAge: number): void { response.setHeader("Set-Cookie", `${name}=${value}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAge}`); }

function redirectOAuthError(response: ServerResponse, transaction: OAuthTransaction, error: string): void { const url = new URL(transaction.redirectUri); url.searchParams.set("error", error); url.searchParams.set("state", transaction.clientState); response.writeHead(302, { Location: url.href }); response.end(); }
function methodNotAllowed(response: ServerResponse, allow: string): void { response.setHeader("Allow", allow); sendJson(response, 405, { error: "method_not_allowed" }); }
function oauthError(response: ServerResponse, status: number, error: string, description: string): void { sendJson(response, status, { error, error_description: description }); }
function sendJson(response: ServerResponse, status: number, value: unknown): void { response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" }); response.end(JSON.stringify(value)); }
function sendHtml(response: ServerResponse, status: number, html: string): void { response.writeHead(status, { "Content-Type": "text/html; charset=utf-8" }); response.end(html); }
async function sendWebResponse(response: ServerResponse, value: Response): Promise<void> { const headers: Record<string, string> = {}; value.headers.forEach((item, key) => { headers[key] = item; }); response.writeHead(value.status, headers); response.end(Buffer.from(await value.arrayBuffer())); }
function setSecurityHeaders(response: ServerResponse): void { response.setHeader("Cache-Control", "no-store"); response.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'"); response.setHeader("Referrer-Policy", "no-referrer"); response.setHeader("X-Content-Type-Options", "nosniff"); response.setHeader("X-Frame-Options", "DENY"); }
function setConsentSecurityHeaders(response: ServerResponse, redirectUris: string[]): void {
  const origins = [...new Set(redirectUris.map((redirectUri) => new URL(redirectUri).origin))];
  response.setHeader("Content-Security-Policy", `default-src 'none'; style-src 'unsafe-inline'; form-action 'self' ${origins.join(" ")}; frame-ancestors 'none'; base-uri 'none'`);
}
function escapeHtml(value: string): string { return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" })[character]!); }
function renderMessage(title: string, detail: string): string { return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>${PAGE_STYLE}</style></head><body><main><h1>${escapeHtml(title)}</h1><p>${escapeHtml(detail)}</p></main></body></html>`; }
function renderConsent(client: DoorClient, transactionId: string): string {
  const hosts = [...new Set(client.redirectHosts)];
  const hostList = `<ul>${hosts.map((host) => `<li>${escapeHtml(host)}</li>`).join("")}</ul>`;
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>AI接続の確認</title><style>${PAGE_STYLE}</style></head><body><main><h1>AI接続の確認</h1><dl><dt>AI（自称）</dt><dd>${escapeHtml(client.clientName)}</dd><dt>承認済みの戻り先ドメイン（${hosts.length}件）</dt><dd>${hostList}</dd><dt>許可範囲</dt><dd>読み取り＋家電操作（共通Catalogの許可済み操作）</dd></dl><form method="post" action="/oauth/consent"><input type="hidden" name="transaction" value="${escapeHtml(transactionId)}"><button name="decision" value="allow" type="submit">読み取り＋家電操作を許可する</button><button name="decision" value="deny" type="submit" class="secondary">拒否する</button></form><p>家電操作時の最終承認はAIクライアント側で確認します。玄関は追加確認を挟みません。</p></main></body></html>`;
}
const PAGE_STYLE = ":root{font-family:system-ui,sans-serif;color-scheme:light}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f4f1ea;color:#17202a}main{width:min(34rem,calc(100% - 2rem));box-sizing:border-box;background:white;padding:2rem;border-radius:1rem;box-shadow:0 .5rem 2rem #0002}dt{font-weight:700;margin-top:1rem}dd{margin:.25rem 0}button{width:100%;margin-top:1rem;padding:1rem;border:0;border-radius:.7rem;background:#243447;color:white;font-size:1rem;font-weight:700}.secondary{background:#707780}";
function safeClientSummary(client: DoorClient) { return { client_id: client.clientId, client_name_claimed: client.clientName, redirect_host: client.redirectHost, redirect_hosts: [...new Set(client.redirectHosts)], redirect_uri_count: client.redirectUris.length, kind: client.kind, status: client.status, approval_status: client.approvalStatus, last_used_at: client.lastUsedAt ? new Date(client.lastUsedAt * 1_000).toISOString() : null, refresh_expires_at: client.refreshExpiresAt ? new Date(client.refreshExpiresAt * 1_000).toISOString() : null }; }

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === invokedPath) {
  const port = Number(process.env.REMOTE_MCP_PORT ?? "8794");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("REMOTE_MCP_PORT must be a valid port");
  const server = createRemoteMcpGateway();
  server.listen(port, "127.0.0.1", () => console.log(`Remote MCP common gateway listening on localhost:${port}`));
}
