import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { randomBytes } from "node:crypto";

type JsonObject = Record<string, unknown>;

export type DoorConfigurationInput = {
  googleClientId: string;
  allowedGoogleSub: string;
  enabled: boolean;
};

export type PreparedDoorConfiguration = {
  gateway: JsonObject;
  runtime: JsonObject;
};

const DEFAULT_RUNTIME_BLOCK = {
  enabled: false,
  configFile: "remote-mcp-gateway/config/remote-mcp-gateway.json",
  coreTokenFile: ".runtime/secrets/remote-mcp-gateway.key",
  databaseFile: "data/remote-mcp-gateway.sqlite",
  auditLogFile: "data/remote-mcp-access.jsonl",
} as const;

export function prepareDoorConfiguration(gatewayValue: unknown, runtimeValue: unknown, input: DoorConfigurationInput): PreparedDoorConfiguration {
  const gateway = object(gatewayValue, "remote-mcp-gateway.json");
  const runtime = object(runtimeValue, "runtime.json");
  const googleClientId = privateIdentifier(input.googleClientId, "Google OAuth client ID", 6, 512);
  const allowedGoogleSub = privateIdentifier(input.allowedGoogleSub, "Google sub", 6, 255);
  const currentBlock = gatewayObject(runtime.remoteMcpGateway);
  return {
    gateway: { ...gateway, googleClientId, allowedGoogleSub },
    runtime: {
      ...runtime,
      remoteMcpGateway: { ...DEFAULT_RUNTIME_BLOCK, ...currentBlock, enabled: input.enabled },
    },
  };
}

export function backupAndWriteDoorConfiguration(
  gatewayPath: string,
  runtimePath: string,
  backupDirectory: string,
  prepared: PreparedDoorConfiguration,
  timestamp = new Date(),
): { gatewayBackup: string; runtimeBackup: string } {
  if (!existsSync(gatewayPath)) throw new Error("remote-mcp-gateway.json does not exist");
  if (!existsSync(runtimePath)) throw new Error("runtime.json does not exist");
  const oldGateway = readFileSync(gatewayPath);
  const oldRuntime = readFileSync(runtimePath);
  const newGateway = jsonBytes(prepared.gateway);
  const newRuntime = jsonBytes(prepared.runtime);
  const stamp = timestamp.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  mkdirSync(backupDirectory, { recursive: true, mode: 0o700 });
  chmodSync(backupDirectory, 0o700);
  const gatewayBackup = join(backupDirectory, `${basename(gatewayPath, ".json")}-${stamp}.json`);
  const runtimeBackup = join(backupDirectory, `${basename(runtimePath, ".json")}-${stamp}.json`);
  writeFileSync(gatewayBackup, oldGateway, { flag: "wx", mode: 0o600 });
  writeFileSync(runtimeBackup, oldRuntime, { flag: "wx", mode: 0o600 });
  chmodSync(gatewayBackup, 0o600); chmodSync(runtimeBackup, 0o600);

  const suffix = `${process.pid}-${randomBytes(6).toString("hex")}`;
  const gatewayTemporary = join(dirname(gatewayPath), `.${basename(gatewayPath)}.${suffix}.tmp`);
  const runtimeTemporary = join(dirname(runtimePath), `.${basename(runtimePath)}.${suffix}.tmp`);
  try {
    writeFileSync(gatewayTemporary, newGateway, { flag: "wx", mode: 0o600 });
    writeFileSync(runtimeTemporary, newRuntime, { flag: "wx", mode: 0o600 });
    JSON.parse(readFileSync(gatewayTemporary, "utf8"));
    JSON.parse(readFileSync(runtimeTemporary, "utf8"));
    renameSync(gatewayTemporary, gatewayPath);
    try { renameSync(runtimeTemporary, runtimePath); }
    catch (error) {
      copyFileSync(gatewayBackup, gatewayPath); chmodSync(gatewayPath, 0o600);
      throw error;
    }
    chmodSync(gatewayPath, 0o600); chmodSync(runtimePath, 0o600);
  } catch (error) {
    if (existsSync(runtimeTemporary)) rmSync(runtimeTemporary);
    if (existsSync(gatewayTemporary)) rmSync(gatewayTemporary);
    throw error;
  }
  return { gatewayBackup, runtimeBackup };
}

function jsonBytes(value: JsonObject): Buffer {
  const text = JSON.stringify(value, null, 2) + "\n";
  JSON.parse(text);
  return Buffer.from(text);
}

function privateIdentifier(value: string, name: string, min: number, max: number): string {
  if (value.length < min || value.length > max || /[\s\u0000-\u001f\u007f]/.test(value) || value.startsWith("replace-with-")) {
    throw new Error(`${name} is invalid`);
  }
  return value;
}

function object(value: unknown, name: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must contain one JSON object`);
  return structuredClone(value) as JsonObject;
}

function gatewayObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? structuredClone(value) as JsonObject : {};
}
