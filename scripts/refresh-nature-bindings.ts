import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { findActionDefinition } from "../src/action-catalog.ts";
import { NATURE_BINDING_BOOTSTRAP, NATURE_SIGNAL_NAMES } from "../src/nature-profiles.ts";
import type { NatureBindings } from "../src/config.ts";

const token = process.env.NATURE_ACCESS_TOKEN?.trim();
const outputPath = resolve(process.argv[2] ?? "config/nature-bindings.json");
if (!token) throw new Error("NATURE_ACCESS_TOKEN is required");
const headers = { Authorization: `Bearer ${token}` };
const existing = readExisting(outputPath);
const applianceResponse = await fetch("https://api.nature.global/1/appliances", { headers, signal: AbortSignal.timeout(15_000) });
if (!applianceResponse.ok) throw new Error(`Nature appliance discovery failed (HTTP ${applianceResponse.status})`);
const appliances = await applianceResponse.json() as Array<Record<string, any>>;
const bindings: NatureBindings = { version: 1, appliances: {}, signals: {} };

for (const [deviceId, hint] of Object.entries(NATURE_BINDING_BOOTSTRAP)) {
  const priorId = existing?.appliances[deviceId];
  const candidates = priorId
    ? appliances.filter((item) => item.id === priorId)
    : appliances.filter((item) => item.nickname === hint.nickname && item.type === hint.type);
  if (candidates.length !== 1) throw new Error(priorId ? `existing binding is no longer present: ${deviceId}` : `could not uniquely bootstrap binding: ${deviceId}`);
  bindings.appliances[deviceId] = String(candidates[0].id);
}

const signalsByDevice = new Map<string, Array<Record<string, any>>>();
for (const [actionId, signalName] of Object.entries(NATURE_SIGNAL_NAMES)) {
  const definition = findActionDefinition(actionId, "nature");
  if (!definition) throw new Error(`signal action is absent from Catalog: ${actionId}`);
  let signals = signalsByDevice.get(definition.device);
  if (!signals) {
    const applianceId = bindings.appliances[definition.device];
    const response = await fetch(`https://api.nature.global/1/appliances/${encodeURIComponent(applianceId)}/signals`, { headers, signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error(`Nature signal discovery failed for ${definition.device} (HTTP ${response.status})`);
    const value = await response.json(); signals = Array.isArray(value) ? value : []; signalsByDevice.set(definition.device, signals);
  }
  const priorId = existing?.signals[actionId];
  const candidates = priorId ? signals.filter((item) => item.id === priorId) : signals.filter((item) => item.name === signalName);
  if (candidates.length !== 1) throw new Error(priorId ? `existing signal binding is no longer present: ${actionId}` : `could not uniquely bootstrap signal binding: ${actionId}`);
  bindings.signals[actionId] = String(candidates[0].id);
}

mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, JSON.stringify(bindings, null, 2) + "\n", { mode: 0o600 });
chmodSync(outputPath, 0o600);
console.log(JSON.stringify({
  binding_file_updated: true,
  appliance_bindings: Object.keys(bindings.appliances).length,
  signal_bindings: Object.keys(bindings.signals).length,
  existing_ids_preserved_when_present: true,
  ids_displayed: false,
  request_methods: ["GET"],
  actuation_performed: false,
}, null, 2));

function readExisting(path: string): NatureBindings | undefined {
  if (!existsSync(path)) return undefined;
  const value = JSON.parse(readFileSync(path, "utf8")) as NatureBindings;
  if (value.version !== 1 || !value.appliances || !value.signals) throw new Error("existing Nature binding file is invalid");
  return value;
}
