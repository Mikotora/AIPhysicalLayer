import type { AdapterMode } from "./registry.ts";
import { readFileSync } from "node:fs";

export type NatureBindings = {
  version: 1;
  appliances: Record<string, string>;
  signals: Record<string, string>;
};

export type NatureConfig = {
  accessToken: string;
  bindings: NatureBindings;
};

export type AppConfig =
  | { mode: "mock"; nature: null; aiClientKeysFile?: string }
  | { mode: "nature"; nature: NatureConfig; aiClientKeysFile?: string };

export class ConfigurationError extends Error {
  readonly statusCode = 500;
}

export function readAppConfig(environment: NodeJS.ProcessEnv = process.env): AppConfig {
  const mode = (environment.ADAPTER_MODE ?? "mock") as AdapterMode;
  if (mode !== "mock" && mode !== "nature") {
    throw new ConfigurationError("ADAPTER_MODE must be mock or nature");
  }
  if (mode === "mock") {
    return { mode, nature: null, ...(environment.AI_CLIENT_KEYS_FILE?.trim() ? { aiClientKeysFile: environment.AI_CLIENT_KEYS_FILE.trim() } : {}) };
  }

  const names = [
    "NATURE_ACCESS_TOKEN",
    "NATURE_BINDINGS_FILE",
  ] as const;
  const missing = names.filter((name) => !environment[name]?.trim());
  if (missing.length > 0) {
    throw new ConfigurationError(`missing Nature configuration: ${missing.join(", ")}`);
  }

  return {
    mode,
    nature: {
      accessToken: environment.NATURE_ACCESS_TOKEN!.trim(),
      bindings: readNatureBindings(environment.NATURE_BINDINGS_FILE!.trim()),
    },
    ...(environment.AI_CLIENT_KEYS_FILE?.trim() ? { aiClientKeysFile: environment.AI_CLIENT_KEYS_FILE.trim() } : {}),
  };
}

function readNatureBindings(path: string): NatureBindings {
  let value: unknown;
  try { value = JSON.parse(readFileSync(path, "utf8")); }
  catch { throw new ConfigurationError("Nature binding configuration could not be read"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ConfigurationError("Nature binding configuration is invalid");
  const item = value as Record<string, unknown>;
  if (item.version !== 1 || !isStringMap(item.appliances) || !isStringMap(item.signals)) throw new ConfigurationError("Nature binding configuration is invalid");
  return { version: 1, appliances: { ...item.appliances }, signals: { ...item.signals } };
}

function isStringMap(value: unknown): value is Record<string, string> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value) && Object.values(value as Record<string, unknown>).every((item) => typeof item === "string" && item.length > 0));
}
