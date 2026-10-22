import type { DeviceAdapter } from "./base.ts";
import type { AdapterAction, AdapterHealth, AdapterResult, DeviceState, PhysicalStateSnapshot, StateField } from "../types.ts";

const unknown = (): StateField => ({ status: "unknown", observed_at: null, source: "unavailable" });
const observed = (value: string | number | boolean, observedAt: string, unit?: string): StateField => ({ status: "observed", value, ...(unit ? { unit } : {}), observed_at: observedAt, source: "mock.current_state" });

export class MockAdapter implements DeviceAdapter {
  readonly name = "mock";
  readonly states = new Map<string, Record<string, string | number | boolean>>();
  executionCount = 0;
  failNext: "failed" | "unknown" | null = null;

  async healthCheck(): Promise<AdapterHealth> { return { adapter: this.name, status: "ok", check: "local", detail: "Mock adapter is ready" }; }

  async execute(input: AdapterAction): Promise<AdapterResult> {
    if (this.failNext) {
      const outcome = this.failNext; this.failNext = null;
      const { AdapterExecutionError } = await import("./base.ts");
      throw new AdapterExecutionError("simulated adapter failure", outcome);
    }
    this.executionCount += 1;
    const state = { ...(this.states.get(input.device) ?? {}), simulated: true };
    if (input.action === "on" || input.action === "off") state.power = input.action;
    else state.last_action = input.action;
    Object.assign(state, input.parameters);
    this.states.set(input.device, state);
    return { adapter: this.name, state: structuredClone(state) };
  }

  async readState(): Promise<PhysicalStateSnapshot> {
    const now = new Date().toISOString();
    const ids = ["appliance.generic", "climate.room", "light.room", "climate.living_room", "media.tv", "light.living_room", "sensor.lapis"];
    const devices: DeviceState[] = ids.map((deviceId) => {
      const state = this.states.get(deviceId);
      const fields: Record<string, StateField> = {};
      if (deviceId.startsWith("climate.")) Object.assign(fields, { power: state?.power ? observed(state.power, now) : observed("off", now), mode: observed("cool", now), setpoint_temperature: observed(24, now, "celsius"), fan_speed: observed("auto", now), vertical_direction: unknown(), horizontal_direction: unknown() });
      else if (deviceId === "light.living_room") Object.assign(fields, { power: state?.power ? observed(state.power, now) : observed("off", now), brightness: observed(100, now, "percent") });
      else if (deviceId === "media.tv") Object.assign(fields, { power: unknown(), input: observed("terrestrial", now), channel: unknown(), volume: unknown(), muted: unknown() });
      else if (deviceId !== "sensor.lapis") fields.power = unknown();
      return { device_id: deviceId, fields };
    });
    return { schema_version: "1.0", observed_at: now, devices, perceptions: [
      { perception_id: "environment.living_room.temperature", status: "observed", value: 25, unit: "celsius", measured_at: now, source: "mock.sensor.temperature" },
      { perception_id: "environment.living_room.humidity", status: "observed", value: 50, unit: "percent", measured_at: now, source: "mock.sensor.humidity" },
    ] };
  }
}
