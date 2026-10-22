import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { MemoryGatewayAudit } from "../src/audit.ts";
import type { GatewayConfig } from "../src/config.ts";
import { GatewayCoreError, type GatewayCore } from "../src/core-client.ts";
import type { GoogleIdentityProvider, MasterSwitchResult } from "../src/google.ts";
import { createRemoteMcpGateway, type GatewayServer, type RegistrationRejectionLog } from "../src/server.ts";
import { GatewayStore } from "../src/store.ts";
import { createOffEntryServer } from "../../src/off-entry.ts";

const PUBLIC_ORIGIN = "https://door.example.invalid";
const CALLBACK = "https://claude.ai/api/mcp/auth_callback";

class FakeGoogle implements GoogleIdentityProvider {
  master: MasterSwitchResult = "alive";
  sub = "allowed-google-sub";
  accepted = 0;
  authorizationUrl(state: string, nonce: string): string { return `https://accounts.example.invalid/authorize?state=${state}&nonce=${nonce}`; }
  async exchangeCode(): Promise<{ sub: string }> { return { sub: this.sub }; }
  acceptIdentity(): void { this.accepted += 1; }
  async checkMasterSwitch(): Promise<MasterSwitchResult> { return this.master; }
}

class FakeCore implements GatewayCore {
  reads = 0;
  actions: Array<{ actionId: string; parameters: Record<string, unknown>; idempotencyKey: string }> = [];
  failAction: "failed" | "unknown" | null = null;
  temporaryRecording = false;
  async getCapabilities() { this.reads += 1; return { devices: [{ id: "test.device" }] }; }
  async getState() { this.reads += 1; return { devices: [{ device_id: "light.living_room", fields: { power: { status: "observed", value: "off", observed_at: "2026-10-12T00:00:00Z", source: "test" } } }] }; }
  async executeAction(actionId: string, parameters: Record<string, unknown>, idempotencyKey: string) {
    this.actions.push({ actionId, parameters: structuredClone(parameters), idempotencyKey });
    const recording = this.temporaryRecording ? { status: "temporary", persistent: false, must_tell_user: true, message: "temporary recording" } : undefined;
    if (this.failAction) throw new GatewayCoreError(this.failAction, this.failAction === "unknown" ? "simulated unknown" : "simulated failure", recording);
    return { status: "succeeded", action_id: actionId, ...(recording ? { recording } : {}) };
  }
}

type Fixture = { server: GatewayServer; origin: string; store: GatewayStore; audit: MemoryGatewayAudit; google: FakeGoogle; core: FakeCore; cleanup: () => Promise<void> };

function rawRequest(origin: string, path: string, options: { method?: string; headers?: Record<string, string>; body?: string } = {}) {
  const target = new URL(path, origin);
  return new Promise<{ status: number; headers: IncomingHttpHeaders; body: string }>((resolve, reject) => {
    const request = httpRequest({
      hostname: target.hostname,
      port: target.port,
      path: `${target.pathname}${target.search}`,
      method: options.method ?? "GET",
      headers: options.headers,
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      response.on("end", () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks).toString("utf8") }));
    });
    request.on("error", reject);
    request.end(options.body);
  });
}

async function fixture(
  audit = new MemoryGatewayAudit(),
  overrides: Partial<GatewayConfig> = {},
  now?: () => number,
  cleanupIntervalMs?: number,
  fetchImpl?: typeof fetch,
  registrationRejectionLogger: (entry: RegistrationRejectionLog) => void = () => {},
): Promise<Fixture> {
  const directory = mkdtempSync(join(tmpdir(), "aipl-door-test-"));
  const config: GatewayConfig = {
    publicOrigin: PUBLIC_ORIGIN,
    allowedGoogleSub: "allowed-google-sub",
    googleClientId: "google-client-id-for-tests",
    bootstrapApprovedRedirectUris: [CALLBACK],
    accessTokenTtlSeconds: 3_600,
    refreshTokenTtlSeconds: 2_592_000,
    authorizationCodeTtlSeconds: 300,
    pendingClientTtlSeconds: 3_600,
    maxClients: 10,
    maxPendingClients: 10,
    registrationRateLimitPerHour: 20,
    oauthRateLimitPerMinute: 60,
    keychainService: "test-service",
    googleClientSecretAccount: "test-secret",
    googleRefreshTokenAccount: "test-refresh",
    databaseFile: join(directory, "gateway.sqlite"),
    auditLogFile: join(directory, "audit.jsonl"),
    coreTokenFile: join(directory, "core.key"),
    ...overrides,
  };
  const store = new GatewayStore(config.databaseFile); const google = new FakeGoogle(); const core = new FakeCore();
  const server = createRemoteMcpGateway({ config, store, audit, google, core, registrationRejectionLogger, ...(now ? { now } : {}), ...(cleanupIntervalMs ? { cleanupIntervalMs } : {}), ...(fetchImpl ? { fetchImpl } : {}) });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { server, origin, store, audit, google, core, cleanup: async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    store.close(); rmSync(directory, { recursive: true, force: true });
  } };
}

async function register(origin: string, redirectUri = CALLBACK) {
  return registerUris(origin, [redirectUri]);
}

async function registerUris(origin: string, redirectUris: string[], clientName = "Claude") {
  return fetch(`${origin}/oauth/register`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
    client_name: clientName, redirect_uris: redirectUris, grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none",
  }) });
}

async function authorize(f: Fixture, verifier = randomBytes(48).toString("base64url"), scope: string | null = "mcp:read mcp:act") {
  const pending = await beginAuthorization(f, verifier, scope);
  const decision = await fetch(`${f.origin}/oauth/consent`, {
    method: "POST", redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: PUBLIC_ORIGIN, Cookie: pending.csrfCookie },
    body: new URLSearchParams({ transaction: pending.transaction, decision: "allow" }),
  });
  assert.equal(decision.status, 302);
  const clientCallback = new URL(decision.headers.get("location")!);
  return { clientId: pending.clientId, code: clientCallback.searchParams.get("code")!, verifier };
}

async function beginAuthorization(f: Fixture, verifier = randomBytes(48).toString("base64url"), scope: string | null = "mcp:read mcp:act") {
  const registration = await register(f.origin); assert.equal(registration.status, 201);
  const client = await registration.json(); const challenge = createHash("sha256").update(verifier).digest("base64url");
  const authorizeUrl = new URL(`${f.origin}/oauth/authorize`);
  const authorizeParameters = new URLSearchParams({ response_type: "code", client_id: client.client_id, redirect_uri: CALLBACK, resource: `${PUBLIC_ORIGIN}/mcp`, state: "claude-state", code_challenge: challenge, code_challenge_method: "S256" });
  if (scope !== null) authorizeParameters.set("scope", scope);
  authorizeUrl.search = authorizeParameters.toString();
  const started = await fetch(authorizeUrl, { redirect: "manual" }); assert.equal(started.status, 302);
  const csrfCookie = started.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
  const googleLocation = new URL(started.headers.get("location")!);
  const callback = await fetch(`${f.origin}/oauth/google/callback?code=google-code&state=${encodeURIComponent(googleLocation.searchParams.get("state")!)}`, { redirect: "manual" });
  assert.equal(callback.status, 302);
  const consentLocation = new URL(callback.headers.get("location")!);
  const transaction = consentLocation.searchParams.get("transaction")!;
  return { clientId: client.client_id as string, transaction, consentLocation, csrfCookie, setCookie: started.headers.get("set-cookie") ?? "" };
}

async function exchange(origin: string, authorization: Awaited<ReturnType<typeof authorize>>, verifier = authorization.verifier) {
  return fetch(`${origin}/oauth/token`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({
    grant_type: "authorization_code", client_id: authorization.clientId, redirect_uri: CALLBACK, code: authorization.code, code_verifier: verifier,
  }) });
}

async function rpcBody(response: Response): Promise<any> {
  const text = await response.text();
  if (!(response.headers.get("content-type") ?? "").includes("text/event-stream")) return JSON.parse(text);
  const data = text.split(/\r?\n/).find((line) => line.startsWith("data: "))?.slice(6);
  if (!data) throw new Error("MCP SSE response did not contain a data event");
  return JSON.parse(data);
}

test("publishes MCP OAuth metadata and rejects an unauthenticated MCP request", async () => {
  const f = await fixture(); try {
    const protectedMetadata = await (await fetch(`${f.origin}/.well-known/oauth-protected-resource/mcp`)).json();
    const authorizationMetadata = await (await fetch(`${f.origin}/.well-known/oauth-authorization-server`)).json();
    assert.deepEqual(protectedMetadata.authorization_servers, [PUBLIC_ORIGIN]);
    assert.equal(protectedMetadata.resource, `${PUBLIC_ORIGIN}/mcp`);
    assert.deepEqual(protectedMetadata.scopes_supported, ["mcp:read", "mcp:act"]);
    assert.deepEqual(authorizationMetadata.scopes_supported, ["mcp:read", "mcp:act"]);
    assert.equal(authorizationMetadata.client_id_metadata_document_supported, true);
    assert.deepEqual(authorizationMetadata.code_challenge_methods_supported, ["S256"]);
    const rejected = await fetch(`${f.origin}/mcp`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }) });
    assert.equal(rejected.status, 401);
    assert.match(rejected.headers.get("www-authenticate") ?? "", /oauth-protected-resource\/mcp/);
  } finally { await f.cleanup(); }
});

test("an unknown DCR callback stays pending until owner approval and exact-URI approval survives a client retry", async () => {
  const grokCallback = "https://accounts.grok.example/oauth/callback";
  const f = await fixture(); try {
    const registration = await register(f.origin, grokCallback); assert.equal(registration.status, 201);
    const client = await registration.json();
    assert.equal(f.store.getClient(client.client_id)?.approvalStatus, "pending");
    const verifier = randomBytes(48).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const authorizeUrl = new URL(`${f.origin}/oauth/authorize`);
    authorizeUrl.search = new URLSearchParams({
      response_type: "code", client_id: client.client_id, redirect_uri: grokCallback, scope: "mcp:read",
      resource: `${PUBLIC_ORIGIN}/mcp`, state: "grok-pending", code_challenge: challenge, code_challenge_method: "S256",
    }).toString();
    const pending = await fetch(authorizeUrl, { redirect: "manual" });
    assert.equal(pending.status, 403);
    assert.equal((await pending.json()).error, "authorization_pending");
    assert.equal(f.store.db.prepare("SELECT COUNT(*) AS count FROM oauth_transactions").get().count, 0);
    assert.equal(f.store.db.prepare("SELECT COUNT(*) AS count FROM authorization_codes").get().count, 0);
    assert.equal(f.store.db.prepare("SELECT COUNT(*) AS count FROM access_tokens").get().count, 0);
    assert.equal(f.store.db.prepare("SELECT COUNT(*) AS count FROM refresh_tokens").get().count, 0);
    const pendingAudit = f.audit.entries.find((item) => "decision" in item && item.decision === "pending");
    assert.ok(pendingAudit);
    assert.equal(Object.prototype.hasOwnProperty.call(pendingAudit, "client_id"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(pendingAudit, "redirect_uri"), false);

    assert.ok(f.store.approveClient(client.client_id, 200));
    assert.equal((await fetch(authorizeUrl, { redirect: "manual" })).status, 302);
    const retriedRegistration = await register(f.origin, grokCallback); const retriedClient = await retriedRegistration.json();
    assert.equal(f.store.getClient(retriedClient.client_id)?.approvalStatus, "approved");
    const variant = await register(f.origin, `${grokCallback}/`); const variantClient = await variant.json();
    assert.equal(f.store.getClient(variantClient.client_id)?.approvalStatus, "pending");
  } finally { await f.cleanup(); }
});

test("a multi-redirect DCR registration is deduplicated, approved as one unit, and remains exact through OAuth", async () => {
  const firstRedirect = "https://oauth.gemini.example/oauth/callback";
  const secondRedirect = "https://oauth-alt.gemini.example/oauth/callback";
  const unrelatedRedirect = "https://other-client.example/oauth/callback";
  const f = await fixture();
  try {
    f.store.registerClient({ clientId: "dcr_other", clientName: "Other", redirectUris: [unrelatedRedirect], kind: "dcr" }, 90, "approved");
    const registration = await registerUris(f.origin, [firstRedirect, secondRedirect, firstRedirect], "Gemini");
    assert.equal(registration.status, 201);
    const registered = await registration.json() as { client_id: string; redirect_uris: string[] };
    assert.deepEqual(registered.redirect_uris, [firstRedirect, secondRedirect]);
    assert.deepEqual(f.store.getClient(registered.client_id)?.redirectUris, [firstRedirect, secondRedirect]);
    assert.equal(f.store.getClient(registered.client_id)?.approvalStatus, "pending");
    const pendingAudit = f.audit.entries.find((entry) => "decision" in entry && entry.decision === "pending" && entry.client_name_claimed === "Gemini");
    assert.ok(pendingAudit && "redirect_uri_count" in pendingAudit);
    assert.equal(pendingAudit.redirect_uri_count, 2);
    assert.deepEqual(pendingAudit.redirect_hosts, ["oauth.gemini.example", "oauth-alt.gemini.example"]);
    assert.equal(Object.prototype.hasOwnProperty.call(pendingAudit, "redirect_uri"), false);

    const verifier = randomBytes(48).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const authorizeUrl = new URL(`${f.origin}/oauth/authorize`);
    authorizeUrl.search = new URLSearchParams({
      response_type: "code", client_id: registered.client_id, redirect_uri: secondRedirect, scope: "mcp:read",
      resource: `${PUBLIC_ORIGIN}/mcp`, state: "gemini-multi", code_challenge: challenge, code_challenge_method: "S256",
    }).toString();
    const pending = await fetch(authorizeUrl, { redirect: "manual" });
    assert.equal(pending.status, 403);
    assert.equal((await pending.json()).error, "authorization_pending");

    assert.ok(f.store.approveClient(registered.client_id, 100));
    assert.equal(f.store.isRedirectApproved(firstRedirect), true);
    assert.equal(f.store.isRedirectApproved(secondRedirect), true);
    const unregistered = new URL(authorizeUrl);
    unregistered.searchParams.set("redirect_uri", "https://oauth.gemini.example/oauth/not-registered");
    assert.equal((await fetch(unregistered, { redirect: "manual" })).status, 400);

    const started = await fetch(authorizeUrl, { redirect: "manual" });
    assert.equal(started.status, 302);
    const csrfCookie = started.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
    const googleLocation = new URL(started.headers.get("location")!);
    const callback = await fetch(`${f.origin}/oauth/google/callback?code=google-code&state=${encodeURIComponent(googleLocation.searchParams.get("state")!)}`, { redirect: "manual" });
    assert.equal(callback.status, 302);
    const consentLocation = new URL(callback.headers.get("location")!);
    const consent = await fetch(`${f.origin}${consentLocation.pathname}${consentLocation.search}`);
    const consentHtml = await consent.text();
    assert.match(consentHtml, /oauth\.gemini\.example/);
    assert.match(consentHtml, /oauth-alt\.gemini\.example/);
    const csp = consent.headers.get("content-security-policy") ?? "";
    assert.match(csp, /form-action 'self' https:\/\/oauth\.gemini\.example https:\/\/oauth-alt\.gemini\.example/);
    assert.doesNotMatch(csp, /other-client\.example/);

    const transaction = consentLocation.searchParams.get("transaction")!;
    const decision = await fetch(`${f.origin}/oauth/consent`, {
      method: "POST",
      redirect: "manual",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: PUBLIC_ORIGIN, Cookie: csrfCookie },
      body: new URLSearchParams({ transaction, decision: "allow" }),
    });
    assert.equal(decision.status, 302);
    const clientCallback = new URL(decision.headers.get("location")!);
    assert.equal(`${clientCallback.origin}${clientCallback.pathname}`, secondRedirect);
    const code = clientCallback.searchParams.get("code")!;

    const wrongRedirectToken = await fetch(`${f.origin}/oauth/token`, {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", client_id: registered.client_id, redirect_uri: firstRedirect, code, code_verifier: verifier }),
    });
    assert.equal(wrongRedirectToken.status, 400);
    const exactRedirectToken = await fetch(`${f.origin}/oauth/token`, {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", client_id: registered.client_id, redirect_uri: secondRedirect, code, code_verifier: verifier }),
    });
    assert.equal(exactRedirectToken.status, 200);
  } finally { await f.cleanup(); }
});

test("multi-redirect DCR rejects the whole registration when one URI is unsafe or the unique limit is exceeded", async () => {
  const f = await fixture();
  try {
    const userinfoRedirect = new URL("https://userinfo.example/callback");
    userinfoRedirect.username = "u";
    userinfoRedirect.password = "p";
    const unsafeSets = [
      ["https://valid.example/callback", "http://insecure.example/callback"],
      ["https://valid.example/callback", userinfoRedirect.href],
      ["https://valid.example/callback", "https://fragment.example/callback#fragment"],
      ["https://valid.example/callback", "https://*.wildcard.example/callback"],
    ];
    for (const redirectUris of unsafeSets) {
      const response = await registerUris(f.origin, redirectUris, "Unsafe Client");
      assert.equal(response.status, 400);
      assert.equal((await response.json()).error, "invalid_redirect_uri");
      assert.equal(f.store.clientCount(), 0);
    }
    const overLimit = Array.from({ length: 11 }, (_, index) => `https://callback-${index}.example/oauth/callback`);
    const response = await registerUris(f.origin, overLimit, "Too Many Redirects");
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error, "invalid_client_metadata");
    assert.equal(f.store.clientCount(), 0);
  } finally { await f.cleanup(); }
});

test("registration audit failure leaves no pending or approved client behind", async () => {
  const f = await fixture(new MemoryGatewayAudit(true)); try {
    const registration = await register(f.origin, "https://unaudited.example/callback");
    assert.equal(registration.status, 503);
    assert.equal(f.store.clientCount(), 0);
  } finally { await f.cleanup(); }
});

test("DCR rejects control characters in the self-claimed name before it can reach the local pending list", async () => {
  const f = await fixture(); try {
    const registration = await fetch(`${f.origin}/oauth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_name: "Grok\tforged-terminal-row",
        redirect_uris: ["https://grok.example/oauth/callback"],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      }),
    });
    assert.equal(registration.status, 400);
    assert.equal((await registration.json()).error, "invalid_client_metadata");
    assert.equal(f.store.clientCount(), 0);
  } finally { await f.cleanup(); }
});

test("DCR rejection log records only metadata shapes and HTTPS domain hosts", async () => {
  const logs: RegistrationRejectionLog[] = [];
  const f = await fixture(new MemoryGatewayAudit(), {}, () => 1_760_000_000, undefined, undefined, (entry) => logs.push(entry));
  try {
    const registration = await fetch(`${f.origin}/oauth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        redirect_uris: [
          "http://127.0.0.1:54321/callback?secret=hidden",
          "http://[::1]:54322/callback",
          "http://localhost:54323/private",
          "https://accounts.gemini.example/private/callback?token=hidden",
          "https://192.0.2.1/callback",
          42,
        ],
        grant_types: ["authorization_code", "refresh_token", "private-custom-grant"],
        token_endpoint_auth_method: "client_secret_basic",
        client_id: "must-not-be-logged",
        client_secret: "must-not-be-logged",
        state: "must-not-be-logged",
        code_challenge: "must-not-be-logged",
      }),
    });
    assert.equal(registration.status, 400);
    assert.equal(logs.length, 1);
    assert.deepEqual(logs[0], {
      at: "2025-10-09T08:53:20.000Z",
      event: "oauth_client_registration_rejected",
      rejection_reason: "metadata-shape",
      client_name_shape: "absent",
      redirect_uris: {
        container: "array",
        count: 6,
        items: [
          { value_shape: "string", scheme: "http", host_kind: "loopback-v4", port: "present" },
          { value_shape: "string", scheme: "http", host_kind: "loopback-v6", port: "present" },
          { value_shape: "string", scheme: "http", host_kind: "localhost", port: "present" },
          { value_shape: "string", scheme: "https", host_kind: "domain", host: "accounts.gemini.example", port: "absent" },
          { value_shape: "string", scheme: "https", host_kind: "ip", port: "absent" },
          { value_shape: "non-string" },
        ],
        truncated: false,
      },
      grant_types: { container: "array", count: 3, values: ["authorization_code", "refresh_token", "other-string"], truncated: false },
      token_endpoint_auth_method_shape: "client_secret_basic",
    });
    const serialized = JSON.stringify(logs[0]);
    for (const forbidden of ["54321", "/callback", "hidden", "private-custom-grant", "must-not-be-logged", "client_id", "code_challenge"]) {
      assert.equal(serialized.includes(forbidden), false, `rejection log must omit ${forbidden}`);
    }
  } finally { await f.cleanup(); }
});

test("DCR rejection logging cannot alter accepted registrations or rejection responses", async () => {
  const logs: RegistrationRejectionLog[] = [];
  const f = await fixture(new MemoryGatewayAudit(), {}, undefined, undefined, undefined, (entry) => logs.push(entry));
  try {
    const accepted = await register(f.origin);
    assert.equal(accepted.status, 201);
    assert.equal(logs.length, 0);
  } finally { await f.cleanup(); }

  const throwing = await fixture(new MemoryGatewayAudit(), {}, undefined, undefined, undefined, () => { throw new Error("simulated logger failure"); });
  try {
    const rejected = await fetch(`${throwing.origin}/oauth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_name: "Gemini", redirect_uris: [] }),
    });
    assert.equal(rejected.status, 400);
    assert.equal((await rejected.json()).error, "invalid_client_metadata");
  } finally { await throwing.cleanup(); }
});

test("an unknown CIMD callback is recorded as pending and cannot start Google OAuth before approval", async () => {
  const clientId = "https://clients.grok.example/.well-known/oauth-client.json";
  const grokCallback = "https://clients.grok.example/oauth/callback";
  const metadataFetch = (async (input: string | URL | Request) => {
    assert.equal(String(input), clientId);
    return Response.json({ client_id: clientId, client_name: "Grok", redirect_uris: [grokCallback] });
  }) as typeof fetch;
  const f = await fixture(new MemoryGatewayAudit(), {}, undefined, undefined, metadataFetch); try {
    const verifier = randomBytes(48).toString("base64url");
    const parameters = new URLSearchParams({
      response_type: "code", client_id: clientId, redirect_uri: grokCallback, scope: "mcp:read",
      resource: `${PUBLIC_ORIGIN}/mcp`, state: "grok-cimd", code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
    });
    const first = await fetch(`${f.origin}/oauth/authorize?${parameters}`, { redirect: "manual" });
    assert.equal(first.status, 403);
    assert.equal((await first.json()).error, "authorization_pending");
    assert.equal(f.store.getClient(clientId)?.approvalStatus, "pending");
    assert.equal(f.store.db.prepare("SELECT COUNT(*) AS count FROM oauth_transactions").get().count, 0);
    assert.ok(f.store.approveClient(clientId, 200));
    const approved = await fetch(`${f.origin}/oauth/authorize?${parameters}`, { redirect: "manual" });
    assert.equal(approved.status, 302);
  } finally { await f.cleanup(); }
});

test("a DCR read-only request reaches explicit Phase 3 consent and receives combined scope only after approval", async () => {
  const f = await fixture(); try {
    const authorization = await authorize(f, randomBytes(48).toString("base64url"), "mcp:read");
    const token = await exchange(f.origin, authorization);
    assert.equal(token.status, 200);
    assert.equal((await token.json()).scope, "mcp:act mcp:read");
  } finally { await f.cleanup(); }
});

test("an existing active CIMD client may omit scope or request read-only but must still complete Phase 3 consent", async () => {
  const f = await fixture(); try {
    const clientId = "https://claude.ai/.well-known/aipl-test-client.json";
    f.store.registerClient({ clientId, clientName: "Claude", redirectUri: CALLBACK, redirectHost: "claude.ai", kind: "cimd" }, 100, "approved");
    f.store.db.prepare("UPDATE clients SET status = 'active', authorized_at = ? WHERE client_id = ?").run(101, clientId);
    for (const scope of [null, "mcp:read"] as const) {
      const challenge = createHash("sha256").update(randomBytes(48).toString("base64url")).digest("base64url");
      const parameters = new URLSearchParams({
        response_type: "code", client_id: clientId, redirect_uri: CALLBACK, resource: `${PUBLIC_ORIGIN}/mcp`,
        state: `cimd-${scope ?? "absent"}`, code_challenge: challenge, code_challenge_method: "S256",
      });
      if (scope !== null) parameters.set("scope", scope);
      const started = await fetch(`${f.origin}/oauth/authorize?${parameters}`, { redirect: "manual" });
      assert.equal(started.status, 302);
      const googleLocation = new URL(started.headers.get("location")!);
      const transaction = f.store.transactionByGoogleState(googleLocation.searchParams.get("state")!);
      assert.equal(transaction?.scope, "mcp:act mcp:read");
      assert.equal(f.store.getClient(clientId)?.kind, "cimd");
    }
  } finally { await f.cleanup(); }
});

test("section 4.4 consent shows the self-claimed name and redirect host and rejects CSRF failures", async () => {
  const f = await fixture(); try {
    const pending = await beginAuthorization(f);
    assert.match(pending.setCookie, /HttpOnly/);
    assert.match(pending.setCookie, /Secure/);
    assert.match(pending.setCookie, /SameSite=Lax/);
    const page = await fetch(`${f.origin}${pending.consentLocation.pathname}${pending.consentLocation.search}`);
    const html = await page.text();
    assert.equal(page.status, 200);
    assert.match(html, /AI（自称）/);
    assert.match(html, />Claude</);
    assert.match(html, />claude\.ai</);
    assert.match(html, /読み取り＋家電操作/);
    assert.match(page.headers.get("content-security-policy") ?? "", /form-action 'self' https:\/\/claude\.ai/);

    const withoutCookie = await fetch(`${f.origin}/oauth/consent`, {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: PUBLIC_ORIGIN },
      body: new URLSearchParams({ transaction: pending.transaction, decision: "allow" }),
    });
    assert.equal(withoutCookie.status, 403);
    const wrongOrigin = await fetch(`${f.origin}/oauth/consent`, {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: "https://attacker.example", Cookie: pending.csrfCookie },
      body: new URLSearchParams({ transaction: pending.transaction, decision: "allow" }),
    });
    assert.equal(wrongOrigin.status, 403);
    assert.equal(f.store.getClient(pending.clientId)?.status, "pending");
  } finally { await f.cleanup(); }
});

test("section 4.4 accepts a same-origin top-level browser POST when Origin is opaque and Referrer is suppressed", async () => {
  const f = await fixture(new MemoryGatewayAudit()); try {
    const pending = await beginAuthorization(f);
    const decision = await rawRequest(f.origin, "/oauth/consent", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Origin: "null",
        Cookie: pending.csrfCookie,
        "Sec-Fetch-Site": "same-origin",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Dest": "document",
      },
      body: new URLSearchParams({ transaction: pending.transaction, decision: "allow" }).toString(),
    });
    assert.equal(decision.status, 302);
    assert.equal(new URL(String(decision.headers.location)).origin, "https://claude.ai");
  } finally { await f.cleanup(); }
});

test("section 4.4 rejects an opaque Origin without same-origin navigation evidence", async () => {
  const f = await fixture(new MemoryGatewayAudit()); try {
    const pending = await beginAuthorization(f);
    const decision = await rawRequest(f.origin, "/oauth/consent", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Origin: "null",
        Cookie: pending.csrfCookie,
        "Sec-Fetch-Site": "cross-site",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Dest": "document",
      },
      body: new URLSearchParams({ transaction: pending.transaction, decision: "allow" }).toString(),
    });
    assert.equal(decision.status, 403);
    assert.match(decision.body, /送信元を確認できません/);
    assert.equal(f.store.getClient(pending.clientId)?.status, "pending");
  } finally { await f.cleanup(); }
});

test("section 4.4 completes consent through the 8790 entry path and safely replays an immediate duplicate POST", async () => {
  const f = await fixture(new MemoryGatewayAudit());
  const entry = createOffEntryServer({ fetchImpl: async () => new Response("not used", { status: 500 }), remoteGatewayOrigin: f.origin });
  await new Promise<void>((resolve) => entry.listen(0, "127.0.0.1", resolve));
  const entryOrigin = `http://127.0.0.1:${(entry.address() as AddressInfo).port}`;
  try {
    const verifier = randomBytes(48).toString("base64url");
    const registration = await register(entryOrigin);
    assert.equal(registration.status, 201);
    const client = await registration.json() as { client_id: string };
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const authorizeUrl = new URL(`${entryOrigin}/oauth/authorize`);
    authorizeUrl.search = new URLSearchParams({
      response_type: "code",
      client_id: client.client_id,
      redirect_uri: CALLBACK,
      scope: "mcp:read",
      resource: `${PUBLIC_ORIGIN}/mcp`,
      state: "claude-through-entry",
      code_challenge: challenge,
      code_challenge_method: "S256",
    }).toString();
    const started = await fetch(authorizeUrl, { redirect: "manual" });
    assert.equal(started.status, 302);
    const csrfCookie = started.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
    assert.match(csrfCookie, /^door_consent_csrf=/);
    assert.match(started.headers.get("set-cookie") ?? "", /HttpOnly/);
    assert.match(started.headers.get("set-cookie") ?? "", /Secure/);
    assert.match(started.headers.get("set-cookie") ?? "", /SameSite=Lax/);
    const googleLocation = new URL(started.headers.get("location")!);
    const callback = await fetch(`${entryOrigin}/oauth/google/callback?code=google-code&state=${encodeURIComponent(googleLocation.searchParams.get("state")!)}`, { redirect: "manual" });
    assert.equal(callback.status, 302);
    const consentLocation = new URL(callback.headers.get("location")!);
    const page = await rawRequest(entryOrigin, `${consentLocation.pathname}${consentLocation.search}`, { headers: { Cookie: csrfCookie } });
    assert.equal(page.status, 200);
    assert.match(page.body, /読み取り＋家電操作を許可する/);
    const transaction = consentLocation.searchParams.get("transaction")!;
    const consentRequest = {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Origin: "null",
        Cookie: csrfCookie,
        "Sec-Fetch-Site": "same-origin",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Dest": "document",
      },
      body: new URLSearchParams({ transaction, decision: "allow" }).toString(),
    };
    const first = await rawRequest(entryOrigin, "/oauth/consent", consentRequest);
    assert.equal(first.headers["set-cookie"], undefined, "the successful redirect must not erase the short-lived CSRF cookie before a browser retry");
    assert.equal(first.status, 302, "the 8790 entry must return the gateway redirect without following it");
    assert.equal(first.body, "");
    assert.match(String(first.headers["content-security-policy"]), /form-action 'self' https:\/\/claude\.ai/);
    const wrongCookieReplay = await rawRequest(entryOrigin, "/oauth/consent", {
      ...consentRequest,
      headers: { ...consentRequest.headers, Cookie: "door_consent_csrf=wrong" },
    });
    const duplicate = await rawRequest(entryOrigin, "/oauth/consent", consentRequest);
    assert.equal(wrongCookieReplay.status, 403);
    assert.equal(duplicate.status, 302);
    assert.equal(duplicate.headers.location, first.headers.location);
    const clientCallback = new URL(String(duplicate.headers.location));
    assert.equal(clientCallback.origin, "https://claude.ai");
    assert.equal(clientCallback.pathname, "/api/mcp/auth_callback");
    assert.equal(clientCallback.searchParams.get("state"), "claude-through-entry");
    const token = await fetch(`${entryOrigin}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: clientCallback.searchParams.get("code")!,
        client_id: client.client_id,
        redirect_uri: CALLBACK,
        code_verifier: verifier,
      }),
    });
    assert.equal(token.status, 200);
    assert.equal((await token.json()).scope, "mcp:act mcp:read");
  } finally {
    await new Promise<void>((resolve, reject) => entry.close((error) => error ? reject(error) : resolve()));
    await f.cleanup();
  }
});

test("section 4.8 enforces the registered-client ceiling", async () => {
  const f = await fixture(new MemoryGatewayAudit(), { maxClients: 1 }); try {
    assert.equal((await register(f.origin)).status, 201);
    assert.equal((await register(f.origin)).status, 429);
    assert.equal(f.store.clientCount(), 1);
  } finally { await f.cleanup(); }
});

test("section 4.8 automatically deletes a pending registration after its TTL", async () => {
  let clock = 10_000;
  const f = await fixture(new MemoryGatewayAudit(), { pendingClientTtlSeconds: 300 }, () => clock, 10); try {
    assert.equal((await register(f.origin, "https://new-client.example/callback")).status, 201);
    assert.equal(f.store.clientCount(), 1);
    clock += 301;
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(f.store.clientCount(), 0);
    assert.ok(f.audit.entries.some((item) => "decision" in item && item.decision === "expired"));
  } finally { await f.cleanup(); }
});

test("pending registrations have a separate ceiling without blocking an already approved callback", async () => {
  const f = await fixture(new MemoryGatewayAudit(), { maxClients: 5, maxPendingClients: 1 }); try {
    assert.equal((await register(f.origin, "https://first.example/callback")).status, 201);
    assert.equal((await register(f.origin, "https://second.example/callback")).status, 429);
    assert.equal((await register(f.origin, CALLBACK)).status, 201);
    assert.equal(f.store.pendingClientCount(), 1);
  } finally { await f.cleanup(); }
});

test("section 4.8 rate limits registration, authorization, and token endpoints independently", async () => {
  const f = await fixture(new MemoryGatewayAudit(), { registrationRateLimitPerHour: 1, oauthRateLimitPerMinute: 1 }); try {
    const registration = await register(f.origin); assert.equal(registration.status, 201);
    assert.equal((await register(f.origin)).status, 429);
    const client = await registration.json();
    const challenge = createHash("sha256").update(randomBytes(48).toString("base64url")).digest("base64url");
    const authorizeUrl = new URL(`${f.origin}/oauth/authorize`);
    authorizeUrl.search = new URLSearchParams({ response_type: "code", client_id: client.client_id, redirect_uri: CALLBACK, scope: "mcp:read mcp:act", resource: `${PUBLIC_ORIGIN}/mcp`, state: "state", code_challenge: challenge, code_challenge_method: "S256" }).toString();
    assert.equal((await fetch(authorizeUrl, { redirect: "manual" })).status, 302);
    assert.equal((await fetch(authorizeUrl, { redirect: "manual" })).status, 429);
    const invalidRefresh = () => fetch(`${f.origin}/oauth/token`, {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", client_id: client.client_id, refresh_token: "not-a-token" }),
    });
    assert.equal((await invalidRefresh()).status, 400);
    assert.equal((await invalidRefresh()).status, 429);
  } finally { await f.cleanup(); }
});

test("a disallowed Google sub is rejected before the master credential is accepted", async () => {
  const f = await fixture(); try {
    f.google.sub = "different-google-sub";
    const registration = await register(f.origin); const client = await registration.json();
    const verifier = randomBytes(48).toString("base64url"); const challenge = createHash("sha256").update(verifier).digest("base64url");
    const authorizeUrl = new URL(`${f.origin}/oauth/authorize`);
    authorizeUrl.search = new URLSearchParams({ response_type: "code", client_id: client.client_id, redirect_uri: CALLBACK, scope: "mcp:read mcp:act", resource: `${PUBLIC_ORIGIN}/mcp`, state: "claude-state", code_challenge: challenge, code_challenge_method: "S256" }).toString();
    const started = await fetch(authorizeUrl, { redirect: "manual" }); const googleLocation = new URL(started.headers.get("location")!);
    const callback = await fetch(`${f.origin}/oauth/google/callback?code=google-code&state=${encodeURIComponent(googleLocation.searchParams.get("state")!)}`, { redirect: "manual" });
    assert.equal(callback.status, 403); assert.equal(f.google.accepted, 0); assert.equal(f.store.masterSwitch().value, "unknown");
  } finally { await f.cleanup(); }
});

test("PKCE issues opaque hashed tokens and a fresh Phase 3 consent exposes read and action tools", async () => {
  const f = await fixture(); try {
    const authorization = await authorize(f);
    const wrongPkce = await exchange(f.origin, authorization, randomBytes(48).toString("base64url")); assert.equal(wrongPkce.status, 400);
    // A failed code exchange consumes nothing, so the correct verifier still works.
    const tokenResponse = await exchange(f.origin, authorization); assert.equal(tokenResponse.status, 200);
    const tokens = await tokenResponse.json();
    assert.equal(f.store.db.prepare("SELECT COUNT(*) AS count FROM access_tokens WHERE token_hash = ?").get(tokens.access_token).count, 0);
    assert.equal(f.store.db.prepare("SELECT COUNT(*) AS count FROM access_tokens WHERE token_hash = ?").get(createHash("sha256").update(tokens.access_token).digest("hex")).count, 1);
    const list = await fetch(`${f.origin}/mcp`, { method: "POST", headers: { Authorization: `Bearer ${tokens.access_token}`, Accept: "application/json, text/event-stream", "Content-Type": "application/json", "MCP-Protocol-Version": "2025-11-25" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }) });
    assert.equal(list.status, 200);
    const listed = await rpcBody(list); assert.deepEqual(listed.result.tools.map((tool: { name: string }) => tool.name).sort(), ["execute_action", "get_capabilities", "get_state"]);
    const before = f.store.getClient(authorization.clientId); assert.equal(before?.lastUsedAt, undefined);
    const call = await fetch(`${f.origin}/mcp`, { method: "POST", headers: { Authorization: `Bearer ${tokens.access_token}`, Accept: "application/json, text/event-stream", "Content-Type": "application/json", "MCP-Protocol-Version": "2025-11-25" }, body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "get_state", arguments: {} } }) });
    assert.equal(call.status, 200); assert.equal((await rpcBody(call)).result.isError, undefined);
    assert.equal(f.core.reads, 1); assert.ok(f.store.getClient(authorization.clientId)?.lastUsedAt);
    const toolEntries = f.audit.entries.filter((item) => "tool" in item);
    assert.deepEqual(toolEntries.map((item) => [item.tool, item.phase, item.result]), [["get_state", "attempt", "pending"], ["get_state", "result", "succeeded"]]);
    assert.equal(Object.prototype.hasOwnProperty.call(toolEntries[0], "arguments"), false);
  } finally { await f.cleanup(); }
});

test("a pre-Phase-3 read token stays read-only and refresh does not silently upgrade it", async () => {
  const f = await fixture(); try {
    const authorization = await authorize(f); await exchange(f.origin, authorization);
    const accessToken = `legacy-access-${randomBytes(24).toString("base64url")}`;
    const refreshToken = `legacy-refresh-${randomBytes(24).toString("base64url")}`;
    f.store.issueTokenPair({
      accessHash: createHash("sha256").update(accessToken).digest("hex"),
      refreshHash: createHash("sha256").update(refreshToken).digest("hex"),
      clientId: authorization.clientId,
      scope: "mcp:read",
      resource: `${PUBLIC_ORIGIN}/mcp`,
      accessExpiresAt: 4_000_000_000,
      refreshExpiresAt: 4_000_000_000,
      familyId: "legacy-family",
      now: 1,
    });
    const list = await fetch(`${f.origin}/mcp`, { method: "POST", headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json, text/event-stream", "Content-Type": "application/json", "MCP-Protocol-Version": "2025-11-25" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }) });
    const listed = await rpcBody(list);
    assert.deepEqual(listed.result.tools.map((tool: { name: string }) => tool.name).sort(), ["get_capabilities", "get_state"]);
    const refreshed = await fetch(`${f.origin}/oauth/token`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "refresh_token", client_id: authorization.clientId, refresh_token: refreshToken }) });
    assert.equal(refreshed.status, 200);
    const rotated = await refreshed.json();
    assert.equal(rotated.scope, "mcp:read");
    const rotatedList = await fetch(`${f.origin}/mcp`, { method: "POST", headers: { Authorization: `Bearer ${rotated.access_token}`, Accept: "application/json, text/event-stream", "Content-Type": "application/json", "MCP-Protocol-Version": "2025-11-25" }, body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }) });
    assert.deepEqual((await rpcBody(rotatedList)).result.tools.map((tool: { name: string }) => tool.name).sort(), ["get_capabilities", "get_state"]);
  } finally { await f.cleanup(); }
});

test("existing Phase 1 refresh rows migrate as read-only grants", () => {
  const directory = mkdtempSync(join(tmpdir(), "aipl-door-migration-test-"));
  const databaseFile = join(directory, "gateway.sqlite");
  try {
    const legacy = new DatabaseSync(databaseFile);
    legacy.exec(`CREATE TABLE refresh_tokens (
      token_hash TEXT PRIMARY KEY, client_id TEXT NOT NULL, family_id TEXT NOT NULL, expires_at INTEGER NOT NULL,
      status TEXT NOT NULL, created_at INTEGER NOT NULL, used_at INTEGER, replaced_by_hash TEXT
    );`);
    legacy.prepare("INSERT INTO refresh_tokens(token_hash,client_id,family_id,expires_at,status,created_at) VALUES(?,?,?,?,?,?)")
      .run("legacy-hash", "legacy-client", "legacy-family", 4_000_000_000, "active", 1);
    legacy.close();
    const migrated = new GatewayStore(databaseFile);
    assert.equal(migrated.refreshToken("legacy-hash")?.scope, "mcp:read");
    assert.equal(migrated.refreshToken("legacy-hash")?.resource, "");
    migrated.close();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("an existing Claude client migrates as approved without changing its active connection", () => {
  const directory = mkdtempSync(join(tmpdir(), "aipl-door-client-migration-test-"));
  const databaseFile = join(directory, "gateway.sqlite");
  try {
    const legacy = new DatabaseSync(databaseFile);
    legacy.exec(`CREATE TABLE clients (
      client_id TEXT PRIMARY KEY, client_name TEXT NOT NULL, redirect_uri TEXT NOT NULL, redirect_host TEXT NOT NULL,
      kind TEXT NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL, authorized_at INTEGER,
      last_used_at INTEGER, revoked_at INTEGER
    );`);
    legacy.prepare("INSERT INTO clients(client_id,client_name,redirect_uri,redirect_host,kind,status,created_at,authorized_at,last_used_at) VALUES(?,?,?,?,?,?,?,?,?)")
      .run("https://claude.ai/oauth/mcp-oauth-client-metadata", "Claude", CALLBACK, "claude.ai", "cimd", "active", 100, 101, 102);
    legacy.close();
    const migrated = new GatewayStore(databaseFile);
    const claude = migrated.getClient("https://claude.ai/oauth/mcp-oauth-client-metadata");
    assert.equal(claude?.status, "active");
    assert.equal(claude?.approvalStatus, "approved");
    assert.equal(claude?.lastUsedAt, 102);
    assert.deepEqual(claude?.redirectUris, [CALLBACK]);
    assert.deepEqual(claude?.redirectHosts, ["claude.ai"]);
    assert.equal(migrated.isRedirectApproved(CALLBACK), true);
    migrated.close();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("execute_action exposes all 48 Catalog actions and returns reportable observed-state material", async () => {
  const f = await fixture(); try {
    const firstAuthorization = await authorize(f); const firstTokens = await (await exchange(f.origin, firstAuthorization)).json();
    const list = await fetch(`${f.origin}/mcp`, { method: "POST", headers: { Authorization: `Bearer ${firstTokens.access_token}`, Accept: "application/json, text/event-stream", "Content-Type": "application/json", "MCP-Protocol-Version": "2025-11-25" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }) });
    const actionTool = (await rpcBody(list)).result.tools.find((tool: { name: string }) => tool.name === "execute_action");
    assert.equal(actionTool.inputSchema.properties.action_id.enum.length, 48);
    assert.match(actionTool.description, /unknown/);
    assert.match(actionTool.description, /do not retry automatically/);

    const invoke = (token: string, id: number) => fetch(`${f.origin}/mcp`, { method: "POST", headers: { Authorization: `Bearer ${token}`, Accept: "application/json, text/event-stream", "Content-Type": "application/json", "MCP-Protocol-Version": "2025-11-25" }, body: JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "execute_action", arguments: { action_id: "light.living_room.off", parameters: {}, intent_id: "same-user-intent" } } }) });
    const first = await rpcBody(await invoke(firstTokens.access_token, 2));
    assert.equal(first.result.isError, undefined);
    assert.equal(first.result.structuredContent.action.name, "消灯");
    assert.equal(first.result.structuredContent.result_classification, "succeeded");
    assert.equal(first.result.structuredContent.state_after.classification, "observed");
    assert.equal(first.result.structuredContent.state_after.field.status, "observed");
    assert.notEqual(f.core.actions[0].idempotencyKey, "same-user-intent");
    assert.match(f.core.actions[0].idempotencyKey, /^door\.[a-f0-9]{64}$/);

    await invoke(firstTokens.access_token, 3);
    assert.equal(f.core.actions[1].idempotencyKey, f.core.actions[0].idempotencyKey);
    const secondAuthorization = await authorize(f); const secondTokens = await (await exchange(f.origin, secondAuthorization)).json();
    await invoke(secondTokens.access_token, 4);
    assert.notEqual(f.core.actions[2].idempotencyKey, f.core.actions[0].idempotencyKey);
    const actionEntries = f.audit.entries.filter((item) => "tool" in item && item.tool === "execute_action");
    assert.deepEqual(actionEntries.slice(0, 2).map((item) => [item.tool, item.phase, item.result, item.action_id, item.action_name]), [
      ["execute_action", "attempt", "pending", "light.living_room.off", "消灯"],
      ["execute_action", "result", "succeeded", "light.living_room.off", "消灯"],
    ]);
    assert.equal(Object.prototype.hasOwnProperty.call(actionEntries[0], "parameters"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(actionEntries[0], "intent_id"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(actionEntries[0], "idempotency_key"), false);
  } finally { await f.cleanup(); }
});

test("an unknown action outcome is not retried and is never reported as confirmed", async () => {
  const f = await fixture(); try {
    const authorization = await authorize(f); const tokens = await (await exchange(f.origin, authorization)).json();
    f.core.failAction = "unknown";
    const call = await fetch(`${f.origin}/mcp`, { method: "POST", headers: { Authorization: `Bearer ${tokens.access_token}`, Accept: "application/json, text/event-stream", "Content-Type": "application/json", "MCP-Protocol-Version": "2025-11-25" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "execute_action", arguments: { action_id: "media.tv.navigate", parameters: { key: "menu" }, intent_id: "unknown-intent-01" } } }) });
    const result = await rpcBody(call);
    assert.equal(result.result.isError, true);
    assert.equal(result.result.structuredContent.result_classification, "unknown");
    assert.equal(result.result.structuredContent.state_after.classification, "unknown");
    assert.match(result.result.structuredContent.reporting_rule, /unknown/);
    assert.equal(f.core.actions.length, 1);
    assert.deepEqual(f.audit.entries.filter((item) => "tool" in item).map((item) => item.result), ["pending", "unknown"]);
  } finally { await f.cleanup(); }
});

test("action result tells the AI to relay temporary SQLite recording status", async () => {
  const f = await fixture(); try {
    const authorization = await authorize(f); const tokens = await (await exchange(f.origin, authorization)).json();
    f.core.temporaryRecording = true;
    const call = await fetch(`${f.origin}/mcp`, { method: "POST", headers: { Authorization: `Bearer ${tokens.access_token}`, Accept: "application/json, text/event-stream", "Content-Type": "application/json", "MCP-Protocol-Version": "2025-11-25" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "execute_action", arguments: { action_id: "light.living_room.off", parameters: {}, intent_id: "temporary-recording-01" } } }) });
    const result = await rpcBody(call);
    assert.equal(result.result.structuredContent.recording.status, "temporary");
    assert.equal(result.result.structuredContent.recording.must_tell_user, true);
    assert.match(result.result.structuredContent.recording_reporting_rule, /Tell the user/);
  } finally { await f.cleanup(); }
});

test("action audit failure rejects before Core and leaves the gateway running", async () => {
  const audit = new MemoryGatewayAudit();
  const f = await fixture(audit); try {
    const authorization = await authorize(f); const tokens = await (await exchange(f.origin, authorization)).json();
    audit.fail = true;
    const call = await fetch(`${f.origin}/mcp`, { method: "POST", headers: { Authorization: `Bearer ${tokens.access_token}`, Accept: "application/json, text/event-stream", "Content-Type": "application/json", "MCP-Protocol-Version": "2025-11-25" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "execute_action", arguments: { action_id: "light.living_room.off", parameters: {}, intent_id: "audit-failure-intent" } } }) });
    const result = await rpcBody(call);
    assert.equal(result.result.isError, true);
    assert.equal(result.result.structuredContent.result_classification, "failed");
    assert.equal(f.core.actions.length, 0);
    assert.equal((await fetch(`${f.origin}/health`)).status, 503);
  } finally { await f.cleanup(); }
});

test("action result-audit failure reports unknown without resending and leaves the gateway running", async () => {
  let writes = 0;
  const audit = new MemoryGatewayAudit();
  audit.append = (entry) => { writes += 1; if (writes === 2) throw new Error("result audit unavailable"); audit.entries.push(structuredClone(entry)); };
  const f = await fixture(audit); try {
    const authorization = await authorize(f); const tokens = await (await exchange(f.origin, authorization)).json();
    writes = 0; audit.entries.length = 0;
    const call = await fetch(`${f.origin}/mcp`, { method: "POST", headers: { Authorization: `Bearer ${tokens.access_token}`, Accept: "application/json, text/event-stream", "Content-Type": "application/json", "MCP-Protocol-Version": "2025-11-25" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "execute_action", arguments: { action_id: "light.living_room.off", parameters: {}, intent_id: "result-audit-failure" } } }) });
    const result = await rpcBody(call);
    assert.equal(result.result.isError, true);
    assert.equal(result.result.structuredContent.result_classification, "unknown");
    assert.match(result.result.structuredContent.detail, /must not be retried|Do not retry/i);
    assert.equal(f.core.actions.length, 1);
    assert.equal((await fetch(`${f.origin}/health`)).status, 200);
  } finally { await f.cleanup(); }
});

test("refresh rotation detects reuse and revokes that client", async () => {
  const f = await fixture(); try {
    const authorization = await authorize(f); const initial = await (await exchange(f.origin, authorization)).json();
    const refresh = () => fetch(`${f.origin}/oauth/token`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "refresh_token", client_id: authorization.clientId, refresh_token: initial.refresh_token }) });
    const rotated = await refresh(); assert.equal(rotated.status, 200); assert.notEqual((await rotated.json()).refresh_token, initial.refresh_token);
    const replayed = await refresh(); assert.equal(replayed.status, 400);
    assert.equal(f.store.getClient(authorization.clientId)?.status, "revoked");
    const oldAccess = await fetch(`${f.origin}/mcp`, { method: "POST", headers: { Authorization: `Bearer ${initial.access_token}`, "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }) });
    assert.equal(oldAccess.status, 401);
  } finally { await f.cleanup(); }
});

test("Google master-switch uncertainty fails closed without revoking an otherwise active client", async () => {
  const f = await fixture(); try {
    const authorization = await authorize(f); const initial = await (await exchange(f.origin, authorization)).json();
    f.google.master = "unknown";
    const denied = await fetch(`${f.origin}/oauth/token`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "refresh_token", client_id: authorization.clientId, refresh_token: initial.refresh_token }) });
    assert.equal(denied.status, 400); assert.equal(f.store.masterSwitch().value, "unknown"); assert.equal(f.store.getClient(authorization.clientId)?.status, "active");
  } finally { await f.cleanup(); }
});

test("audit failure rejects a tool call before Core and does not terminate the gateway", async () => {
  const audit = new MemoryGatewayAudit();
  const f = await fixture(audit); try {
    const authorization = await authorize(f); const tokens = await (await exchange(f.origin, authorization)).json();
    audit.fail = true;
    const call = await fetch(`${f.origin}/mcp`, { method: "POST", headers: { Authorization: `Bearer ${tokens.access_token}`, Accept: "application/json, text/event-stream", "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "get_state", arguments: {} } }) });
    assert.equal(call.status, 200); assert.equal((await rpcBody(call)).result.isError, true); assert.equal(f.core.reads, 0);
    assert.equal((await fetch(`${f.origin}/health`)).status, 503);
  } finally { await f.cleanup(); }
});

test("result-audit failure returns a tool error without terminating the gateway", async () => {
  let writes = 0;
  const audit = new MemoryGatewayAudit();
  audit.append = (entry) => { writes += 1; if (writes === 2) throw new Error("result audit unavailable"); audit.entries.push(structuredClone(entry)); };
  const f = await fixture(audit); try {
    const authorization = await authorize(f); const tokens = await (await exchange(f.origin, authorization)).json();
    writes = 0; audit.entries.length = 0;
    const call = await fetch(`${f.origin}/mcp`, { method: "POST", headers: { Authorization: `Bearer ${tokens.access_token}`, Accept: "application/json, text/event-stream", "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "get_capabilities", arguments: {} } }) });
    assert.equal(call.status, 200); assert.equal((await rpcBody(call)).result.isError, true); assert.equal(f.core.reads, 1);
    assert.equal((await fetch(`${f.origin}/health`)).status, 200);
  } finally { await f.cleanup(); }
});
