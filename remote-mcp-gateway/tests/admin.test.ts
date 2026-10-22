import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { GatewayStore } from "../src/store.ts";

const ADMIN = fileURLToPath(new URL("../scripts/admin.ts", import.meta.url));

test("door registration admin lists exact pending metadata and records approve/reject decisions without secret values", () => {
  const directory = mkdtempSync(join(tmpdir(), "aipl-door-admin-test-"));
  const databaseFile = join(directory, "gateway.sqlite");
  const auditLogFile = join(directory, "audit.jsonl");
  const firstId = "dcr_pending_grok";
  const secondId = "dcr_pending_grok_bot";
  const firstRedirect = "https://grok.example/oauth/callback";
  const firstRedirectVariant = "https://grok.example/oauth/alternate";
  const firstRedirectOtherHost = "https://login.grok.example/oauth/callback";
  const secondRedirect = "https://bot.grok.example/oauth/callback";
  const secondRedirectVariant = "https://bot.grok.example/oauth/alternate";
  try {
    const store = new GatewayStore(databaseFile);
    const registeredAt = Math.floor(Date.now() / 1_000);
    store.registerClient({
      clientId: firstId,
      clientName: "Grok",
      redirectUris: [firstRedirect, firstRedirectVariant, firstRedirectOtherHost, firstRedirect],
      kind: "dcr",
    }, registeredAt, "pending");
    store.registerClient({ clientId: secondId, clientName: "Grok Bot", redirectUris: [secondRedirect, secondRedirectVariant], kind: "dcr" }, registeredAt + 1, "pending");
    store.close();

    const environment = {
      ...process.env,
      REMOTE_MCP_DATABASE_FILE: databaseFile,
      REMOTE_MCP_AUDIT_LOG_FILE: auditLogFile,
      REMOTE_MCP_PENDING_CLIENT_TTL_SECONDS: "3600",
    };
    const pending = spawnSync(process.execPath, [ADMIN, "pending"], { encoding: "utf8", env: environment });
    assert.equal(pending.status, 0, pending.stderr);
    assert.match(pending.stdout, /Grok \(self-claimed\)\tdcr\tredirects=3\tdomains=2\tregistered_at=/);
    assert.match(pending.stdout, /domain=grok\.example\tcount=2\n    https:\/\/grok\.example\/oauth\/callback\n    https:\/\/grok\.example\/oauth\/alternate/);
    assert.match(pending.stdout, /domain=login\.grok\.example\tcount=1\n    https:\/\/login\.grok\.example\/oauth\/callback/);
    assert.match(pending.stdout, /Grok Bot \(self-claimed\)\tdcr\tredirects=2\tdomains=1\tregistered_at=/);
    assert.match(pending.stdout, /domain=bot\.grok\.example\tcount=2\n    https:\/\/bot\.grok\.example\/oauth\/callback\n    https:\/\/bot\.grok\.example\/oauth\/alternate/);

    const approved = spawnSync(process.execPath, [ADMIN, "approve", firstId], { encoding: "utf8", env: environment });
    const rejected = spawnSync(process.execPath, [ADMIN, "reject", secondId], { encoding: "utf8", env: environment });
    assert.equal(approved.status, 0, approved.stderr);
    assert.equal(rejected.status, 0, rejected.stderr);

    const verified = new GatewayStore(databaseFile);
    assert.equal(verified.getClient(firstId)?.approvalStatus, "approved");
    assert.equal(verified.isRedirectApproved(firstRedirect), true);
    assert.equal(verified.isRedirectApproved(firstRedirectVariant), true);
    assert.equal(verified.isRedirectApproved(firstRedirectOtherHost), true);
    assert.deepEqual(verified.getClient(firstId)?.redirectUris, [firstRedirect, firstRedirectVariant, firstRedirectOtherHost]);
    assert.equal(verified.getClient(secondId)?.approvalStatus, "rejected");
    assert.equal(verified.getClient(secondId)?.status, "revoked");
    assert.equal(verified.isRedirectApproved(secondRedirect), false);
    assert.equal(verified.isRedirectApproved(secondRedirectVariant), false);
    verified.close();

    const auditText = readFileSync(auditLogFile, "utf8");
    const entries = auditText.trim().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(entries.map((item) => item.decision), ["approved", "rejected"]);
    assert.equal(entries[0].redirect_uri_count, 3);
    assert.deepEqual(entries[0].redirect_hosts, ["grok.example", "login.grok.example"]);
    assert.equal(entries[1].redirect_uri_count, 2);
    assert.deepEqual(entries[1].redirect_hosts, ["bot.grok.example"]);
    assert.equal(auditText.includes(firstId), false);
    assert.equal(auditText.includes(secondId), false);
    assert.equal(auditText.includes(firstRedirect), false);
    assert.equal(auditText.includes(firstRedirectVariant), false);
    assert.equal(auditText.includes(firstRedirectOtherHost), false);
    assert.equal(auditText.includes(secondRedirect), false);
    assert.equal(auditText.includes(secondRedirectVariant), false);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
