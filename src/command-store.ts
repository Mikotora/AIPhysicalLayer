import { DatabaseSync } from "node:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { ActionResponse, LastCommand, TemporaryActionRecording } from "./types.ts";

export type AttemptStatus = "attempting" | "succeeded" | "failed" | "unknown";
export type AttemptPersistence = "persistent" | "temporary";
export type StoredAttempt = {
  scope: string; idempotencyKey: string; fingerprint: string; commandId: string;
  actionId: string; device: string; status: AttemptStatus; response?: ActionResponse; persistence?: AttemptPersistence;
};
export type AttemptSeed = Omit<StoredAttempt, "status" | "response" | "persistence">;
export interface CommandStore {
  getAttempt(scope: string, idempotencyKey: string): StoredAttempt | undefined;
  reserveAttempt(attempt: AttemptSeed): { inserted: boolean; attempt: StoredAttempt; persistence: AttemptPersistence };
  completeAttempt(scope: string, idempotencyKey: string, status: Exclude<AttemptStatus, "attempting">, response?: ActionResponse): AttemptPersistence;
  setLastCommand(device: string, command: LastCommand, persistence?: AttemptPersistence): void;
  listLastCommands(): Map<string, LastCommand>;
  close?(): void;
}

export const TEMPORARY_ACTION_RECORDING: TemporaryActionRecording = Object.freeze({
  status: "temporary",
  persistent: false,
  store: "memory",
  duplicate_prevention: "temporary",
  valid_until: "core_process_or_mac_restart",
  must_tell_user: true,
  message: "記録帳（SQLite）が使えないため、この操作は永続記録されていません。二重押し防止はメモリ上だけの一時的なもので、CoreプロセスまたはMacの再起動で失われます。",
});

export class CommandStoreUnavailableError extends Error {
  constructor() { super("command store is unavailable"); this.name = "CommandStoreUnavailableError"; }
}

export class MemoryCommandStore implements CommandStore {
  readonly attempts = new Map<string, StoredAttempt>();
  readonly commands = new Map<string, LastCommand>();
  private key(scope: string, idempotencyKey: string): string { return `${scope}\u0000${idempotencyKey}`; }
  getAttempt(scope: string, idempotencyKey: string): StoredAttempt | undefined { const value = this.attempts.get(this.key(scope, idempotencyKey)); return value ? structuredClone(value) : undefined; }
  reserveAttempt(attempt: AttemptSeed) {
    const key = this.key(attempt.scope, attempt.idempotencyKey); const prior = this.attempts.get(key);
    if (prior) return { inserted: false, attempt: structuredClone(prior), persistence: prior.persistence ?? "persistent" as const };
    const stored: StoredAttempt = { ...structuredClone(attempt), status: "attempting" }; this.attempts.set(key, stored); return { inserted: true, attempt: structuredClone(stored), persistence: "persistent" as const };
  }
  completeAttempt(scope: string, idempotencyKey: string, status: Exclude<AttemptStatus, "attempting">, response?: ActionResponse): AttemptPersistence {
    const key = this.key(scope, idempotencyKey); const value = this.attempts.get(key); if (!value) throw new Error("attempt is not reserved");
    value.status = status; value.response = response ? structuredClone(response) : undefined;
    return value.persistence ?? "persistent";
  }
  setLastCommand(device: string, command: LastCommand): void { this.commands.set(device, structuredClone(command)); }
  listLastCommands(): Map<string, LastCommand> { return new Map([...this.commands].map(([key, value]) => [key, structuredClone(value)])); }
}

export class SqliteCommandStore implements CommandStore {
  readonly db: DatabaseSync;
  readonly path: string;
  constructor(path: string) {
    this.path = path;
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    chmodSync(path, 0o600);
    this.db.exec(`
      PRAGMA journal_mode = DELETE;
      PRAGMA synchronous = FULL;
      CREATE TABLE IF NOT EXISTS command_attempts (
        scope TEXT NOT NULL, idempotency_key TEXT NOT NULL, fingerprint TEXT NOT NULL,
        command_id TEXT NOT NULL, action_id TEXT NOT NULL, device TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('attempting','succeeded','failed','unknown')),
        response_json TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        PRIMARY KEY(scope, idempotency_key)
      );
      CREATE TABLE IF NOT EXISTS last_commands (
        device TEXT PRIMARY KEY, command_id TEXT NOT NULL, action_id TEXT NOT NULL,
        completed_at TEXT NOT NULL, status TEXT NOT NULL CHECK(status = 'succeeded')
      );
    `);
  }
  getAttempt(scope: string, idempotencyKey: string): StoredAttempt | undefined {
    const row = this.db.prepare("SELECT * FROM command_attempts WHERE scope = ? AND idempotency_key = ?").get(scope, idempotencyKey) as Record<string, unknown> | undefined;
    return row ? rowToAttempt(row) : undefined;
  }
  reserveAttempt(attempt: AttemptSeed) {
    const now = new Date().toISOString();
    const result = this.db.prepare("INSERT OR IGNORE INTO command_attempts(scope,idempotency_key,fingerprint,command_id,action_id,device,status,created_at,updated_at) VALUES(?,?,?,?,?,?,'attempting',?,?)")
      .run(attempt.scope, attempt.idempotencyKey, attempt.fingerprint, attempt.commandId, attempt.actionId, attempt.device, now, now);
    const stored = this.getAttempt(attempt.scope, attempt.idempotencyKey);
    if (!stored) throw new Error("could not reserve command intent");
    return { inserted: result.changes === 1, attempt: stored, persistence: "persistent" as const };
  }
  completeAttempt(scope: string, idempotencyKey: string, status: Exclude<AttemptStatus, "attempting">, response?: ActionResponse): AttemptPersistence {
    const result = this.db.prepare("UPDATE command_attempts SET status = ?, response_json = ?, updated_at = ? WHERE scope = ? AND idempotency_key = ?")
      .run(status, response ? JSON.stringify(response) : null, new Date().toISOString(), scope, idempotencyKey);
    if (result.changes !== 1) throw new Error("attempt is not reserved");
    return "persistent";
  }
  setLastCommand(device: string, command: LastCommand): void {
    this.db.prepare("INSERT INTO last_commands(device,command_id,action_id,completed_at,status) VALUES(?,?,?,?,?) ON CONFLICT(device) DO UPDATE SET command_id=excluded.command_id,action_id=excluded.action_id,completed_at=excluded.completed_at,status=excluded.status")
      .run(device, command.command_id, command.action_id, command.completed_at, command.status);
  }
  listLastCommands(): Map<string, LastCommand> {
    const rows = this.db.prepare("SELECT * FROM last_commands").all() as Array<Record<string, unknown>>;
    return new Map(rows.map((row) => [String(row.device), { command_id: String(row.command_id), action_id: String(row.action_id), completed_at: String(row.completed_at), status: "succeeded" }]));
  }
  close(): void { this.db.close(); }
}

export type CommandStoreAvailabilityEvent =
  | { event: "degraded"; reason: StorageErrorReason }
  | { event: "recovered" };
type StorageErrorReason = "storage_io_error" | "storage_unavailable" | "unexpected_error";

type ResilientCommandStoreOptions = {
  open?: (path: string) => CommandStore;
  report?: (event: CommandStoreAvailabilityEvent) => void;
};

export class ResilientCommandStore implements CommandStore {
  readonly path: string;
  private readonly memory = new MemoryCommandStore();
  private readonly persistence = new Map<string, AttemptPersistence>();
  private readonly open: (path: string) => CommandStore;
  private readonly report: (event: CommandStoreAvailabilityEvent) => void;
  private primary: CommandStore | undefined;
  private degraded = false;

  constructor(path: string, options: ResilientCommandStoreOptions = {}) {
    this.path = path;
    this.open = options.open ?? ((value) => new SqliteCommandStore(value));
    this.report = options.report ?? (() => undefined);
    this.ensurePrimary();
  }

  getAttempt(scope: string, idempotencyKey: string): StoredAttempt | undefined {
    const cached = this.memory.getAttempt(scope, idempotencyKey);
    if (cached) return this.withPersistence(cached, this.persistenceFor(scope, idempotencyKey));
    const primary = this.ensurePrimary();
    if (!primary) return undefined;
    try {
      const attempt = primary.getAttempt(scope, idempotencyKey);
      if (!attempt) return undefined;
      this.remember(attempt, "persistent");
      return this.withPersistence(attempt, "persistent");
    } catch (error) {
      this.markDegraded(error);
      return undefined;
    }
  }

  reserveAttempt(seed: AttemptSeed): { inserted: boolean; attempt: StoredAttempt; persistence: AttemptPersistence } {
    const cached = this.memory.getAttempt(seed.scope, seed.idempotencyKey);
    if (cached) {
      const persistence = this.persistenceFor(seed.scope, seed.idempotencyKey);
      return { inserted: false, attempt: this.withPersistence(cached, persistence), persistence };
    }
    const primary = this.ensurePrimary();
    if (primary) {
      try {
        const reservation = primary.reserveAttempt(seed);
        this.remember(reservation.attempt, "persistent");
        return { ...reservation, attempt: this.withPersistence(reservation.attempt, "persistent"), persistence: "persistent" };
      } catch (error) { this.markDegraded(error); }
    }
    const reservation = this.memory.reserveAttempt(seed);
    this.persistence.set(this.key(seed.scope, seed.idempotencyKey), "temporary");
    return { ...reservation, attempt: this.withPersistence(reservation.attempt, "temporary"), persistence: "temporary" };
  }

  completeAttempt(scope: string, idempotencyKey: string, status: Exclude<AttemptStatus, "attempting">, response?: ActionResponse): AttemptPersistence {
    const key = this.key(scope, idempotencyKey);
    const persistence = this.persistence.get(key) ?? "temporary";
    if (persistence === "persistent" && this.primary) {
      try {
        this.primary.completeAttempt(scope, idempotencyKey, status, response);
        this.memory.completeAttempt(scope, idempotencyKey, status, response);
        return "persistent";
      } catch (error) { this.markDegraded(error); }
    }
    this.persistence.set(key, "temporary");
    this.memory.completeAttempt(scope, idempotencyKey, status, response);
    return "temporary";
  }

  setLastCommand(device: string, command: LastCommand, persistence: AttemptPersistence = "persistent"): void {
    this.memory.setLastCommand(device, command);
    if (persistence !== "persistent" || !this.primary) return;
    try { this.primary.setLastCommand(device, command, persistence); }
    catch (error) { this.markDegraded(error); }
  }

  listLastCommands(): Map<string, LastCommand> {
    const primary = this.ensurePrimary();
    if (!primary) throw new CommandStoreUnavailableError();
    try { return primary.listLastCommands(); }
    catch (error) { this.markDegraded(error); throw new CommandStoreUnavailableError(); }
  }

  close(): void {
    this.primary?.close?.();
    this.primary = undefined;
  }

  private ensurePrimary(): CommandStore | undefined {
    if (this.primary) return this.primary;
    try {
      this.primary = this.open(this.path);
      if (this.degraded) this.report({ event: "recovered" });
      this.degraded = false;
      return this.primary;
    } catch (error) {
      this.markDegraded(error);
      return undefined;
    }
  }

  private markDegraded(error: unknown): void {
    try { this.primary?.close?.(); } catch { /* closing a broken store is best effort */ }
    this.primary = undefined;
    if (!this.degraded) this.report({ event: "degraded", reason: classifyStorageError(error) });
    this.degraded = true;
  }

  private remember(attempt: StoredAttempt, persistence: AttemptPersistence): void {
    const seed: AttemptSeed = {
      scope: attempt.scope, idempotencyKey: attempt.idempotencyKey, fingerprint: attempt.fingerprint,
      commandId: attempt.commandId, actionId: attempt.actionId, device: attempt.device,
    };
    this.memory.reserveAttempt(seed);
    if (attempt.status !== "attempting") this.memory.completeAttempt(attempt.scope, attempt.idempotencyKey, attempt.status, attempt.response);
    this.persistence.set(this.key(attempt.scope, attempt.idempotencyKey), persistence);
  }

  private withPersistence(attempt: StoredAttempt, persistence: AttemptPersistence): StoredAttempt {
    return { ...structuredClone(attempt), persistence };
  }

  private persistenceFor(scope: string, idempotencyKey: string): AttemptPersistence {
    return this.persistence.get(this.key(scope, idempotencyKey)) ?? "persistent";
  }

  private key(scope: string, idempotencyKey: string): string { return `${scope}\u0000${idempotencyKey}`; }
}

function rowToAttempt(row: Record<string, unknown>): StoredAttempt {
  return {
    scope: String(row.scope), idempotencyKey: String(row.idempotency_key), fingerprint: String(row.fingerprint),
    commandId: String(row.command_id), actionId: String(row.action_id), device: String(row.device), status: String(row.status) as AttemptStatus,
    ...(typeof row.response_json === "string" ? { response: JSON.parse(row.response_json) as ActionResponse } : {}),
  };
}

function classifyStorageError(error: unknown): StorageErrorReason {
  const message = error instanceof Error ? error.message : "";
  if (/disk I\/O/i.test(message)) return "storage_io_error";
  if (/unable to open|readonly|permission|operation not permitted|command store is unavailable/i.test(message)) return "storage_unavailable";
  return "unexpected_error";
}
