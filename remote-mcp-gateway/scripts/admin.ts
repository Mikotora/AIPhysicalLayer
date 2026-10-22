import { createHash } from "node:crypto";
import { FileGatewayAudit } from "../src/audit.ts";
import { GatewayStore } from "../src/store.ts";

const databaseFile = process.env.REMOTE_MCP_DATABASE_FILE;
const auditLogFile = process.env.REMOTE_MCP_AUDIT_LOG_FILE;
const pendingClientTtlSeconds = Number(process.env.REMOTE_MCP_PENDING_CLIENT_TTL_SECONDS ?? "3600");
const action = process.argv[2];
const clientId = process.argv[3];
if (!databaseFile || !auditLogFile || !Number.isInteger(pendingClientTtlSeconds) || pendingClientTtlSeconds < 300
  || !["list", "pending", "approve", "reject", "revoke", "revoke-all"].includes(action ?? "")) {
  throw new Error("remote MCP admin configuration is incomplete");
}
const store = new GatewayStore(databaseFile);
const audit = new FileGatewayAudit(auditLogFile);
try {
  const now = Math.floor(Date.now() / 1_000);
  for (const expired of store.cleanup(now, pendingClientTtlSeconds)) audit.append(registrationAudit(expired, "expired", now));
  if (action === "list") {
    const clients = store.listClients();
    if (clients.length === 0) console.log("No Remote MCP clients are registered");
    for (const client of clients) {
      console.log(`${client.clientId}\t${client.clientName} (self-claimed)\t${client.redirectHost}\t${client.status}\tapproval=${client.approvalStatus}\tlast_used=${format(client.lastUsedAt)}\trefresh_expires=${format(client.refreshExpiresAt)}\tredirects=${client.redirectUris.length}\tdomains=${[...new Set(client.redirectHosts)].join(",")}`);
    }
    console.log(`google master switch: ${store.masterSwitch().value}`);
  } else if (action === "pending") {
    const clients = store.listPendingClients();
    if (clients.length === 0) console.log("No Remote MCP registrations await approval");
    for (const client of clients) {
      const groups = groupRedirects(client.redirectUris);
      console.log(`${client.clientId}\t${client.clientName} (self-claimed)\t${client.kind}\tredirects=${client.redirectUris.length}\tdomains=${groups.size}\tregistered_at=${format(client.createdAt)}`);
      for (const [host, redirectUris] of groups) {
        console.log(`  domain=${host}\tcount=${redirectUris.length}`);
        for (const redirectUri of redirectUris) console.log(`    ${redirectUri}`);
      }
    }
  } else if (action === "approve" || action === "reject") {
    if (!clientId) throw new Error(`client ID is required for ${action}`);
    const candidate = store.getClient(clientId);
    if (!candidate || candidate.status === "revoked" || candidate.approvalStatus !== "pending") throw new Error("pending client registration was not found");
    audit.append(registrationAudit(candidate, action === "approve" ? "approved" : "rejected", now));
    const changed = action === "approve" ? store.approveClient(clientId, now) : store.rejectClient(clientId, now);
    if (!changed) throw new Error("pending client registration changed before the decision was saved");
    console.log(`${action === "approve" ? "approved" : "rejected"} Remote MCP registration: ${clientId}`);
  } else if (action === "revoke") {
    if (!clientId) throw new Error("client ID is required");
    if (!store.revokeClient(clientId, now)) throw new Error("active client was not found");
    console.log(`revoked Remote MCP client: ${clientId}`);
  } else {
    const count = store.revokeAll(now);
    console.log(`revoked all Remote MCP clients: ${count}`);
  }
} finally { store.close(); }

function format(value: number | undefined): string { return value ? new Date(value * 1_000).toISOString() : "-"; }
function registrationAudit(client: { clientId: string; clientName: string; redirectHost: string; redirectHosts: string[]; redirectUris: string[]; kind: "dcr" | "cimd" }, decision: "approved" | "rejected" | "expired", now: number) {
  const redirectHosts = [...new Set(client.redirectHosts)];
  return {
    timestamp: new Date(now * 1_000).toISOString(), event: "client_registration" as const, decision,
    client_ref: createHash("sha256").update(client.clientId).digest("hex").slice(0, 16),
    client_name_claimed: client.clientName, client_kind: client.kind, redirect_host: client.redirectHost,
    redirect_hosts: redirectHosts, redirect_uri_count: client.redirectUris.length,
  };
}

function groupRedirects(redirectUris: string[]): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  for (const redirectUri of redirectUris) {
    const host = new URL(redirectUri).hostname;
    const current = groups.get(host) ?? [];
    current.push(redirectUri);
    groups.set(host, current);
  }
  return groups;
}
