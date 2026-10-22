import type { AdapterAction, AdapterHealth, AdapterResult, PhysicalStateSnapshot, TemporaryActionRecording } from "../types.ts";

export interface DeviceAdapter {
  readonly name: string;
  execute(action: AdapterAction): Promise<AdapterResult>;
  readState(): Promise<PhysicalStateSnapshot>;
  healthCheck(): Promise<AdapterHealth>;
}

export type AdapterFailureOutcome = "failed" | "unknown";

export class AdapterExecutionError extends Error {
  readonly outcome: AdapterFailureOutcome;
  readonly statusCode: number;
  recording?: TemporaryActionRecording;

  constructor(message: string, outcome: AdapterFailureOutcome, statusCode = 502) {
    super(message);
    this.name = "AdapterExecutionError";
    this.outcome = outcome;
    this.statusCode = statusCode;
  }
}
