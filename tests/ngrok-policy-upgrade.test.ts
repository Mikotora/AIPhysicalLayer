import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

test("ngrok upgrade keeps two rules and one existing endpoint while adding only exact Common Door paths", () => {
  const directory = mkdtempSync(join(tmpdir(), "aipl-policy-test-"));
  const policy = join(directory, "policy.yml");
  const source = `on_http_request:\n  - expressions:\n      - "!req.url.path.startsWith('/ai/v1/')"\n    actions:\n      - type: oauth\n  - expressions:\n      - "!req.url.path.startsWith('/ai/v1/') && !(actions.ngrok.oauth.identity.email in ['allowed@example.invalid'])"\n    actions:\n      - type: deny\n`;
  writeFileSync(policy, source, { mode: 0o600 });
  try {
    const result = spawnSync(process.execPath, ["scripts/upgrade-ngrok-policy.ts", policy], { cwd: new URL("../", import.meta.url), encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    const upgraded = readFileSync(policy, "utf8");
    assert.equal((upgraded.match(/^  - expressions:/gm) ?? []).length, 2);
    assert.match(upgraded, /req\.url\.path in \[/);
    assert.match(upgraded, /'\/mcp'/);
    assert.match(upgraded, /'\/oauth\/token'/);
    assert.doesNotMatch(upgraded, /startsWith\('\/oauth/);
    assert.equal(readFileSync(`${policy}.pre-common-door.backup`, "utf8"), source);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
