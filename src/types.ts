export type JsonScalar = string | number | boolean | null;
export type ActionParameters = Record<string, unknown>;

export type ActionRequest = { device: string; action: string; parameters: ActionParameters };
export type AdapterAction = ActionRequest & { actionId: string };
export type AdapterResult = { adapter: string; state: Record<string, unknown> };

export type ActionResponse = {
  command_id: string;
  status: "succeeded";
  action_id: string;
  device: string;
  action: string;
  adapter: string;
  adapter_state: Record<string, unknown>;
  mock_state?: Record<string, unknown>;
  replayed?: boolean;
  recording?: TemporaryActionRecording;
};

export type TemporaryActionRecording = {
  status: "temporary";
  persistent: false;
  store: "memory";
  duplicate_prevention: "temporary";
  valid_until: "core_process_or_mac_restart";
  must_tell_user: true;
  message: string;
};

export type ActionLogEntry = {
  timestamp: string;
  command_id: string;
  idempotency_key: string;
  source: ActionSource;
  client_id: string | null;
  action_id: string | null;
  device: string | null;
  action: string | null;
  status: "succeeded" | "rejected" | "failed" | "unknown" | "replayed";
  adapter: string | null;
  detail?: string;
};

export type ActionContext = { idempotencyKey: string; source: ActionSource; clientId?: string };
export type ActionSource = "local-web" | "local-api" | "ai-client";
export type AdapterHealth = { adapter: string; status: "ok" | "unavailable"; check: "local" | "read-only-cloud"; detail: string };

export type StateField = {
  status: "observed" | "unknown";
  value?: JsonScalar;
  unit?: string;
  observed_at: string | null;
  source: string;
};
export type LastCommand = { command_id: string; action_id: string; completed_at: string; status: "succeeded" };
export type DeviceState = { device_id: string; fields: Record<string, StateField>; last_command?: LastCommand };
export type PerceptionState =
  | { perception_id: string; status: "observed"; value: number; unit: string; measured_at: string; source: string }
  | { perception_id: string; status: "unknown"; measured_at: null; source: "unavailable" };
export type PhysicalStateSnapshot = { schema_version: "1.0"; observed_at: string; devices: DeviceState[]; perceptions: PerceptionState[] };
