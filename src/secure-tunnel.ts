import { isAbsolute, resolve } from "node:path";

export type SecureMcpTunnelConfig = {
  binary: string;
  profileFile: string;
  healthUrl: string;
};

export function parseSecureMcpTunnelConfig(value: unknown, root: string): SecureMcpTunnelConfig {
  const input = object(value);
  if (!input || typeof input.binary !== "string" || typeof input.profileFile !== "string" || typeof input.healthUrl !== "string") {
    throw new Error("Secure MCP Tunnel runtime configuration is incomplete");
  }
  const health = new URL(input.healthUrl);
  if (health.protocol !== "http:" || health.hostname !== "127.0.0.1" || health.origin !== input.healthUrl) {
    throw new Error("Secure MCP Tunnel health URL must be one exact loopback HTTP origin");
  }
  return {
    binary: absolute(input.binary, root),
    profileFile: absolute(input.profileFile, root),
    healthUrl: input.healthUrl,
  };
}

export function tunnelHealthReady(health: unknown, ready: unknown): boolean {
  return String(health).trim().toLowerCase() === "live" && String(ready).trim().toLowerCase() === "ready";
}

function absolute(path: string, root: string): string {
  return isAbsolute(path) ? path : resolve(root, path);
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
