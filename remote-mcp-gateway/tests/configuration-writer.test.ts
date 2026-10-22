import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backupAndWriteDoorConfiguration, prepareDoorConfiguration } from "../src/configuration-writer.ts";

const GATEWAY = {
  allowedGoogleSub: "replace-with-the-one-allowed-google-sub",
  googleClientId: "replace-with-the-dedicated-google-oauth-client-id",
  bootstrapApprovedRedirectUris: ["https://claude.ai/api/mcp/auth_callback"],
  accessTokenTtlSeconds: 3_600,
};

test("interactive configuration adds the runtime block and backs up both JSON files before atomic mode-0600 replacement", () => {
  const directory = mkdtempSync(join(tmpdir(), "aipl-door-config-test-"));
  try {
    const gatewayPath = join(directory, "remote-mcp-gateway.json");
    const runtimePath = join(directory, "runtime.json");
    const backupDirectory = join(directory, ".runtime", "backups");
    const runtime = { publicOrigin: "https://door.example.invalid", existing: { preserved: true } };
    writeFileSync(gatewayPath, JSON.stringify(GATEWAY) + "\n");
    writeFileSync(runtimePath, JSON.stringify(runtime) + "\n");
    const oldGateway = readFileSync(gatewayPath, "utf8");
    const oldRuntime = readFileSync(runtimePath, "utf8");
    const prepared = prepareDoorConfiguration(GATEWAY, runtime, {
      googleClientId: "configured-google-client-id",
      allowedGoogleSub: "configured-google-sub",
      enabled: true,
    });
    const backups = backupAndWriteDoorConfiguration(gatewayPath, runtimePath, backupDirectory, prepared, new Date("2026-10-11T04:00:00Z"));
    assert.equal(readFileSync(backups.gatewayBackup, "utf8"), oldGateway);
    assert.equal(readFileSync(backups.runtimeBackup, "utf8"), oldRuntime);
    assert.equal(statSync(backups.gatewayBackup).mode & 0o777, 0o600);
    assert.equal(statSync(backups.runtimeBackup).mode & 0o777, 0o600);
    assert.equal(statSync(gatewayPath).mode & 0o777, 0o600);
    assert.equal(statSync(runtimePath).mode & 0o777, 0o600);
    const writtenGateway = JSON.parse(readFileSync(gatewayPath, "utf8"));
    const writtenRuntime = JSON.parse(readFileSync(runtimePath, "utf8"));
    assert.equal(writtenGateway.googleClientId, "configured-google-client-id");
    assert.equal(writtenGateway.allowedGoogleSub, "configured-google-sub");
    assert.deepEqual(writtenRuntime.existing, { preserved: true });
    assert.deepEqual(writtenRuntime.remoteMcpGateway, {
      enabled: true,
      configFile: "remote-mcp-gateway/config/remote-mcp-gateway.json",
      coreTokenFile: ".runtime/secrets/remote-mcp-gateway.key",
      databaseFile: "data/remote-mcp-gateway.sqlite",
      auditLogFile: "data/remote-mcp-access.jsonl",
    });
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("interactive configuration refuses placeholder identities without forcing a Claude-only callback list", () => {
  assert.throws(() => prepareDoorConfiguration(GATEWAY, {}, {
    googleClientId: "replace-with-client",
    allowedGoogleSub: "configured-google-sub",
    enabled: false,
  }), /client ID is invalid/);
  const prepared = prepareDoorConfiguration({ ...GATEWAY, bootstrapApprovedRedirectUris: ["https://example.com/callback"] }, {}, {
    googleClientId: "configured-google-client-id",
    allowedGoogleSub: "configured-google-sub",
    enabled: false,
  });
  assert.deepEqual(prepared.gateway.bootstrapApprovedRedirectUris, ["https://example.com/callback"]);
});
