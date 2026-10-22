import { constants, accessSync, appendFileSync, chmodSync, existsSync, mkdirSync, openSync, closeSync } from "node:fs";
import { dirname } from "node:path";

export type GatewayToolAuditEntry = {
  timestamp: string;
  client_id: string;
  client_name_claimed: string;
  tool: "get_capabilities" | "get_state" | "execute_action";
  phase: "attempt" | "result";
  result: "pending" | "succeeded" | "replayed" | "unknown" | "core_unavailable" | "core_rejected" | "audit_unavailable" | "failed";
  action_id?: string;
  action_name?: string;
};

export type GatewayRegistrationAuditEntry = {
  timestamp: string;
  event: "client_registration";
  decision: "pending" | "approved" | "rejected" | "expired";
  client_ref: string;
  client_name_claimed: string;
  client_kind: "dcr" | "cimd";
  redirect_host: string;
  redirect_hosts: string[];
  redirect_uri_count: number;
};

export type GatewayAuditEntry = GatewayToolAuditEntry | GatewayRegistrationAuditEntry;

export interface GatewayAuditWriter {
  append(entry: GatewayAuditEntry): void | Promise<void>;
  isWritable?(): boolean;
}

export class FileGatewayAudit implements GatewayAuditWriter {
  readonly path: string;
  constructor(path: string) {
    this.path = path;
    mkdirSync(dirname(path), { recursive: true });
    if (!existsSync(path)) {
      const descriptor = openSync(path, "a", 0o600); closeSync(descriptor);
    }
    chmodSync(path, 0o600);
  }
  append(entry: GatewayAuditEntry): void {
    appendFileSync(this.path, JSON.stringify(entry) + "\n", { encoding: "utf8", mode: 0o600, flush: true });
  }
  isWritable(): boolean {
    try { accessSync(this.path, constants.W_OK); return true; } catch { return false; }
  }
}

export class MemoryGatewayAudit implements GatewayAuditWriter {
  readonly entries: GatewayAuditEntry[] = [];
  fail: boolean;
  constructor(fail = false) { this.fail = fail; }
  append(entry: GatewayAuditEntry): void {
    if (this.fail) throw new Error("audit unavailable");
    this.entries.push(structuredClone(entry));
  }
  isWritable(): boolean { return !this.fail; }
}
