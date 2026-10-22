import { readFileSync } from "node:fs";

const baseUrl = process.argv[2];
const secretPath = process.argv[3] ?? ".runtime/secrets/integration-test.key";
if (!baseUrl) throw new Error("usage: node scripts/verify-ai-direct.ts <https-origin-or-local-origin> [secret-file]");
const secret = readFileSync(secretPath, "utf8").trim();
const commonHeaders = { Authorization: `Bearer ${secret}`, "ngrok-skip-browser-warning": "1" };
const unauthorized = await fetch(`${baseUrl}/ai/v1/capabilities`, { headers: { "ngrok-skip-browser-warning": "1" }, redirect: "manual", signal: AbortSignal.timeout(15_000) });
const capabilityResponse = await fetch(`${baseUrl}/ai/v1/capabilities`, { headers: commonHeaders, signal: AbortSignal.timeout(15_000) });
const stateResponse = await fetch(`${baseUrl}/ai/v1/state`, { headers: commonHeaders, signal: AbortSignal.timeout(15_000) });
if (unauthorized.status !== 401) throw new Error(`unauthenticated boundary returned HTTP ${unauthorized.status}`);
if (!capabilityResponse.ok || !stateResponse.ok) throw new Error(`authenticated read failed (capabilities ${capabilityResponse.status}, state ${stateResponse.status})`);
const capabilities = await capabilityResponse.json() as any; const state = await stateResponse.json() as any;
const fields = Array.isArray(state.devices) ? state.devices.flatMap((device: any) => Object.values(device.fields ?? {})) as any[] : [];
console.log(JSON.stringify({
  unauthenticated_status: unauthorized.status,
  capability_schema: capabilities.schema_version,
  resource_count: Array.isArray(capabilities.devices) ? capabilities.devices.length : 0,
  catalog_action_count: Array.isArray(capabilities.devices) ? capabilities.devices.flatMap((device: any) => device.actions ?? []).length : 0,
  real_allowlist: capabilities.execution_policy?.allowlist ?? [],
  state_schema: state.schema_version,
  observed_field_count: fields.filter((field) => field.status === "observed").length,
  unknown_field_count: fields.filter((field) => field.status === "unknown").length,
  perceptions: Array.isArray(state.perceptions) ? state.perceptions.map((item: any) => ({ perception_id: item.perception_id, value: item.value, unit: item.unit, measured_at: item.measured_at, source: item.source })) : [],
  actuation_performed: false,
}, null, 2));
