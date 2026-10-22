import { ActionPolicy } from "./action-policy.ts";
import type { DeviceRegistry } from "./registry.ts";

export function buildCapabilityDocument(registry: DeviceRegistry, policy: ActionPolicy) {
  return {
    schema_version: "1.0",
    devices: registry.listDevices(policy),
    perceptions: [
      { id: "environment.living_room.temperature", device_id: "sensor.lapis", metric: "temperature", unit: "celsius", readable: true },
      { id: "environment.living_room.humidity", device_id: "sensor.lapis", metric: "humidity", unit: "percent", readable: true },
    ],
    execution_policy: { mode: policy.mode, allowlist: policy.list(), shared_across_ai_clients: true },
  };
}
