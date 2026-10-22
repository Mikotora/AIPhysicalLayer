import test from "node:test";
import assert from "node:assert/strict";
import { parseSecureMcpTunnelConfig, tunnelHealthReady } from "../src/secure-tunnel.ts";

test("Secure MCP Tunnel runtime stays file-backed and loopback-only", () => {
  const value = parseSecureMcpTunnelConfig({
    binary: ".runtime/bin/tunnel-client",
    profileFile: ".runtime/tunnel-client/profiles/local.yaml",
    healthUrl: "http://127.0.0.1:8793",
  }, "/private/example");
  assert.equal(value.binary, "/private/example/.runtime/bin/tunnel-client");
  assert.equal(value.profileFile, "/private/example/.runtime/tunnel-client/profiles/local.yaml");
  assert.equal(value.healthUrl, "http://127.0.0.1:8793");
  assert.equal(tunnelHealthReady("live", "ready"), true);
  assert.equal(tunnelHealthReady("live", "not ready"), false);
  assert.equal(tunnelHealthReady("ok", "ready"), false);
});

test("Secure MCP Tunnel health surface cannot be configured as a public URL", () => {
  for (const healthUrl of ["https://example.com", "http://0.0.0.0:8793", "http://127.0.0.1:8793/ui"]) {
    assert.throws(() => parseSecureMcpTunnelConfig({
      binary: "tunnel-client",
      profileFile: "profile.yaml",
      healthUrl,
    }, "/private/example"), /loopback HTTP origin/);
  }
});
