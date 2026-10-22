import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GatewayCoreClient, GatewayCoreError } from "../src/core-client.ts";

function tokenFile() {
  const directory = mkdtempSync(join(tmpdir(), "aipl-door-core-client-"));
  const path = join(directory, "core.key");
  writeFileSync(path, "test-core-token-1234567890-abcdefghijklmnop\n", { mode: 0o600 });
  return { path, cleanup: () => rmSync(directory, { recursive: true, force: true }) };
}

test("gateway Core client sends one v1 action request with the supplied scoped idempotency key", async () => {
  const file = tokenFile();
  const requests: Array<{ input: string; init?: RequestInit }> = [];
  try {
    const client = new GatewayCoreClient(file.path, "http://127.0.0.1:8787", async (input, init) => {
      requests.push({ input: String(input), init });
      return Response.json({ status: "succeeded", action_id: "light.living_room.off" }, { status: 201 });
    });
    await client.executeAction("light.living_room.off", {}, "door.abcdef");
    assert.equal(requests.length, 1);
    assert.equal(requests[0].input, "http://127.0.0.1:8787/api/v1/actions");
    assert.equal(requests[0].init?.method, "POST");
    assert.equal((requests[0].init?.headers as Record<string, string>)["Idempotency-Key"], "door.abcdef");
    assert.deepEqual(JSON.parse(String(requests[0].init?.body)), { action_id: "light.living_room.off", parameters: {} });
  } finally { file.cleanup(); }
});

test("gateway Core client classifies an ambiguous action response as unknown and never retries", async () => {
  const file = tokenFile();
  let requests = 0;
  try {
    const client = new GatewayCoreClient(file.path, "http://127.0.0.1:8787", async () => {
      requests += 1;
      return Response.json({ error: "ambiguous", outcome: "unknown" }, { status: 502 });
    });
    await assert.rejects(client.executeAction("light.living_room.off", {}, "door.abcdef"), (error: unknown) => {
      assert.ok(error instanceof GatewayCoreError);
      assert.equal(error.classification, "unknown");
      return true;
    });
    assert.equal(requests, 1);
  } finally { file.cleanup(); }
});

test("gateway Core client preserves a temporary recording warning on action errors", async () => {
  const file = tokenFile();
  const recording = { status: "temporary", persistent: false, must_tell_user: true };
  try {
    const client = new GatewayCoreClient(file.path, "http://127.0.0.1:8787", async () =>
      Response.json({ error: "ambiguous", outcome: "unknown", recording }, { status: 502 }));
    await assert.rejects(client.executeAction("light.living_room.off", {}, "door.abcdef"), (error: unknown) => {
      assert.ok(error instanceof GatewayCoreError);
      assert.deepEqual(error.recording, recording);
      return true;
    });
  } finally { file.cleanup(); }
});
