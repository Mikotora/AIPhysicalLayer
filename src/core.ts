import { randomUUID } from "node:crypto";
import { AdapterExecutionError, type DeviceAdapter } from "./adapters/base.ts";
import { findActionByRequest, findActionDefinition, toActionRequest, validateActionParameters } from "./action-catalog.ts";
import { ActionPolicy } from "./action-policy.ts";
import type { ActionLogWriter } from "./logger.ts";
import { createDeviceRegistry, type DeviceRegistry } from "./registry.ts";
import { MemoryCommandStore, TEMPORARY_ACTION_RECORDING, type CommandStore, type StoredAttempt } from "./command-store.ts";
import type { ActionContext, ActionLogEntry, ActionRequest, ActionResponse, LastCommand, PerceptionState, PhysicalStateSnapshot, StateField, TemporaryActionRecording } from "./types.ts";

export class ActionValidationError extends Error {
  readonly statusCode = 400;
  readonly recording?: TemporaryActionRecording;
  constructor(message: string, recording?: TemporaryActionRecording) { super(message); this.recording = recording; }
}
export type StateReadIssue = { stage: "adapter" | "last_command_store"; reason: "adapter_unavailable" | "storage_io_error" | "storage_unavailable" | "unexpected_error" };
type StateIssueReporter = (issue: StateReadIssue) => void;

export class ActionCore {
  readonly adapters: Map<string, DeviceAdapter>;
  readonly logWriter: ActionLogWriter;
  readonly registry: DeviceRegistry;
  readonly policy: ActionPolicy;
  readonly commandStore: CommandStore;
  readonly reportStateIssue: StateIssueReporter;

  constructor(
    adapters: DeviceAdapter[], logWriter: ActionLogWriter,
    registry: DeviceRegistry = createDeviceRegistry(), policy = new ActionPolicy(), commandStore: CommandStore = new MemoryCommandStore(),
    reportStateIssue: StateIssueReporter = defaultStateIssueReporter,
  ) {
    this.adapters = new Map(adapters.map((adapter) => [adapter.name, adapter]));
    this.logWriter = logWriter; this.registry = registry; this.policy = policy; this.commandStore = commandStore; this.reportStateIssue = reportStateIssue;
  }

  async executeById(actionId: string, parameters: Record<string, unknown>, context: ActionContext): Promise<ActionResponse> {
    const definition = findActionDefinition(actionId, this.registry.mode);
    if (!definition) throw new ActionValidationError("action is not in the capability catalog");
    return this.execute(toActionRequest(definition, parameters), context);
  }

  async execute(input: unknown, context: ActionContext): Promise<ActionResponse> {
    const commandId = randomUUID();
    const request = this.readRequest(input);
    this.validateIdempotencyKey(context.idempotencyKey);
    const definition = findActionByRequest(request, this.registry.mode);
    const scope = context.clientId ?? context.source;
    const fingerprint = stableStringify(request);
    const priorAttempt = this.commandStore.getAttempt(scope, context.idempotencyKey);
    if (priorAttempt) return this.handlePriorAttempt(priorAttempt, fingerprint, commandId, request, context, definition?.id ?? null);
    if (!this.registry.findDevice(request.device)) {
      await this.logRejection(commandId, null, request, context, "device is not registered");
      throw new ActionValidationError("device is not registered");
    }
    if (!definition) {
      await this.logRejection(commandId, null, request, context, "action is not in the capability catalog");
      throw new ActionValidationError("action is not in the capability catalog");
    }
    const parameterError = validateActionParameters(definition, request.parameters);
    if (parameterError) {
      await this.logRejection(commandId, definition.id, request, context, parameterError);
      throw new ActionValidationError(parameterError);
    }
    if (!this.policy.allows(definition.id)) {
      await this.logRejection(commandId, definition.id, request, context, "action is not allowed for real execution");
      throw new ActionValidationError("action is not allowed for real execution");
    }
    const adapterName = this.registry.mode;
    const adapter = this.adapters.get(adapterName);
    if (!adapter) {
      await this.writeLog(logEntry(commandId, definition.id, request, context, "failed", adapterName, "adapter is unavailable"));
      throw new Error("adapter is unavailable");
    }
    const reservation = this.commandStore.reserveAttempt({ scope, idempotencyKey: context.idempotencyKey, fingerprint, commandId, actionId: definition.id, device: request.device });
    if (!reservation.inserted) return this.handlePriorAttempt(reservation.attempt, fingerprint, commandId, request, context, definition.id);
    let result;
    try { result = await adapter.execute({ ...request, actionId: definition.id }); }
    catch (error) {
      const adapterError = error instanceof AdapterExecutionError ? error : new AdapterExecutionError("adapter operation failed", "unknown");
      const persistence = this.commandStore.completeAttempt(scope, context.idempotencyKey, adapterError.outcome);
      if (persistence === "temporary") adapterError.recording = structuredClone(TEMPORARY_ACTION_RECORDING);
      await this.writeLog(logEntry(commandId, definition.id, request, context, adapterError.outcome, adapterName, adapterError.message));
      throw adapterError;
    }
    let response: ActionResponse = { command_id: commandId, status: "succeeded", action_id: definition.id, device: request.device, action: request.action, adapter: result.adapter, adapter_state: result.state, ...(result.adapter === "mock" ? { mock_state: result.state } : {}) };
    const completedAt = new Date().toISOString();
    this.commandStore.setLastCommand(request.device, { command_id: commandId, action_id: definition.id, completed_at: completedAt, status: "succeeded" }, reservation.persistence);
    const persistence = this.commandStore.completeAttempt(scope, context.idempotencyKey, "succeeded", response);
    if (persistence === "temporary") response = withTemporaryRecording(response);
    await this.writeLog({ ...logEntry(commandId, definition.id, request, context, "succeeded", result.adapter), timestamp: completedAt });
    return response;
  }

  async readState(): Promise<PhysicalStateSnapshot> {
    const adapter = this.adapters.get(this.registry.mode);
    let snapshot: PhysicalStateSnapshot;
    if (!adapter) {
      this.reportStateIssue({ stage: "adapter", reason: "adapter_unavailable" });
      snapshot = unknownStateSnapshot(this.registry);
    } else {
      try { snapshot = await adapter.readState(); }
      catch (error) {
        this.reportStateIssue({ stage: "adapter", reason: classifyStateReadError(error, "adapter_unavailable") });
        snapshot = unknownStateSnapshot(this.registry);
      }
    }
    let commands: Map<string, LastCommand>;
    try { commands = this.commandStore.listLastCommands(); }
    catch (error) {
      this.reportStateIssue({ stage: "last_command_store", reason: classifyStateReadError(error, "storage_unavailable") });
      return snapshot;
    }
    for (const device of snapshot.devices) {
      const command = commands.get(device.device_id);
      if (command) device.last_command = structuredClone(command);
    }
    return snapshot;
  }

  private async handlePriorAttempt(prior: StoredAttempt, fingerprint: string, commandId: string, request: ActionRequest, context: ActionContext, actionId: string | null): Promise<ActionResponse> {
    const recording = prior.persistence === "temporary" ? structuredClone(TEMPORARY_ACTION_RECORDING) : undefined;
    if (prior.fingerprint !== fingerprint) {
      await this.logRejection(commandId, actionId, request, context, "Idempotency-Key was already used for a different action");
      throw new ActionValidationError("Idempotency-Key was already used for a different action", recording);
    }
    if (prior.status === "succeeded" && prior.response) {
      await this.writeLog(logEntry(prior.response.command_id, prior.response.action_id, request, context, "replayed", prior.response.adapter));
      const response = { ...structuredClone(prior.response), replayed: true };
      return prior.persistence === "temporary" ? withTemporaryRecording(response) : response;
    }
    await this.logRejection(commandId, actionId, request, context, "Idempotency-Key was already consumed; the device operation was not retried");
    throw new ActionValidationError("Idempotency-Key was already consumed; use a new key after checking device state", recording);
  }

  private readRequest(input: unknown): ActionRequest {
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new ActionValidationError("request body must be an object");
    const value = input as Record<string, unknown>; const allowed = new Set(["device", "action", "parameters"]);
    if (Object.keys(value).some((key) => !allowed.has(key))) throw new ActionValidationError("request body contains an unknown field");
    if (typeof value.device !== "string" || !value.device) throw new ActionValidationError("device must be a non-empty string");
    if (typeof value.action !== "string" || !value.action) throw new ActionValidationError("action must be a non-empty string");
    if (!value.parameters || typeof value.parameters !== "object" || Array.isArray(value.parameters)) throw new ActionValidationError("parameters must be an object");
    return { device: value.device, action: value.action, parameters: value.parameters as Record<string, unknown> };
  }
  private validateIdempotencyKey(key: string): void { if (!key || key.length > 128 || !/^[A-Za-z0-9._:-]+$/.test(key)) throw new ActionValidationError("a valid Idempotency-Key header is required"); }
  private async logRejection(commandId: string, actionId: string | null, request: ActionRequest, context: ActionContext, detail: string): Promise<void> { await this.writeLog(logEntry(commandId, actionId, request, context, "rejected", null, detail)); }
  private async writeLog(entry: ActionLogEntry): Promise<void> { await this.logWriter.append(entry); }
}

function withTemporaryRecording(response: ActionResponse): ActionResponse {
  return { ...response, recording: structuredClone(TEMPORARY_ACTION_RECORDING) };
}

function logEntry(commandId: string, actionId: string | null, request: ActionRequest, context: ActionContext, status: ActionLogEntry["status"], adapter: string | null, detail?: string): ActionLogEntry {
  return { timestamp: new Date().toISOString(), command_id: commandId, idempotency_key: context.idempotencyKey, source: context.source, client_id: context.clientId ?? null, action_id: actionId, device: request.device, action: request.action, status, adapter, ...(detail ? { detail } : {}) };
}
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(",")}}`;
  return JSON.stringify(value);
}

function unknownStateSnapshot(registry: DeviceRegistry): PhysicalStateSnapshot {
  const devices = registry.listDevices().map((device) => ({
    device_id: device.id,
    fields: Object.fromEntries(device.state_fields.map((field) => [field.name, unknownField()])),
  }));
  const perceptions: PerceptionState[] = [
    { perception_id: "environment.living_room.temperature", status: "unknown", measured_at: null, source: "unavailable" },
    { perception_id: "environment.living_room.humidity", status: "unknown", measured_at: null, source: "unavailable" },
  ];
  return { schema_version: "1.0", observed_at: new Date().toISOString(), devices, perceptions };
}
function unknownField(): StateField { return { status: "unknown", observed_at: null, source: "unavailable" }; }
function classifyStateReadError(error: unknown, fallback: StateReadIssue["reason"]): StateReadIssue["reason"] {
  const message = error instanceof Error ? error.message : "";
  if (/disk I\/O/i.test(message)) return "storage_io_error";
  if (/unable to open|readonly|permission|operation not permitted|command store is unavailable/i.test(message)) return "storage_unavailable";
  return fallback;
}
function defaultStateIssueReporter(issue: StateReadIssue): void {
  console.error(JSON.stringify({ at: new Date().toISOString(), event: "state_read_degraded", stage: issue.stage, reason: issue.reason }));
}
