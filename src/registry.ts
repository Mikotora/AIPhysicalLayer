import { listActionDefinitions, type ActionParameterDefinition } from "./action-catalog.ts";
import type { ActionPolicy } from "./action-policy.ts";

export type AdapterMode = "mock" | "nature";
export type StateFieldDefinition = { name: string; type: "string" | "number" | "boolean"; unit?: string; readable: boolean };
export type RegisteredAction = { id: string; name: string; label: string; parameters: ActionParameterDefinition[]; technical_available: true; execution_allowed: boolean };
export type RegisteredDevice = { id: string; label: string; room: string | null; kind: string; state_fields: StateFieldDefinition[]; actions: RegisteredAction[] };

const DEVICES: Array<Omit<RegisteredDevice, "actions">> = [
  { id: "appliance.generic", label: "家電", room: null, kind: "generic_ir", state_fields: [{ name: "power", type: "string", readable: false }] },
  { id: "climate.room", label: "部屋のエアコン", room: "部屋", kind: "climate", state_fields: climateFields(true) },
  { id: "light.room", label: "部屋の照明", room: "部屋", kind: "light", state_fields: lightFields(false) },
  { id: "climate.living_room", label: "リビングのエアコン", room: "リビング", kind: "climate", state_fields: climateFields(false) },
  { id: "media.tv", label: "テレビ", room: "リビング", kind: "television", state_fields: [
    { name: "power", type: "string", readable: false }, { name: "input", type: "string", readable: true },
    { name: "channel", type: "number", readable: false }, { name: "volume", type: "number", readable: false }, { name: "muted", type: "boolean", readable: false },
  ] },
  { id: "light.living_room", label: "リビングの照明", room: "リビング", kind: "light", state_fields: lightFields(true) },
  { id: "sensor.lapis", label: "Living room Lapis", room: "リビング", kind: "environment_sensor", state_fields: [] },
];
function climateFields(directions: boolean): StateFieldDefinition[] { return [
  { name: "power", type: "string", readable: true }, { name: "mode", type: "string", readable: true },
  { name: "setpoint_temperature", type: "number", unit: "celsius", readable: true }, { name: "fan_speed", type: "string", readable: true },
  { name: "vertical_direction", type: "string", readable: directions }, { name: "horizontal_direction", type: "string", readable: directions },
]; }
function lightFields(readable: boolean): StateFieldDefinition[] { return [
  { name: "power", type: "string", readable }, { name: "brightness", type: "number", unit: "percent", readable },
]; }

export class DeviceRegistry {
  readonly mode: AdapterMode;
  constructor(mode: AdapterMode = "mock") { this.mode = mode; }
  listDevices(policy?: ActionPolicy): RegisteredDevice[] {
    const actions = listActionDefinitions(this.mode);
    return DEVICES.map((device) => ({ ...structuredClone(device), actions: actions.filter((item) => item.device === device.id).map((item) => ({
      id: item.id, name: item.action, label: item.label, parameters: item.parameters,
      technical_available: true as const, execution_allowed: policy?.allows(item.id) ?? false,
    })) }));
  }
  findDevice(id: string): RegisteredDevice | undefined { return this.listDevices().find((device) => device.id === id); }
}
export function createDeviceRegistry(mode: AdapterMode = "mock"): DeviceRegistry { return new DeviceRegistry(mode); }
