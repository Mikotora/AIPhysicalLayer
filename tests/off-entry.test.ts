import test from "node:test";
import assert from "node:assert/strict";
import { createServer, request as httpRequest, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { createHash } from "node:crypto";
import { createIntentControlServer, createOffEntryServer, SESSION_TTL_MS } from "../src/off-entry.ts";
import { ClientAuthenticator } from "../src/auth.ts";
import { MemoryAiAccessLog, type AiAccessLogEntry, type AiAccessLogWriter } from "../src/ai-access-log.ts";

async function startEntry(fetchImpl: typeof fetch, publicOrigin?: string, now?: () => number, authenticator?: ClientAuthenticator, aiAccessLog?: AiAccessLogWriter, remoteGatewayOrigin?: string) {
  const server = createOffEntryServer({ fetchImpl, publicOrigin, now, authenticator, aiAccessLog, remoteGatewayOrigin });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return {
    server,
    origin: `http://127.0.0.1:${address.port}`,
  };
}

test("OFF entry proxies only the Common Door exact paths to the loopback gateway", async (context) => {
  const seen: string[] = [];
  let consentHeaders = new Headers();
  const gateway = createServer((request, response) => {
    seen.push(`${request.method} ${request.url}`);
    if (request.url === "/oauth/consent") consentHeaders = new Headers(request.headers as Record<string, string>);
    response.writeHead(200, { "Content-Type": "application/json", "X-Gateway-Test": "ok" });
    response.end(JSON.stringify({ proxied: true }));
  });
  await new Promise<void>((resolve) => gateway.listen(0, "127.0.0.1", resolve));
  const gatewayOrigin = `http://127.0.0.1:${(gateway.address() as AddressInfo).port}`;
  const { server, origin } = await startEntry(async () => new Response("{}", { status: 500 }), undefined, undefined, undefined, undefined, gatewayOrigin);
  context.after(async () => {
    await Promise.all([
      new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
      new Promise<void>((resolve, reject) => gateway.close((error) => error ? reject(error) : resolve())),
    ]);
  });

  const mcp = await fetch(`${origin}/mcp?probe=1`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  assert.equal(mcp.status, 200);
  assert.equal(mcp.headers.get("x-gateway-test"), "ok");
  assert.deepEqual(await mcp.json(), { proxied: true });
  const metadata = await fetch(`${origin}/.well-known/oauth-protected-resource/mcp`);
  assert.equal(metadata.status, 200);
  const consent = await requestWithExactHost(origin, "/oauth/consent", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Origin: "https://door.example",
      Referer: "https://door.example/oauth/consent?transaction=redacted",
      "Sec-Fetch-Site": "same-origin",
      "Sec-Fetch-Mode": "navigate",
      "Sec-Fetch-Dest": "document",
    },
    body: "transaction=diagnostic-only&decision=allow",
  });
  assert.equal(consent.status, 200);
  assert.equal(consentHeaders.get("origin"), "https://door.example");
  assert.equal(consentHeaders.get("referer"), "https://door.example/oauth/consent?transaction=redacted");
  assert.equal(consentHeaders.get("sec-fetch-site"), "same-origin");
  assert.equal(consentHeaders.get("sec-fetch-mode"), "navigate");
  assert.equal(consentHeaders.get("sec-fetch-dest"), "document");
  const arbitrary = await fetch(`${origin}/oauth/not-allowed`);
  assert.equal(arbitrary.status, 404);
  assert.deepEqual(seen, ["POST /mcp?probe=1", "GET /.well-known/oauth-protected-resource/mcp", "POST /oauth/consent"]);
});

async function openActionPage(origin: string) {
  const response = await fetch(`${origin}/`);
  const html = await response.text();
  const cookie = response.headers.get("set-cookie")?.split(";", 1)[0];
  const csrfToken = html.match(/name="csrf_token" value="([^"]+)"/)?.[1];
  assert.ok(cookie);
  assert.ok(csrfToken);
  return { response, html, cookie, csrfToken };
}

function submitAction(origin: string, page: Awaited<ReturnType<typeof openActionPage>>) {
  return fetch(`${origin}/off`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Cookie: page.cookie,
      Origin: origin,
    },
    body: new URLSearchParams({ csrf_token: page.csrfToken }),
  });
}

function requestWithExactHost(
  origin: string,
  path: string,
  options: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  } = {},
) {
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
      response.on("end", () => resolve({
        status: response.statusCode ?? 0,
        headers: response.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      }));
    });
    request.on("error", reject);
    request.end(options.body);
  });
}

test("OFF entry exposes one fixed button and no operation inputs", async (context) => {
  const { server, origin } = await startEntry(async () => new Response("{}", { status: 500 }));
  context.after(() => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  }));

  const page = await openActionPage(origin);
  assert.equal(page.response.status, 200);
  assert.equal((page.html.match(/<button\b/g) ?? []).length, 1);
  assert.match(page.html, />リビング照明を消す<\/button>/);
  assert.doesNotMatch(page.html, /name="(?:device|action|parameters)"/);
  assert.match(page.response.headers.get("content-security-policy") ?? "", /form-action 'self'/);
  assert.match(page.html, /操作可能な残り時間/);
  assert.match(page.response.headers.get("content-security-policy") ?? "", /script-src 'nonce-/);
});

test("OFF entry sends the fixed action once and reuses the result on double submit", async (context) => {
  let fetchCount = 0;
  let capturedUrl = "";
  let capturedInit: RequestInit | undefined;
  const { server, origin } = await startEntry(async (url, init) => {
    fetchCount += 1;
    capturedUrl = String(url);
    capturedInit = init;
    return Response.json({
      command_id: "fixed-off-command",
      status: "succeeded",
      device: "light.living_room",
      action: "off",
      adapter: "nature",
    }, { status: 201 });
  });
  context.after(() => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  }));

  const page = await openActionPage(origin);
  const submit = () => fetch(`${origin}/off`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Cookie: page.cookie,
      Origin: origin,
    },
    body: new URLSearchParams({ csrf_token: page.csrfToken }),
  });
  const [first, second] = await Promise.all([submit(), submit()]);

  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(fetchCount, 1);
  assert.equal(capturedUrl, "http://127.0.0.1:8787/api/actions");
  assert.deepEqual(JSON.parse(String(capturedInit?.body)), {
    device: "light.living_room",
    action: "off",
    parameters: {},
  });
  assert.match(String(new Headers(capturedInit?.headers).get("idempotency-key")), /^off-entry-/);
  assert.equal(new Headers(capturedInit?.headers).get("x-action-source"), "local-web");
  assert.match(await first.text(), /消灯要求を受理しました/);
  assert.match(await second.text(), /実機への再送はしていません/);
});

test("OFF entry rejects arbitrary fields and cross-origin submission", async (context) => {
  let fetchCount = 0;
  const { server, origin } = await startEntry(async () => {
    fetchCount += 1;
    return Response.json({ status: "succeeded" }, { status: 201 });
  });
  context.after(() => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  }));

  const page = await openActionPage(origin);
  const headers = {
    "Content-Type": "application/x-www-form-urlencoded",
    Cookie: page.cookie,
    Origin: origin,
  };
  const arbitrary = await fetch(`${origin}/off`, {
    method: "POST",
    headers,
    body: new URLSearchParams({ csrf_token: page.csrfToken, action: "on" }),
  });
  const crossOrigin = await fetch(`${origin}/off`, {
    method: "POST",
    headers: { ...headers, Origin: "http://example.invalid" },
    body: new URLSearchParams({ csrf_token: page.csrfToken }),
  });

  assert.equal(arbitrary.status, 400);
  assert.equal(crossOrigin.status, 403);
  assert.equal(fetchCount, 0);
});

test("OFF entry accepts an opaque Origin only for a same-origin browser navigation", async (context) => {
  let fetchCount = 0;
  const { server, origin } = await startEntry(async () => {
    fetchCount += 1;
    return Response.json({
      command_id: "opaque-origin-off",
      status: "succeeded",
    }, { status: 201 });
  });
  context.after(() => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  }));

  const page = await openActionPage(origin);
  const accepted = await fetch(`${origin}/off`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Cookie: page.cookie,
      Origin: "null",
      Referer: `${origin}/`,
      "Sec-Fetch-Site": "same-origin",
    },
    body: new URLSearchParams({ csrf_token: page.csrfToken }),
  });

  assert.equal(accepted.status, 200);
  assert.equal(fetchCount, 1);
  assert.match(await accepted.text(), /消灯要求を受理しました/);
});

test("OFF entry accepts only one configured HTTPS public origin and sets a Secure cookie", async (context) => {
  let fetchCount = 0;
  const publicOrigin = "https://fixed-test.ngrok-free.app";
  const publicHost = new URL(publicOrigin).host;
  const { server, origin } = await startEntry(async () => {
    fetchCount += 1;
    return Response.json({
      command_id: "public-origin-off",
      status: "succeeded",
    }, { status: 201 });
  }, publicOrigin);
  context.after(() => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  }));

  const pageResponse = await requestWithExactHost(origin, "/", {
    headers: { Host: publicHost },
  });
  const html = pageResponse.body;
  const setCookie = pageResponse.headers["set-cookie"]?.[0] ?? "";
  const cookie = setCookie.split(";", 1)[0];
  const csrfToken = html.match(/name="csrf_token" value="([^"]+)"/)?.[1];
  assert.equal(pageResponse.status, 200);
  assert.match(setCookie, /; Secure(?:;|$)/);
  assert.ok(cookie);
  assert.ok(csrfToken);

  const body = new URLSearchParams({ csrf_token: csrfToken }).toString();
  const accepted = await requestWithExactHost(origin, "/off", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Cookie: cookie,
      Host: publicHost,
      Origin: publicOrigin,
      "Content-Length": String(Buffer.byteLength(body)),
    },
    body,
  });
  assert.equal(accepted.status, 200);
  assert.equal(fetchCount, 1);

  const wrongOrigin = await requestWithExactHost(origin, "/off", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Cookie: cookie,
      Host: publicHost,
      Origin: "https://other.ngrok-free.app",
      "Content-Length": String(Buffer.byteLength(body)),
    },
    body,
  });
  const wrongHost = await requestWithExactHost(origin, "/", {
    headers: { Host: "other.ngrok-free.app" },
  });
  assert.equal(wrongOrigin.status, 403);
  assert.equal(wrongHost.status, 400);
  assert.equal(fetchCount, 1);
});

test("OFF entry rejects public hosts unless an exact valid HTTPS origin is configured", async (context) => {
  const { server, origin } = await startEntry(async () => new Response("{}", { status: 500 }));
  context.after(() => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  }));

  const unconfigured = await requestWithExactHost(origin, "/", {
    headers: { Host: "fixed-test.ngrok-free.app" },
  });
  assert.equal(unconfigured.status, 400);
  assert.throws(
    () => createOffEntryServer({ publicOrigin: "http://fixed-test.ngrok-free.app" }),
    /one exact HTTPS origin/,
  );
  assert.throws(
    () => createOffEntryServer({ publicOrigin: "https://fixed-test.ngrok-free.app/path" }),
    /one exact HTTPS origin/,
  );
});

test("OFF entry permits only one upstream execution across sessions for the same intent", async (context) => {
  let fetchCount = 0;
  const { server, origin } = await startEntry(async () => {
    fetchCount += 1;
    return Response.json({
      command_id: "process-wide-off",
      status: "succeeded",
    }, { status: 201 });
  });
  context.after(() => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  }));

  const firstPage = await openActionPage(origin);
  const secondPage = await openActionPage(origin);
  const [first, second] = await Promise.all([
    submitAction(origin, firstPage),
    submitAction(origin, secondPage),
  ]);
  const refreshed = await fetch(`${origin}/`);
  const refreshedHtml = await refreshed.text();

  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(fetchCount, 1);
  const concurrentBodies = [await first.text(), await second.text()];
  assert.equal(concurrentBodies.filter((body) => body.includes("このページからの実機送信は完了しました")).length, 1);
  assert.equal(concurrentBodies.filter((body) => body.includes("実機への再送はしていません")).length, 1);
  assert.doesNotMatch(refreshedHtml, />リビング照明を消す<\/button>/);
  assert.match(refreshedHtml, />新しい消灯操作を準備する<\/button>/);
  assert.match(refreshedHtml, /実機への再送はしていません/);
});

test("a completed intent can be followed by a new independently one-shot intent", async (context) => {
  let fetchCount = 0;
  const idempotencyKeys: string[] = [];
  const { server, origin } = await startEntry(async (_url, init) => {
    fetchCount += 1;
    idempotencyKeys.push(String(new Headers(init?.headers).get("idempotency-key")));
    return Response.json({
      command_id: `intent-command-${fetchCount}`,
      status: "succeeded",
    }, { status: 201 });
  });
  context.after(() => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  }));

  const firstIntentPage = await openActionPage(origin);
  await submitAction(origin, firstIntentPage);
  await submitAction(origin, firstIntentPage);
  assert.equal(fetchCount, 1);

  const nextRequestId = server.createIntent();
  assert.match(nextRequestId, /^[0-9a-f-]{36}$/);
  const secondIntentPage = await openActionPage(origin);
  const [secondIntentFirstClick, secondIntentSecondClick] = await Promise.all([
    submitAction(origin, secondIntentPage),
    submitAction(origin, secondIntentPage),
  ]);

  assert.equal(secondIntentFirstClick.status, 200);
  assert.equal(secondIntentSecondClick.status, 200);
  assert.equal(fetchCount, 2);
  assert.equal(new Set(idempotencyKeys).size, 2);

  await submitAction(origin, firstIntentPage);
  assert.equal(fetchCount, 2);
});

test("local control endpoint issues a new intent only after completion", async (context) => {
  let fetchCount = 0;
  const { server, origin } = await startEntry(async () => {
    fetchCount += 1;
    return Response.json({ status: "succeeded" }, { status: 201 });
  });
  const controlServer = createIntentControlServer(server);
  await new Promise<void>((resolve) => controlServer.listen(0, "127.0.0.1", resolve));
  const controlAddress = controlServer.address() as AddressInfo;
  const controlOrigin = `http://127.0.0.1:${controlAddress.port}`;
  context.after(async () => {
    await Promise.all([
      new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
      new Promise<void>((resolve, reject) => controlServer.close((error) => error ? reject(error) : resolve())),
    ]);
  });

  const beforeCompletion = await fetch(`${controlOrigin}/intents`, {
    method: "POST",
    headers: { "X-Intent-Request": "new-light-off" },
  });
  assert.equal(beforeCompletion.status, 409);

  const page = await openActionPage(origin);
  await submitAction(origin, page);
  assert.equal(fetchCount, 1);

  const browserAttempt = await fetch(`${controlOrigin}/intents`, {
    method: "POST",
    headers: {
      "X-Intent-Request": "new-light-off",
      Origin: "http://example.invalid",
    },
  });
  assert.equal(browserAttempt.status, 403);

  const issued = await fetch(`${controlOrigin}/intents`, {
    method: "POST",
    headers: { "X-Intent-Request": "new-light-off" },
  });
  assert.equal(issued.status, 201);
  assert.match((await issued.json()).request_id, /^[0-9a-f-]{36}$/);

  const nextPage = await openActionPage(origin);
  assert.match(nextPage.html, /<button\b/);
});

test("OFF entry records an unknown result in-session and never retries it", async (context) => {
  let fetchCount = 0;
  const { server, origin } = await startEntry(async () => {
    fetchCount += 1;
    return Response.json({ error: "safe failure", outcome: "unknown" }, { status: 502 });
  });
  context.after(() => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  }));

  const page = await openActionPage(origin);
  const request = {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Cookie: page.cookie,
      Origin: origin,
    },
    body: new URLSearchParams({ csrf_token: page.csrfToken }),
  };
  const first = await fetch(`${origin}/off`, request);
  const second = await fetch(`${origin}/off`, request);

  assert.equal(fetchCount, 1);
  assert.match(await first.text(), /自動再送はしません/);
  assert.match(await second.text(), /自動再送はしません/);
});

test("expired UI session disables execution server-side and renders a recovery page", async (context) => {
  let timestamp = 1_000;
  let fetchCount = 0;
  const { server, origin } = await startEntry(async () => {
    fetchCount += 1;
    return Response.json({ status: "succeeded" }, { status: 201 });
  }, undefined, () => timestamp);
  context.after(() => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  }));

  const page = await openActionPage(origin);
  timestamp += SESSION_TTL_MS + 1;
  const expired = await submitAction(origin, page);

  assert.equal(expired.status, 403);
  assert.match(await expired.text(), /操作ページの期限が切れました/);
  assert.equal(fetchCount, 0);
});

test("authenticated AI HTTP contract executes only the active allowlisted action once", async (context) => {
  let fetchCount = 0;
  let source = "";
  const { server, origin } = await startEntry(async (_url, init) => {
    fetchCount += 1;
    source = String(new Headers(init?.headers).get("x-action-source"));
    return Response.json({ command_id: "ai-command", status: "succeeded" }, { status: 201 });
  });
  context.after(() => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  }));

  const sessionResponse = await fetch(`${origin}/api/session`);
  const cookie = sessionResponse.headers.get("set-cookie")?.split(";", 1)[0];
  const session = await sessionResponse.json();
  assert.ok(cookie);
  assert.deepEqual(session.allowed_actions, ["light.living_room.off"]);

  const request = {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: cookie,
      "X-CSRF-Token": session.csrf_token,
    },
    body: JSON.stringify({
      request_id: session.request_id,
      action_id: "light.living_room.off",
      parameters: {},
    }),
  };
  const first = await fetch(`${origin}/api/actions`, request);
  const second = await fetch(`${origin}/api/actions`, request);

  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal((await first.json()).status, "succeeded");
  assert.equal((await second.json()).replayed, true);
  assert.equal(fetchCount, 1);
  assert.equal(source, "ai-client");
});

test("AI HTTP contract rejects unregistered actions before the Core", async (context) => {
  let fetchCount = 0;
  const { server, origin } = await startEntry(async () => {
    fetchCount += 1;
    return Response.json({ status: "succeeded" }, { status: 201 });
  });
  context.after(() => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  }));

  const sessionResponse = await fetch(`${origin}/api/session`);
  const cookie = sessionResponse.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
  const session = await sessionResponse.json();
  const rejected = await fetch(`${origin}/api/actions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: cookie,
      "X-CSRF-Token": session.csrf_token,
    },
    body: JSON.stringify({ request_id: session.request_id, action_id: "light.living_room.on", parameters: {} }),
  });

  assert.equal(rejected.status, 400);
  assert.equal(fetchCount, 0);
});

test("Core outage is unknown and the same intent is never retried", async (context) => {
  let fetchCount = 0;
  const { server, origin } = await startEntry(async () => {
    fetchCount += 1;
    throw new TypeError("core unavailable");
  });
  context.after(() => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  }));

  const page = await openActionPage(origin);
  const first = await submitAction(origin, page);
  const second = await submitAction(origin, page);

  assert.match(await first.text(), /結果を確認できません/);
  assert.match(await second.text(), /自動再送はしません/);
  assert.equal(fetchCount, 1);
});

test("result page can prepare a fresh intent without operating the device", async (context) => {
  let fetchCount = 0;
  const { server, origin } = await startEntry(async () => {
    fetchCount += 1;
    return Response.json({ command_id: "first-command", status: "succeeded" }, { status: 201 });
  });
  context.after(() => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  }));

  const page = await openActionPage(origin);
  const result = await submitAction(origin, page);
  const resultHtml = await result.text();
  const resultCsrf = resultHtml.match(/name="csrf_token" value="([^"]+)"/)?.[1];
  assert.ok(resultCsrf);

  const prepared = await fetch(`${origin}/intent`, {
    method: "POST",
    redirect: "manual",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Cookie: page.cookie,
      Origin: origin,
    },
    body: new URLSearchParams({ csrf_token: resultCsrf, action_id: "light.living_room.off" }),
  });
  assert.equal(prepared.status, 303);
  assert.equal(fetchCount, 1);

  const nextPage = await openActionPage(origin);
  assert.match(nextPage.html, />リビング照明を消す<\/button>/);
  assert.equal(fetchCount, 1);
});

test("direct AI path rejects unauthenticated traffic before Core and proxies authenticated reads only", async (context) => {
  const key = "gateway-test-key-1234567890-abcdef";
  const authenticator = new ClientAuthenticator([{ id: "integration-test", key_sha256: createHash("sha256").update(key).digest("hex"), enabled: true }]);
  let fetchCount = 0; let capturedUrl = ""; let capturedAuthorization = "";
  const accessLog = new MemoryAiAccessLog();
  const { server, origin } = await startEntry(async (url, init) => {
    fetchCount += 1; capturedUrl = String(url); capturedAuthorization = new Headers(init?.headers).get("Authorization") ?? "";
    return Response.json({ schema_version: "1.0", devices: [] });
  }, undefined, undefined, authenticator, accessLog);
  context.after(() => new Promise<void>((resolve) => server.close(() => resolve())));

  const denied = await fetch(`${origin}/ai/v1/capabilities`);
  assert.equal(denied.status, 401); assert.equal(fetchCount, 0);
  const accepted = await fetch(`${origin}/ai/v1/capabilities`, { headers: { Authorization: `Bearer ${key}` } });
  assert.equal(accepted.status, 200); assert.equal(fetchCount, 1);
  assert.equal(capturedUrl, "http://127.0.0.1:8787/api/v1/capabilities");
  assert.equal(capturedAuthorization, `Bearer ${key}`);
  assert.doesNotMatch(await accepted.text(), /gateway-test-key/);
  assert.deepEqual(accessLog.entries.map(({ client_id, method, path, phase, status, auth_header, auth_scheme, auth_header_length, credential_length }) => ({ client_id, method, path, phase, status, auth_header, auth_scheme, auth_header_length, credential_length })), [
    { client_id: null, method: "GET", path: "/ai/v1/capabilities", phase: "result", status: 401, auth_header: "missing", auth_scheme: null, auth_header_length: null, credential_length: null },
    { client_id: "integration-test", method: "GET", path: "/ai/v1/capabilities", phase: "attempt", status: null, auth_header: "bearer", auth_scheme: "bearer", auth_header_length: key.length + 7, credential_length: key.length },
    { client_id: "integration-test", method: "GET", path: "/ai/v1/capabilities", phase: "result", status: 200, auth_header: "bearer", auth_scheme: "bearer", auth_header_length: key.length + 7, credential_length: key.length },
  ]);
  assert.doesNotMatch(JSON.stringify(accessLog.entries), /gateway-test-key/);
});

test("direct AI path rejects before Core when the attempt audit cannot be written and stays alive", async (context) => {
  const key = "gateway-test-key-1234567890-abcdef";
  const authenticator = new ClientAuthenticator([{ id: "integration-test", key_sha256: createHash("sha256").update(key).digest("hex"), enabled: true }]);
  let fetchCount = 0;
  let appendCount = 0;
  const entries: AiAccessLogEntry[] = [];
  const accessLog: AiAccessLogWriter = {
    async append(entry) {
      appendCount += 1;
      if (appendCount === 1) throw new Error("simulated audit failure");
      entries.push(structuredClone(entry));
    },
  };
  const { server, origin } = await startEntry(async () => {
    fetchCount += 1;
    return Response.json({ schema_version: "1.0", devices: [] });
  }, undefined, undefined, authenticator, accessLog);
  context.after(() => new Promise<void>((resolve) => server.close(() => resolve())));

  const failed = await fetch(`${origin}/ai/v1/capabilities`, { headers: { Authorization: `Bearer ${key}` } });
  assert.equal(failed.status, 503);
  assert.deepEqual(await failed.json(), { error: "audit unavailable" });
  assert.equal(fetchCount, 0);

  const recovered = await fetch(`${origin}/ai/v1/capabilities`, { headers: { Authorization: `Bearer ${key}` } });
  assert.equal(recovered.status, 200);
  assert.equal(fetchCount, 1);
  assert.deepEqual(entries.map(({ phase, status }) => ({ phase, status })), [
    { phase: "attempt", status: null },
    { phase: "result", status: 200 },
  ]);
});

test("direct AI path returns 503 when the result audit fails and stays alive", async (context) => {
  const key = "gateway-test-key-1234567890-abcdef";
  const authenticator = new ClientAuthenticator([{ id: "integration-test", key_sha256: createHash("sha256").update(key).digest("hex"), enabled: true }]);
  let fetchCount = 0;
  let appendCount = 0;
  const accessLog: AiAccessLogWriter = {
    async append() {
      appendCount += 1;
      if (appendCount === 2) throw new Error("simulated result audit failure");
    },
  };
  const { server, origin } = await startEntry(async () => {
    fetchCount += 1;
    return Response.json({ schema_version: "1.0", devices: [] });
  }, undefined, undefined, authenticator, accessLog);
  context.after(() => new Promise<void>((resolve) => server.close(() => resolve())));

  const failed = await fetch(`${origin}/ai/v1/capabilities`, { headers: { Authorization: `Bearer ${key}` } });
  assert.equal(failed.status, 503);
  assert.deepEqual(await failed.json(), { error: "audit unavailable" });
  assert.equal(fetchCount, 1);

  const recovered = await fetch(`${origin}/ai/v1/capabilities`, { headers: { Authorization: `Bearer ${key}` } });
  assert.equal(recovered.status, 200);
  assert.equal(fetchCount, 2);
});
