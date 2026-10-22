import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type Server, type ServerResponse } from "node:http";
import { createRemoteJWKSet, jwtVerify } from "jose";

const GOOGLE_AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const GOOGLE_JWKS = createRemoteJWKSet(new URL("https://www.googleapis.com/oauth2/v3/certs"));

export const GOOGLE_SUB_DISCOVERY_HOST = "127.0.0.1";
export const GOOGLE_SUB_DISCOVERY_PORT = 8795;
export const GOOGLE_SUB_DISCOVERY_PATH = "/oauth/google/sub-callback";
export const GOOGLE_SUB_DISCOVERY_REDIRECT_URI = `http://${GOOGLE_SUB_DISCOVERY_HOST}:${GOOGLE_SUB_DISCOVERY_PORT}${GOOGLE_SUB_DISCOVERY_PATH}`;

type ExchangeCode = (code: string, nonce: string, verifier: string) => Promise<string>;

type DiscoveryOptions = {
  clientId: string;
  clientSecret: string;
  redirectUri?: string;
  exchangeCode?: ExchangeCode;
};

export type GoogleSubDiscoverySession = {
  server: Server;
  authorizationUrl: string;
};

export function createGoogleSubDiscoverySession(options: DiscoveryOptions): GoogleSubDiscoverySession {
  const redirectUri = options.redirectUri ?? GOOGLE_SUB_DISCOVERY_REDIRECT_URI;
  const state = randomBytes(32).toString("base64url");
  const nonce = randomBytes(32).toString("base64url");
  const verifier = randomBytes(48).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const resultTicket = randomBytes(32).toString("base64url");
  const exchangeCode = options.exchangeCode ?? ((code, expectedNonce, expectedVerifier) => exchangeGoogleCode(
    code, expectedNonce, expectedVerifier, options.clientId, options.clientSecret, redirectUri,
  ));
  let verifiedSub: string | undefined;
  let resultShown = false;

  const authorizationUrl = new URL(GOOGLE_AUTH_ENDPOINT);
  authorizationUrl.search = new URLSearchParams({
    client_id: options.clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "openid",
    prompt: "select_account",
    state,
    nonce,
    code_challenge: challenge,
    code_challenge_method: "S256",
  }).toString();

  const server = createServer(async (request, response) => {
    setLocalSecurityHeaders(response);
    if (!localHostHeader(request.headers.host)) return sendLocalPage(response, 400, "この画面はlocalhost専用です。", "");
    const url = new URL(request.url ?? "/", `http://${GOOGLE_SUB_DISCOVERY_HOST}`);

    if (request.method === "GET" && url.pathname === GOOGLE_SUB_DISCOVERY_PATH) {
      if (!safeEqual(url.searchParams.get("state") ?? "", state) || !safeOpaque(url.searchParams.get("code") ?? "")) {
        return sendLocalPage(response, 400, "Google認証を確認できませんでした。", "もう一度コマンドからやり直してください。");
      }
      try {
        verifiedSub = await exchangeCode(url.searchParams.get("code")!, nonce, verifier);
        if (!safeOpaque(verifiedSub, 1, 255)) throw new Error("invalid sub");
      } catch {
        verifiedSub = undefined;
        return sendLocalPage(response, 502, "Google認証を確認できませんでした。", "値は保存していません。コマンドを終了してやり直してください。");
      }
      response.writeHead(303, { Location: `/result?ticket=${encodeURIComponent(resultTicket)}` });
      return response.end();
    }

    if (request.method === "GET" && url.pathname === "/result" && verifiedSub && !resultShown && safeEqual(url.searchParams.get("ticket") ?? "", resultTicket)) {
      resultShown = true;
      const sub = verifiedSub;
      verifiedSub = undefined;
      sendLocalPage(response, 200, "許可するGoogleアカウントの sub", `この値をローカル設定の allowedGoogleSub に貼り付けてください。チャットには貼らないでください。`, sub);
      return setImmediate(() => server.close());
    }

    return sendLocalPage(response, 404, "表示できません。", "コマンドからGoogleログインを開始してください。");
  });

  return { server, authorizationUrl: authorizationUrl.href };
}

async function exchangeGoogleCode(code: string, nonce: string, verifier: string, clientId: string, clientSecret: string, redirectUri: string): Promise<string> {
  const response = await fetch(GOOGLE_TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      code_verifier: verifier,
      grant_type: "authorization_code",
      redirect_uri: redirectUri,
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error("Google authorization code exchange failed");
  const tokens = object(await response.json());
  if (!tokens || typeof tokens.id_token !== "string") throw new Error("Google identity token is missing");
  const verified = await jwtVerify(tokens.id_token, GOOGLE_JWKS, {
    audience: clientId,
    issuer: ["https://accounts.google.com", "accounts.google.com"],
  });
  if (verified.payload.nonce !== nonce || typeof verified.payload.sub !== "string") throw new Error("Google identity verification failed");
  return verified.payload.sub;
}

function localHostHeader(host: string | undefined): boolean {
  return host === `${GOOGLE_SUB_DISCOVERY_HOST}:${GOOGLE_SUB_DISCOVERY_PORT}` || /^127\.0\.0\.1:\d+$/.test(host ?? "");
}

function safeOpaque(value: string, min = 8, max = 2_048): boolean {
  return value.length >= min && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);
}

function safeEqual(leftValue: string, rightValue: string): boolean {
  const left = Buffer.from(leftValue); const right = Buffer.from(rightValue);
  return left.length === right.length && timingSafeEqual(left, right);
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function setLocalSecurityHeaders(response: ServerResponse): void {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
}

function sendLocalPage(response: ServerResponse, status: number, title: string, detail: string, sub?: string): void {
  const value = sub ? `<output>${escapeHtml(sub)}</output>` : "";
  response.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
  response.end(`<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>${PAGE_STYLE}</style></head><body><main><h1>${escapeHtml(title)}</h1><p>${escapeHtml(detail)}</p>${value}<p>この一時サーバーは表示後に自動終了します。</p></main></body></html>`);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" })[character]!);
}

const PAGE_STYLE = ":root{font-family:system-ui,sans-serif;color-scheme:light}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f4f1ea;color:#17202a}main{width:min(38rem,calc(100% - 2rem));box-sizing:border-box;background:white;padding:2rem;border-radius:1rem;box-shadow:0 .5rem 2rem #0002}output{display:block;overflow-wrap:anywhere;margin:1.5rem 0;padding:1rem;border:2px solid #243447;border-radius:.7rem;font:700 1.1rem ui-monospace,monospace;background:#f6f8fa}";
