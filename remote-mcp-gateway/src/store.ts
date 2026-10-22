import { createHash } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export type ClientKind = "dcr" | "cimd";
export const MAX_CLIENT_REDIRECT_URIS = 10;
export type DoorClient = {
  clientId: string;
  clientName: string;
  redirectUris: string[];
  redirectHosts: string[];
  /** First registered redirect, retained as a compatibility alias for single-URI clients. */
  redirectUri: string;
  /** Host of the first registered redirect. */
  redirectHost: string;
  kind: ClientKind;
  status: "pending" | "active" | "revoked";
  approvalStatus: "pending" | "approved" | "rejected";
  createdAt: number;
  approvedAt?: number;
  rejectedAt?: number;
  authorizedAt?: number;
  lastUsedAt?: number;
  refreshExpiresAt?: number;
};

export type DoorClientRegistration = {
  clientId: string;
  clientName: string;
  kind: ClientKind;
  redirectUris?: string[];
  redirectUri?: string;
  redirectHost?: string;
};

export type OAuthTransaction = {
  id: string;
  clientId: string;
  redirectUri: string;
  clientState: string;
  scope: string;
  resource: string;
  codeChallenge: string;
  googleState: string;
  googleNonce: string;
  csrfHash: string;
  expiresAt: number;
  googleVerified: boolean;
};

export type AccessTokenRecord = { clientId: string; scopes: string[]; resource: string; expiresAt: number };
export type RefreshTokenRecord = { clientId: string; familyId: string; scope: string; resource: string; expiresAt: number; status: "active" | "used" | "revoked" };

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export class GatewayStore {
  readonly db: DatabaseSync;
  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    chmodSync(path, 0o600);
    this.db.exec(`
      PRAGMA journal_mode = DELETE;
      PRAGMA synchronous = FULL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS clients (
        client_id TEXT PRIMARY KEY,
        client_name TEXT NOT NULL,
        redirect_uri TEXT NOT NULL,
        redirect_host TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('dcr','cimd')),
        status TEXT NOT NULL CHECK(status IN ('pending','active','revoked')),
        created_at INTEGER NOT NULL,
        authorized_at INTEGER,
        last_used_at INTEGER,
        revoked_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS oauth_transactions (
        id TEXT PRIMARY KEY,
        client_id TEXT NOT NULL REFERENCES clients(client_id) ON DELETE CASCADE,
        redirect_uri TEXT NOT NULL,
        client_state TEXT NOT NULL,
        scope TEXT NOT NULL,
        resource TEXT NOT NULL,
        code_challenge TEXT NOT NULL,
        google_state TEXT NOT NULL UNIQUE,
        google_nonce TEXT NOT NULL,
        csrf_hash TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        google_verified INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS authorization_codes (
        code_hash TEXT PRIMARY KEY,
        client_id TEXT NOT NULL REFERENCES clients(client_id) ON DELETE CASCADE,
        redirect_uri TEXT NOT NULL,
        scope TEXT NOT NULL,
        resource TEXT NOT NULL,
        code_challenge TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        consumed_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS access_tokens (
        token_hash TEXT PRIMARY KEY,
        client_id TEXT NOT NULL REFERENCES clients(client_id) ON DELETE CASCADE,
        scope TEXT NOT NULL,
        resource TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        revoked_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS refresh_tokens (
        token_hash TEXT PRIMARY KEY,
        client_id TEXT NOT NULL REFERENCES clients(client_id) ON DELETE CASCADE,
        family_id TEXT NOT NULL,
        scope TEXT NOT NULL,
        resource TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('active','used','revoked')),
        created_at INTEGER NOT NULL,
        used_at INTEGER,
        replaced_by_hash TEXT
      );
      CREATE TABLE IF NOT EXISTS gateway_status (
        name TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS approved_redirect_uris (
        redirect_uri TEXT PRIMARY KEY,
        approved_at INTEGER NOT NULL,
        approved_by_client_id TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS client_redirect_uris (
        client_id TEXT NOT NULL REFERENCES clients(client_id) ON DELETE CASCADE,
        redirect_uri TEXT NOT NULL,
        redirect_host TEXT NOT NULL,
        position INTEGER NOT NULL,
        PRIMARY KEY(client_id,redirect_uri),
        UNIQUE(client_id,position)
      );
      CREATE INDEX IF NOT EXISTS idx_access_client ON access_tokens(client_id);
      CREATE INDEX IF NOT EXISTS idx_refresh_client ON refresh_tokens(client_id);
      CREATE INDEX IF NOT EXISTS idx_client_redirect_uri ON client_redirect_uris(redirect_uri);
    `);
    ensureColumn(this.db, "refresh_tokens", "scope", "TEXT NOT NULL DEFAULT 'mcp:read'");
    ensureColumn(this.db, "refresh_tokens", "resource", "TEXT NOT NULL DEFAULT ''");
    ensureColumn(this.db, "clients", "approval_status", "TEXT NOT NULL DEFAULT 'approved' CHECK(approval_status IN ('pending','approved','rejected'))");
    ensureColumn(this.db, "clients", "approved_at", "INTEGER");
    ensureColumn(this.db, "clients", "rejected_at", "INTEGER");
    this.db.exec(`
      INSERT OR IGNORE INTO client_redirect_uris(client_id,redirect_uri,redirect_host,position)
        SELECT client_id,redirect_uri,redirect_host,0 FROM clients;
      UPDATE clients SET approved_at = COALESCE(approved_at, authorized_at, created_at) WHERE approval_status = 'approved';
      INSERT OR IGNORE INTO approved_redirect_uris(redirect_uri,approved_at,approved_by_client_id)
        SELECT r.redirect_uri,COALESCE(c.approved_at,c.authorized_at,c.created_at),c.client_id
        FROM client_redirect_uris r JOIN clients c ON c.client_id = r.client_id WHERE c.approval_status = 'approved';
    `);
  }

  close(): void { this.db.close(); }

  cleanup(now: number, pendingTtlSeconds: number): DoorClient[] {
    this.db.prepare("DELETE FROM oauth_transactions WHERE expires_at <= ?").run(now);
    this.db.prepare("DELETE FROM authorization_codes WHERE expires_at <= ? OR consumed_at IS NOT NULL").run(now - 86_400);
    this.db.prepare("DELETE FROM access_tokens WHERE expires_at <= ?").run(now - 86_400);
    const expiredRows = this.db.prepare("SELECT * FROM clients WHERE approval_status = 'pending' AND created_at <= ? ORDER BY created_at,client_id")
      .all(now - pendingTtlSeconds) as Array<Record<string, unknown>>;
    const expired = expiredRows.map((row) => this.clientFromRow(row));
    this.db.prepare("DELETE FROM clients WHERE approval_status = 'pending' AND created_at <= ?").run(now - pendingTtlSeconds);
    return expired;
  }

  clientCount(): number {
    return Number((this.db.prepare("SELECT COUNT(*) AS count FROM clients WHERE status != 'revoked'").get() as { count: number }).count);
  }

  pendingClientCount(): number {
    return Number((this.db.prepare("SELECT COUNT(*) AS count FROM clients WHERE approval_status = 'pending' AND status != 'revoked'").get() as { count: number }).count);
  }

  seedApprovedRedirectUris(redirectUris: string[], now: number): void {
    const insert = this.db.prepare("INSERT OR IGNORE INTO approved_redirect_uris(redirect_uri,approved_at,approved_by_client_id) VALUES(?,?,?)");
    for (const redirectUri of redirectUris) insert.run(redirectUri, now, "bootstrap-config");
  }

  isRedirectApproved(redirectUri: string): boolean {
    return Boolean(this.db.prepare("SELECT 1 FROM approved_redirect_uris WHERE redirect_uri = ?").get(redirectUri));
  }

  areRedirectsApproved(redirectUris: string[]): boolean {
    return redirectUris.length > 0 && redirectUris.every((redirectUri) => this.isRedirectApproved(redirectUri));
  }

  registerClient(client: DoorClientRegistration, now: number, approvalStatus: DoorClient["approvalStatus"]): DoorClient {
    const redirects = normalizeClientRedirects(client);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare(`INSERT INTO clients(client_id,client_name,redirect_uri,redirect_host,kind,status,approval_status,created_at,approved_at,rejected_at)
        VALUES(?,?,?,?,?,'pending',?,?,?,NULL)`).run(client.clientId, client.clientName, redirects[0]!.uri, redirects[0]!.host, client.kind,
          approvalStatus, now, approvalStatus === "approved" ? now : null);
      const insertRedirect = this.db.prepare("INSERT INTO client_redirect_uris(client_id,redirect_uri,redirect_host,position) VALUES(?,?,?,?)");
      redirects.forEach((redirect, position) => insertRedirect.run(client.clientId, redirect.uri, redirect.host, position));
      this.db.exec("COMMIT");
      return this.getClient(client.clientId)!;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  upsertCimdClient(client: DoorClientRegistration, now: number, approvalStatus: DoorClient["approvalStatus"]): DoorClient {
    const redirects = normalizeClientRedirects(client).map((item) => item.uri);
    const existing = this.getClient(client.clientId);
    if (existing) {
      if (existing.status === "revoked") throw new Error("client is revoked");
      if (!sameStrings(existing.redirectUris, redirects)) throw new Error("client metadata changed its redirect URIs");
      return existing;
    }
    return this.registerClient({ clientId: client.clientId, clientName: client.clientName, kind: client.kind, redirectUris: redirects }, now, approvalStatus);
  }

  approveClient(clientId: string, now: number): DoorClient | undefined {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const current = this.getClient(clientId);
      if (!current || current.status === "revoked" || current.approvalStatus !== "pending") { this.db.exec("ROLLBACK"); return undefined; }
      const approveRedirect = this.db.prepare("INSERT OR IGNORE INTO approved_redirect_uris(redirect_uri,approved_at,approved_by_client_id) VALUES(?,?,?)");
      for (const redirectUri of current.redirectUris) approveRedirect.run(redirectUri, now, current.clientId);
      this.db.prepare("UPDATE clients SET approval_status = 'approved', approved_at = ?, rejected_at = NULL WHERE client_id = ? AND approval_status = 'pending'")
        .run(now, current.clientId);
      this.db.exec("COMMIT");
      return this.getClient(clientId);
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  rejectClient(clientId: string, now: number): DoorClient | undefined {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const current = this.getClient(clientId);
      if (!current || current.status === "revoked" || current.approvalStatus !== "pending") { this.db.exec("ROLLBACK"); return undefined; }
      this.db.prepare("UPDATE clients SET approval_status = 'rejected', rejected_at = ?, status = 'revoked', revoked_at = ? WHERE client_id = ? AND approval_status = 'pending'")
        .run(now, now, current.clientId);
      this.db.prepare("DELETE FROM oauth_transactions WHERE client_id = ?").run(current.clientId);
      this.db.exec("COMMIT");
      return this.getClient(clientId);
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  getClient(clientId: string): DoorClient | undefined {
    const row = this.db.prepare("SELECT * FROM clients WHERE client_id = ?").get(clientId) as Record<string, unknown> | undefined;
    return row ? this.clientFromRow(row) : undefined;
  }

  createTransaction(transaction: OAuthTransaction): void {
    this.db.prepare(`INSERT INTO oauth_transactions(id,client_id,redirect_uri,client_state,scope,resource,code_challenge,google_state,google_nonce,csrf_hash,expires_at,google_verified)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(transaction.id, transaction.clientId, transaction.redirectUri, transaction.clientState, transaction.scope,
        transaction.resource, transaction.codeChallenge, transaction.googleState, transaction.googleNonce, transaction.csrfHash,
        transaction.expiresAt, transaction.googleVerified ? 1 : 0);
  }

  transactionByGoogleState(state: string): OAuthTransaction | undefined {
    return transactionFromRow(this.db.prepare("SELECT * FROM oauth_transactions WHERE google_state = ?").get(state) as Record<string, unknown> | undefined);
  }

  transactionById(id: string): OAuthTransaction | undefined {
    return transactionFromRow(this.db.prepare("SELECT * FROM oauth_transactions WHERE id = ?").get(id) as Record<string, unknown> | undefined);
  }

  markGoogleVerified(id: string): void {
    const result = this.db.prepare("UPDATE oauth_transactions SET google_verified = 1 WHERE id = ?").run(id);
    if (result.changes !== 1) throw new Error("authorization transaction is unavailable");
  }

  deleteTransaction(id: string): void { this.db.prepare("DELETE FROM oauth_transactions WHERE id = ?").run(id); }

  createAuthorizationCode(codeHash: string, transaction: OAuthTransaction, expiresAt: number, now: number): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const current = this.transactionById(transaction.id);
      const client = current ? this.getClient(current.clientId) : undefined;
      if (!current?.googleVerified || current.expiresAt <= now || client?.approvalStatus !== "approved") throw new Error("authorization transaction is unavailable");
      this.db.prepare(`INSERT INTO authorization_codes(code_hash,client_id,redirect_uri,scope,resource,code_challenge,expires_at)
        VALUES(?,?,?,?,?,?,?)`).run(codeHash, current.clientId, current.redirectUri, current.scope, current.resource, current.codeChallenge, expiresAt);
      this.db.prepare("UPDATE clients SET status = 'active', authorized_at = ?, revoked_at = NULL WHERE client_id = ?").run(now, current.clientId);
      this.db.prepare("DELETE FROM oauth_transactions WHERE id = ?").run(current.id);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  consumeAuthorizationCode(codeHash: string, clientId: string, redirectUri: string, codeChallenge: string, now: number): { scope: string; resource: string } | undefined {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db.prepare("SELECT * FROM authorization_codes WHERE code_hash = ?").get(codeHash) as Record<string, unknown> | undefined;
      if (!row || row.client_id !== clientId || row.redirect_uri !== redirectUri || row.code_challenge !== codeChallenge || Number(row.expires_at) <= now || row.consumed_at !== null) {
        this.db.exec("ROLLBACK");
        return undefined;
      }
      this.db.prepare("UPDATE authorization_codes SET consumed_at = ? WHERE code_hash = ? AND consumed_at IS NULL").run(now, codeHash);
      this.db.exec("COMMIT");
      return { scope: String(row.scope), resource: String(row.resource) };
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* transaction already closed */ }
      throw error;
    }
  }

  issueTokenPair(values: { accessHash: string; refreshHash: string; clientId: string; scope: string; resource: string; accessExpiresAt: number; refreshExpiresAt: number; familyId: string; now: number }): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("INSERT INTO access_tokens(token_hash,client_id,scope,resource,expires_at) VALUES(?,?,?,?,?)")
        .run(values.accessHash, values.clientId, values.scope, values.resource, values.accessExpiresAt);
      this.db.prepare("INSERT INTO refresh_tokens(token_hash,client_id,family_id,scope,resource,expires_at,status,created_at) VALUES(?,?,?,?,?,?, 'active', ?)")
        .run(values.refreshHash, values.clientId, values.familyId, values.scope, values.resource, values.refreshExpiresAt, values.now);
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  accessToken(tokenHash: string, now: number): AccessTokenRecord | undefined {
    const row = this.db.prepare(`SELECT a.client_id,a.scope,a.resource,a.expires_at FROM access_tokens a
      JOIN clients c ON c.client_id = a.client_id
      WHERE a.token_hash = ? AND a.revoked_at IS NULL AND a.expires_at > ? AND c.status = 'active'`).get(tokenHash, now) as Record<string, unknown> | undefined;
    return row ? { clientId: String(row.client_id), scopes: String(row.scope).split(" ").filter(Boolean), resource: String(row.resource), expiresAt: Number(row.expires_at) } : undefined;
  }

  refreshToken(tokenHash: string): RefreshTokenRecord | undefined {
    const row = this.db.prepare("SELECT client_id,family_id,scope,resource,expires_at,status FROM refresh_tokens WHERE token_hash = ?").get(tokenHash) as Record<string, unknown> | undefined;
    return row ? { clientId: String(row.client_id), familyId: String(row.family_id), scope: String(row.scope), resource: String(row.resource), expiresAt: Number(row.expires_at), status: String(row.status) as RefreshTokenRecord["status"] } : undefined;
  }

  rotateRefreshToken(values: { oldHash: string; accessHash: string; refreshHash: string; clientId: string; familyId: string; scope: string; resource: string; accessExpiresAt: number; refreshExpiresAt: number; now: number }): "rotated" | "reused" | "invalid" {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db.prepare("SELECT status,expires_at,client_id,family_id FROM refresh_tokens WHERE token_hash = ?").get(values.oldHash) as Record<string, unknown> | undefined;
      if (!row || row.client_id !== values.clientId || row.family_id !== values.familyId || Number(row.expires_at) <= values.now || row.status === "revoked") {
        this.db.exec("ROLLBACK"); return "invalid";
      }
      if (row.status === "used") {
        this.revokeClientWithinTransaction(values.clientId, values.now);
        this.db.exec("COMMIT"); return "reused";
      }
      this.db.prepare("UPDATE refresh_tokens SET status = 'used', used_at = ?, replaced_by_hash = ? WHERE token_hash = ? AND status = 'active'")
        .run(values.now, values.refreshHash, values.oldHash);
      this.db.prepare("INSERT INTO access_tokens(token_hash,client_id,scope,resource,expires_at) VALUES(?,?,?,?,?)")
        .run(values.accessHash, values.clientId, values.scope, values.resource, values.accessExpiresAt);
      this.db.prepare("INSERT INTO refresh_tokens(token_hash,client_id,family_id,scope,resource,expires_at,status,created_at) VALUES(?,?,?,?,?,?, 'active', ?)")
        .run(values.refreshHash, values.clientId, values.familyId, values.scope, values.resource, values.refreshExpiresAt, values.now);
      this.db.exec("COMMIT"); return "rotated";
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  markClientUsed(clientId: string, now: number): void {
    this.db.prepare("UPDATE clients SET last_used_at = ? WHERE client_id = ? AND status = 'active'").run(now, clientId);
  }

  revokeClient(clientId: string, now: number): boolean {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const changes = this.revokeClientWithinTransaction(clientId, now);
      this.db.exec("COMMIT"); return changes > 0;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  revokeAll(now: number): number {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const clients = this.db.prepare("UPDATE clients SET status = 'revoked', revoked_at = ? WHERE status != 'revoked'").run(now).changes;
      this.db.prepare("UPDATE access_tokens SET revoked_at = ? WHERE revoked_at IS NULL").run(now);
      this.db.prepare("UPDATE refresh_tokens SET status = 'revoked' WHERE status = 'active'").run();
      this.db.exec("COMMIT"); return Number(clients);
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  private revokeClientWithinTransaction(clientId: string, now: number): number {
    const changes = this.db.prepare("UPDATE clients SET status = 'revoked', revoked_at = ? WHERE client_id = ? AND status != 'revoked'").run(now, clientId).changes;
    this.db.prepare("UPDATE access_tokens SET revoked_at = ? WHERE client_id = ? AND revoked_at IS NULL").run(now, clientId);
    this.db.prepare("UPDATE refresh_tokens SET status = 'revoked' WHERE client_id = ? AND status = 'active'").run(clientId);
    return Number(changes);
  }

  setMasterSwitch(value: "alive" | "revoked" | "unknown", now: number): void {
    this.db.prepare(`INSERT INTO gateway_status(name,value,updated_at) VALUES('google_master_switch',?,?)
      ON CONFLICT(name) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`).run(value, now);
  }

  masterSwitch(): { value: "alive" | "revoked" | "unknown"; updatedAt: number } {
    const row = this.db.prepare("SELECT value,updated_at FROM gateway_status WHERE name = 'google_master_switch'").get() as Record<string, unknown> | undefined;
    return row ? { value: String(row.value) as "alive" | "revoked" | "unknown", updatedAt: Number(row.updated_at) } : { value: "unknown", updatedAt: 0 };
  }

  listClients(): DoorClient[] {
    const rows = this.db.prepare(`SELECT c.*,(SELECT MAX(expires_at) FROM refresh_tokens r WHERE r.client_id=c.client_id AND r.status='active') AS refresh_expires_at
      FROM clients c ORDER BY c.created_at,c.client_id`).all() as Array<Record<string, unknown>>;
    return rows.map((row) => this.clientFromRow(row));
  }

  listPendingClients(): DoorClient[] {
    const rows = this.db.prepare("SELECT * FROM clients WHERE approval_status = 'pending' AND status != 'revoked' ORDER BY created_at,client_id")
      .all() as Array<Record<string, unknown>>;
    return rows.map((row) => this.clientFromRow(row));
  }

  private clientFromRow(row: Record<string, unknown>): DoorClient {
    const redirects = this.db.prepare("SELECT redirect_uri,redirect_host FROM client_redirect_uris WHERE client_id = ? ORDER BY position")
      .all(String(row.client_id)) as Array<Record<string, unknown>>;
    return clientFromRow(row, redirects);
  }
}

function ensureColumn(db: DatabaseSync, table: string, column: string, definition: string): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<Record<string, unknown>>;
  if (!columns.some((item) => item.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

function clientFromRow(row: Record<string, unknown>, redirectRows: Array<Record<string, unknown>>): DoorClient {
  const redirects = redirectRows.length > 0
    ? redirectRows.map((redirect) => ({ uri: String(redirect.redirect_uri), host: String(redirect.redirect_host) }))
    : [{ uri: String(row.redirect_uri), host: String(row.redirect_host) }];
  return {
    clientId: String(row.client_id), clientName: String(row.client_name),
    redirectUris: redirects.map((redirect) => redirect.uri), redirectHosts: redirects.map((redirect) => redirect.host),
    redirectUri: redirects[0]!.uri, redirectHost: redirects[0]!.host,
    kind: String(row.kind) as ClientKind, status: String(row.status) as DoorClient["status"],
    approvalStatus: String(row.approval_status ?? "approved") as DoorClient["approvalStatus"], createdAt: Number(row.created_at),
    ...(row.approved_at === null || row.approved_at === undefined ? {} : { approvedAt: Number(row.approved_at) }),
    ...(row.rejected_at === null || row.rejected_at === undefined ? {} : { rejectedAt: Number(row.rejected_at) }),
    ...(row.authorized_at === null || row.authorized_at === undefined ? {} : { authorizedAt: Number(row.authorized_at) }),
    ...(row.last_used_at === null || row.last_used_at === undefined ? {} : { lastUsedAt: Number(row.last_used_at) }),
    ...(row.refresh_expires_at === null || row.refresh_expires_at === undefined ? {} : { refreshExpiresAt: Number(row.refresh_expires_at) }),
  };
}

function normalizeClientRedirects(client: DoorClientRegistration): Array<{ uri: string; host: string }> {
  const values = client.redirectUris ?? (client.redirectUri ? [client.redirectUri] : []);
  const unique = [...new Set(values)];
  if (unique.length < 1 || unique.length > MAX_CLIENT_REDIRECT_URIS) throw new Error("client redirect URI count is invalid");
  return unique.map((uri) => {
    let host: string;
    try { host = new URL(uri).hostname; }
    catch { throw new Error("client redirect URI is invalid"); }
    return { uri, host };
  });
}

function sameStrings(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function transactionFromRow(row: Record<string, unknown> | undefined): OAuthTransaction | undefined {
  if (!row) return undefined;
  return {
    id: String(row.id), clientId: String(row.client_id), redirectUri: String(row.redirect_uri), clientState: String(row.client_state),
    scope: String(row.scope), resource: String(row.resource), codeChallenge: String(row.code_challenge), googleState: String(row.google_state),
    googleNonce: String(row.google_nonce), csrfHash: String(row.csrf_hash), expiresAt: Number(row.expires_at), googleVerified: Number(row.google_verified) === 1,
  };
}
