import { createRemoteJWKSet, jwtVerify } from "jose";
import type { GatewayConfig } from "./config.ts";
import type { SecretStore } from "./keychain.ts";

const GOOGLE_AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const GOOGLE_JWKS = createRemoteJWKSet(new URL("https://www.googleapis.com/oauth2/v3/certs"));

export type GoogleIdentity = { sub: string; refreshToken?: string };
export type MasterSwitchResult = "alive" | "revoked" | "unknown";

export interface GoogleIdentityProvider {
  authorizationUrl(state: string, nonce: string): string;
  exchangeCode(code: string, nonce: string): Promise<GoogleIdentity>;
  acceptIdentity(identity: GoogleIdentity): void;
  checkMasterSwitch(): Promise<MasterSwitchResult>;
}

export class GoogleOAuthClient implements GoogleIdentityProvider {
  readonly config: GatewayConfig;
  readonly secrets: SecretStore;
  readonly fetchImpl: typeof fetch;
  constructor(config: GatewayConfig, secrets: SecretStore, fetchImpl: typeof fetch = fetch) {
    this.config = config; this.secrets = secrets; this.fetchImpl = fetchImpl;
  }

  authorizationUrl(state: string, nonce: string): string {
    const url = new URL(GOOGLE_AUTH_ENDPOINT);
    url.search = new URLSearchParams({
      client_id: this.config.googleClientId,
      redirect_uri: `${this.config.publicOrigin}/oauth/google/callback`,
      response_type: "code",
      scope: "openid email",
      access_type: "offline",
      prompt: "consent",
      include_granted_scopes: "true",
      state,
      nonce,
    }).toString();
    return url.href;
  }

  async exchangeCode(code: string, nonce: string): Promise<GoogleIdentity> {
    const clientSecret = this.requiredSecret(this.config.googleClientSecretAccount);
    const response = await this.fetchImpl(GOOGLE_TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: this.config.googleClientId,
        client_secret: clientSecret,
        code,
        grant_type: "authorization_code",
        redirect_uri: `${this.config.publicOrigin}/oauth/google/callback`,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error("Google authorization code exchange failed");
    const tokens = object(await response.json());
    if (!tokens || typeof tokens.id_token !== "string") throw new Error("Google identity token is missing");
    const verified = await jwtVerify(tokens.id_token, GOOGLE_JWKS, {
      audience: this.config.googleClientId,
      issuer: ["https://accounts.google.com", "accounts.google.com"],
    });
    if (verified.payload.nonce !== nonce || typeof verified.payload.sub !== "string") throw new Error("Google identity verification failed");
    const refreshToken = tokens.refresh_token;
    if (refreshToken !== undefined && (typeof refreshToken !== "string" || !refreshToken)) throw new Error("Google refresh token is invalid");
    if (!refreshToken && !this.secrets.get(this.config.googleRefreshTokenAccount)) throw new Error("Google refresh token was not issued");
    return { sub: verified.payload.sub, ...(typeof refreshToken === "string" ? { refreshToken } : {}) };
  }

  acceptIdentity(identity: GoogleIdentity): void {
    if (identity.sub !== this.config.allowedGoogleSub) throw new Error("refusing to store a refresh token for an unapproved Google identity");
    if (identity.refreshToken) this.secrets.set(this.config.googleRefreshTokenAccount, identity.refreshToken);
  }

  async checkMasterSwitch(): Promise<MasterSwitchResult> {
    const refreshToken = this.secrets.get(this.config.googleRefreshTokenAccount);
    const clientSecret = this.secrets.get(this.config.googleClientSecretAccount);
    if (!refreshToken || !clientSecret) return "revoked";
    let response: Response;
    try {
      response = await this.fetchImpl(GOOGLE_TOKEN_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: this.config.googleClientId,
          client_secret: clientSecret,
          grant_type: "refresh_token",
          refresh_token: refreshToken,
        }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch { return "unknown"; }
    if (response.ok) {
      const value = object(await response.json().catch(() => undefined));
      if (typeof value?.refresh_token === "string" && value.refresh_token) this.secrets.set(this.config.googleRefreshTokenAccount, value.refresh_token);
      return "alive";
    }
    if (response.status === 400 || response.status === 401) {
      const value = object(await response.json().catch(() => undefined));
      return value?.error === "invalid_grant" ? "revoked" : "unknown";
    }
    return "unknown";
  }

  private requiredSecret(account: string): string {
    const value = this.secrets.get(account);
    if (!value) throw new Error("Google OAuth secret is unavailable");
    return value;
  }
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
