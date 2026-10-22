import { AdapterExecutionError, type DeviceAdapter } from "./base.ts";
import type { AdapterAction, AdapterHealth, AdapterResult, DeviceState, PerceptionState, PhysicalStateSnapshot, StateField } from "../types.ts";
import type { NatureConfig } from "../config.ts";
import { natureBindingFor } from "../nature-profiles.ts";

const API = "https://api.nature.global";
const TIMEOUT_MS = 8_000;
type FetchLike = typeof fetch;
type JsonRecord = Record<string, any>;
type StateSource = "appliances" | "devices" | "lapis_temperature" | "lapis_humidity";
type StateIssueReason = "rate_limited" | "http_error" | "timeout" | "network_error" | "invalid_response" | "missing_or_invalid_value";
export type NatureStateIssue = { source: StateSource; reason: StateIssueReason; httpStatus?: number };
type StateIssueReporter = (issue: NatureStateIssue) => void;
const unknown = (): StateField => ({ status: "unknown", observed_at: null, source: "unavailable" });
const observed = (value: string | number | boolean, at: string, unit?: string): StateField => ({ status: "observed", value, ...(unit ? { unit } : {}), observed_at: at, source: "nature_cloud.current_state" });
const unknownPerception = (perceptionId: string): PerceptionState => ({ perception_id: perceptionId, status: "unknown", measured_at: null, source: "unavailable" });

export class NatureAdapter implements DeviceAdapter {
  readonly name = "nature";
  readonly config: NatureConfig;
  readonly fetchImpl: FetchLike;
  readonly reportStateIssue: StateIssueReporter;
  private inFlight = false;
  constructor(config: NatureConfig, fetchImpl: FetchLike = fetch, reportStateIssue: StateIssueReporter = defaultStateIssueReporter) {
    this.config = config; this.fetchImpl = fetchImpl; this.reportStateIssue = reportStateIssue;
  }

  async healthCheck(): Promise<AdapterHealth> {
    try {
      const response = await this.request("/1/appliances", "GET");
      return response.ok ? { adapter: this.name, status: "ok", check: "read-only-cloud", detail: "Nature Cloud API is reachable and authorized" }
        : { adapter: this.name, status: "unavailable", check: "read-only-cloud", detail: `Nature Cloud API health check failed (HTTP ${response.status})` };
    } catch { return { adapter: this.name, status: "unavailable", check: "read-only-cloud", detail: "Nature Cloud API health check could not complete" }; }
  }

  async readState(): Promise<PhysicalStateSnapshot> {
    const [appliances, devices] = await Promise.all([
      this.readArraySource("/1/appliances", "appliances"),
      this.readArraySource("/1/devices", "devices"),
    ]);
    const now = new Date().toISOString();
    const states: DeviceState[] = Object.entries(this.config.bindings.appliances).map(([deviceId, applianceId]) => mapApplianceState(deviceId, findApplianceById(appliances ?? [], applianceId), now));
    states.push({ device_id: "sensor.lapis", fields: {} });
    const controller = devices?.find((device) => typeof device?.newest_events === "object") ?? {};
    const events = controller.newest_events ?? {};
    const perceptions: PerceptionState[] = [
      this.perception("environment.living_room.temperature", events.te, "celsius", "lapis.sensor.temperature", "lapis_temperature", devices !== undefined),
      this.perception("environment.living_room.humidity", events.hu, "percent", "lapis.sensor.humidity", "lapis_humidity", devices !== undefined),
    ];
    return { schema_version: "1.0", observed_at: now, devices: states, perceptions };
  }

  async execute(input: AdapterAction): Promise<AdapterResult> {
    const binding = natureBindingFor(input.actionId);
    if (!binding) throw new AdapterExecutionError("Nature Adapter has no binding for this action", "failed", 400);
    if (this.inFlight) throw new AdapterExecutionError("a Nature command is already in progress", "failed", 429);
    this.inFlight = true;
    try {
      let path: string;
      let body: URLSearchParams;
      if (binding.kind === "light_button") {
        const applianceId = requireBindingId(this.config.bindings.appliances[input.device]);
        path = `/1/appliances/${encodeURIComponent(applianceId)}/light`;
        body = new URLSearchParams({ button: binding.button });
      } else if (binding.kind === "tv_button") {
        path = `/1/appliances/${encodeURIComponent(requireBindingId(this.config.bindings.appliances[input.device]))}/tv`;
        body = new URLSearchParams({ button: typeof binding.button === "function" ? binding.button(input.parameters) : binding.button });
      } else if (binding.kind === "signal") {
        path = `/1/signals/${encodeURIComponent(requireBindingId(this.config.bindings.signals[input.actionId]))}/send`; body = new URLSearchParams();
      } else {
        const appliances = await this.loadAppliances();
        const applianceId = requireBindingId(this.config.bindings.appliances[input.device]);
        const appliance = findApplianceById(appliances, applianceId);
        path = `/1/appliances/${encodeURIComponent(applianceId)}/aircon_settings`;
        body = buildAirconBody(appliance, input);
      }
      const response = await this.request(path, "POST", body);
      if (!response.ok) throw new AdapterExecutionError(`Nature API rejected the command (HTTP ${response.status})`, response.status >= 500 ? "unknown" : "failed", response.status >= 500 ? 502 : 400);
      return { adapter: this.name, state: { command: input.actionId, delivery: "accepted", http_status: response.status, state_source: "nature_cloud.command_response" } };
    } catch (error) {
      if (error instanceof AdapterExecutionError) throw error;
      const timedOut = error instanceof Error && error.name === "TimeoutError";
      throw new AdapterExecutionError(timedOut ? "Nature API request timed out" : "Nature API request failed", "unknown");
    } finally { this.inFlight = false; }
  }

  private async loadAppliances(): Promise<JsonRecord[]> {
    const response = await this.request("/1/appliances", "GET");
    if (!response.ok) throw new AdapterExecutionError(`Nature appliance discovery failed (HTTP ${response.status})`, "failed", 502);
    return safeArray(response);
  }
  private async readArraySource(path: string, source: "appliances" | "devices"): Promise<JsonRecord[] | undefined> {
    let response: Response;
    try { response = await this.request(path, "GET"); }
    catch (error) {
      this.reportStateIssue({ source, reason: error instanceof Error && error.name === "TimeoutError" ? "timeout" : "network_error" });
      return undefined;
    }
    if (!response.ok) {
      this.reportStateIssue({ source, reason: response.status === 429 ? "rate_limited" : "http_error", httpStatus: response.status });
      return undefined;
    }
    try {
      const value = await response.json();
      if (!Array.isArray(value)) { this.reportStateIssue({ source, reason: "invalid_response" }); return undefined; }
      return value as JsonRecord[];
    } catch { this.reportStateIssue({ source, reason: "invalid_response" }); return undefined; }
  }
  private perception(perceptionId: string, event: unknown, unit: string, source: string, issueSource: "lapis_temperature" | "lapis_humidity", deviceSourceAvailable: boolean): PerceptionState {
    if (isSensorEvent(event)) return { perception_id: perceptionId, status: "observed", value: event.val, unit, measured_at: event.created_at, source };
    if (deviceSourceAvailable) this.reportStateIssue({ source: issueSource, reason: "missing_or_invalid_value" });
    return unknownPerception(perceptionId);
  }
  private request(path: string, method: "GET" | "POST", body?: URLSearchParams): Promise<Response> {
    return this.fetchImpl(`${API}${path}`, { method, headers: { Authorization: `Bearer ${this.config.accessToken}`, ...(body ? { "Content-Type": "application/x-www-form-urlencoded" } : {}) }, ...(body ? { body } : {}), signal: AbortSignal.timeout(TIMEOUT_MS) });
  }
}

function findApplianceById(appliances: JsonRecord[], applianceId: string | undefined): JsonRecord | undefined {
  return applianceId ? appliances.find((item) => item.id === applianceId) : undefined;
}
function requireBindingId(value: string | undefined): string {
  if (!value) throw new AdapterExecutionError("registered Nature target is not bound", "failed", 409);
  return value;
}
async function safeArray(response: Response): Promise<JsonRecord[]> { const value = await response.json(); return Array.isArray(value) ? value : []; }
function isSensorEvent(value: unknown): value is { val: number; created_at: string } { const item = value as JsonRecord; return Boolean(item && typeof item.val === "number" && typeof item.created_at === "string"); }

function defaultStateIssueReporter(issue: NatureStateIssue): void {
  console.error(JSON.stringify({
    at: new Date().toISOString(), event: "adapter_state_source_unavailable", adapter: "nature",
    source: issue.source, reason: issue.reason, ...(issue.httpStatus === undefined ? {} : { http_status: issue.httpStatus }),
  }));
}

function mapApplianceState(deviceId: string, appliance: JsonRecord | undefined, now: string): DeviceState {
  if (!appliance) return { device_id: deviceId, fields: baseUnknownFields(deviceId) };
  if (deviceId.startsWith("climate.")) {
    const settings = appliance.settings ?? {}; const at = typeof settings.updated_at === "string" ? settings.updated_at : now;
    return { device_id: deviceId, fields: {
      power: typeof settings.button === "string" ? observed(settings.button === "power-off" ? "off" : "on", at) : unknown(),
      mode: typeof settings.mode === "string" && settings.mode !== "" ? observed(fromNatureMode(settings.mode), at) : unknown(), setpoint_temperature: numericField(settings.temp, at, "celsius"), fan_speed: valueField(settings.vol, at),
      vertical_direction: valueField(settings.dir, at), horizontal_direction: valueField(settings.dirh, at),
    } };
  }
  if (deviceId === "light.living_room") {
    const state = appliance.light?.state ?? {};
    return { device_id: deviceId, fields: { power: valueField(state.power, now), brightness: numericField(state.brightness, now, "percent") } };
  }
  if (deviceId === "media.tv") return { device_id: deviceId, fields: { power: unknown(), input: typeof appliance.tv?.state?.input === "string" && appliance.tv.state.input !== "" ? observed(normalizeTvInput(appliance.tv.state.input), now) : unknown(), channel: unknown(), volume: unknown(), muted: unknown() } };
  return { device_id: deviceId, fields: { power: unknown() } };
}
function baseUnknownFields(deviceId: string): Record<string, StateField> {
  if (deviceId.startsWith("climate.")) return { power: unknown(), mode: unknown(), setpoint_temperature: unknown(), fan_speed: unknown(), vertical_direction: unknown(), horizontal_direction: unknown() };
  if (deviceId === "media.tv") return { power: unknown(), input: unknown(), channel: unknown(), volume: unknown(), muted: unknown() };
  return { power: unknown(), ...(deviceId.startsWith("light.") ? { brightness: unknown() } : {}) };
}
function valueField(value: unknown, at: string): StateField { return typeof value === "string" && value !== "" ? observed(value, at) : unknown(); }
function numericField(value: unknown, at: string, unit: string): StateField { const parsed = typeof value === "number" ? value : typeof value === "string" && value !== "" ? Number(value) : NaN; return Number.isFinite(parsed) ? observed(parsed, at, unit) : unknown(); }

function buildAirconBody(appliance: JsonRecord | undefined, input: AdapterAction): URLSearchParams {
  if (!appliance) throw new AdapterExecutionError("registered Nature target could not be resolved", "failed", 409);
  const settings = appliance.settings ?? {}; const modes = appliance.aircon?.range?.modes ?? {};
  let mode = String(settings.mode ?? ""); if (input.action === "set_mode") mode = toNatureMode(String(input.parameters.mode));
  if (!modes[mode]) throw new AdapterExecutionError("air conditioner mode is unavailable", "failed", 400);
  const range = modes[mode];
  let temp = input.action === "set_temperature" ? String(input.parameters.value) : String(settings.temp ?? "");
  let vol = input.action === "set_fan_speed" ? String(input.parameters.value) : String(settings.vol ?? "");
  let dir = input.action === "set_vertical_direction" ? String(input.parameters.value) : String(settings.dir ?? "");
  let dirh = input.action === "set_horizontal_direction" ? String(input.parameters.value) : String(settings.dirh ?? "");
  temp = selectAllowed(temp, range.temp); vol = selectAllowed(vol, range.vol); dir = selectAllowed(dir, range.dir); dirh = selectAllowed(dirh, range.dirh);
  if (input.action === "set_temperature" && String(input.parameters.value) !== temp) throw new AdapterExecutionError("temperature is unavailable in the current mode", "failed", 400);
  return new URLSearchParams({ temperature: temp, temperature_unit: String(appliance.aircon?.tempUnit ?? settings.temp_unit ?? "c"), operation_mode: mode, air_volume: vol, air_direction: dir, air_direction_h: dirh, button: input.action === "off" ? "power-off" : "" });
}
function selectAllowed(current: string, allowed: unknown): string {
  const values = Array.isArray(allowed) ? allowed.map(String) : [""];
  if (values.includes(current)) return current;
  return values.find((value) => value !== "") ?? values[0] ?? "";
}
function toNatureMode(value: string): string { return ({ fan: "blow", heat: "warm" } as Record<string, string>)[value] ?? value; }
function fromNatureMode(value: string): string { return ({ blow: "fan", warm: "heat" } as Record<string, string>)[value] ?? value; }
function normalizeTvInput(value: string): string { return ({ t: "terrestrial", terrestrial: "terrestrial", bs: "bs", cs: "cs" } as Record<string, string>)[value] ?? value; }
