import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export type GatewayConfig = {
  publicOrigin: string;
  allowedGoogleSub: string;
  googleClientId: string;
  bootstrapApprovedRedirectUris: string[];
  accessTokenTtlSeconds: number;
  refreshTokenTtlSeconds: number;
  authorizationCodeTtlSeconds: number;
  pendingClientTtlSeconds: number;
  maxClients: number;
  maxPendingClients: number;
  registrationRateLimitPerHour: number;
  oauthRateLimitPerMinute: number;
  keychainService: string;
  googleClientSecretAccount: string;
  googleRefreshTokenAccount: string;
  databaseFile: string;
  auditLogFile: string;
  coreTokenFile: string;
};

type JsonObject = Record<string, unknown>;

export function readGatewayConfig(environment: NodeJS.ProcessEnv = process.env): GatewayConfig {
  const configFile = environment.REMOTE_MCP_CONFIG_FILE;
  const publicOrigin = environment.REMOTE_MCP_PUBLIC_ORIGIN;
  const databaseFile = environment.REMOTE_MCP_DATABASE_FILE;
  const auditLogFile = environment.REMOTE_MCP_AUDIT_LOG_FILE;
  const coreTokenFile = environment.REMOTE_MCP_CORE_TOKEN_FILE;
  if (!configFile || !publicOrigin || !databaseFile || !auditLogFile || !coreTokenFile) {
    throw new Error("remote MCP gateway runtime configuration is incomplete");
  }
  const value = object(JSON.parse(readFileSync(configFile, "utf8")));
  if (!value) throw new Error("remote MCP gateway configuration must be an object");
  const origin = exactHttpsOrigin(publicOrigin, "REMOTE_MCP_PUBLIC_ORIGIN");
  const legacyRedirects = value.allowedRedirectUris === undefined ? [] : stringArray(value.allowedRedirectUris, "allowedRedirectUris");
  const configuredRedirects = value.bootstrapApprovedRedirectUris === undefined
    ? legacyRedirects
    : stringArray(value.bootstrapApprovedRedirectUris, "bootstrapApprovedRedirectUris");
  const bootstrapApprovedRedirectUris = configuredRedirects.map((uri) => exactHttpsUrl(uri, "bootstrapApprovedRedirectUris"));
  return {
    publicOrigin: origin,
    allowedGoogleSub: requiredString(value.allowedGoogleSub, "allowedGoogleSub", 6, 255),
    googleClientId: requiredString(value.googleClientId, "googleClientId", 6, 512),
    bootstrapApprovedRedirectUris: unique(bootstrapApprovedRedirectUris),
    accessTokenTtlSeconds: integer(value.accessTokenTtlSeconds, "accessTokenTtlSeconds", 300, 86_400),
    refreshTokenTtlSeconds: integer(value.refreshTokenTtlSeconds, "refreshTokenTtlSeconds", 3_600, 180 * 86_400),
    authorizationCodeTtlSeconds: integer(value.authorizationCodeTtlSeconds, "authorizationCodeTtlSeconds", 30, 900),
    pendingClientTtlSeconds: integer(value.pendingClientTtlSeconds, "pendingClientTtlSeconds", 300, 86_400),
    maxClients: integer(value.maxClients, "maxClients", 1, 100),
    maxPendingClients: value.maxPendingClients === undefined
      ? integer(value.maxClients, "maxClients", 1, 100)
      : integer(value.maxPendingClients, "maxPendingClients", 1, 100),
    registrationRateLimitPerHour: integer(value.registrationRateLimitPerHour, "registrationRateLimitPerHour", 1, 1_000),
    oauthRateLimitPerMinute: integer(value.oauthRateLimitPerMinute, "oauthRateLimitPerMinute", 1, 1_000),
    keychainService: requiredString(value.keychainService, "keychainService", 3, 128),
    googleClientSecretAccount: requiredString(value.googleClientSecretAccount, "googleClientSecretAccount", 3, 128),
    googleRefreshTokenAccount: requiredString(value.googleRefreshTokenAccount, "googleRefreshTokenAccount", 3, 128),
    databaseFile: resolve(databaseFile),
    auditLogFile: resolve(auditLogFile),
    coreTokenFile: resolve(coreTokenFile),
  };
}

function object(value: unknown): JsonObject | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : undefined;
}

function requiredString(value: unknown, name: string, min: number, max: number): string {
  if (typeof value !== "string" || value.length < min || value.length > max) throw new Error(`${name} is invalid`);
  return value;
}

function stringArray(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw new Error(`${name} must be a string array`);
  return value as string[];
}

function integer(value: unknown, name: string, min: number, max: number): number {
  if (!Number.isInteger(value) || Number(value) < min || Number(value) > max) throw new Error(`${name} is outside its safe range`);
  return Number(value);
}

function exactHttpsOrigin(value: string, name: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash || url.origin !== value) {
    throw new Error(`${name} must be one exact HTTPS origin`);
  }
  return url.origin;
}

function exactHttpsUrl(value: string, name: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.hash || url.href !== value) throw new Error(`${name} contains an invalid HTTPS URL`);
  return url.href;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
