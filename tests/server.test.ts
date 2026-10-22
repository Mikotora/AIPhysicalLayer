import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { AddressInfo } from "node:net";
import { createAppServer } from "../src/server.ts";
import { ClientAuthenticator } from "../src/auth.ts";
import { MemoryActionLog } from "../src/logger.ts";
import { MemoryCommandStore } from "../src/command-store.ts";
import { MockAdapter } from "../src/adapters/mock.ts";

const KEY = "test-ai-client-key-1234567890-abcdef";
const authenticator = new ClientAuthenticator([{ id: "chatgpt", key_sha256: createHash("sha256").update(KEY).digest("hex"), enabled: true }]);

async function start() {
  const log = new MemoryActionLog();
  const server = createAppServer({ config: { mode: "mock", nature: null }, authenticator, logWriter: log, commandStore: new MemoryCommandStore() });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, log, origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}
const auth = { Authorization: `Bearer ${KEY}` };

test("AI capability and state contracts require a client key", async (context) => {
  const value = await start(); context.after(() => new Promise<void>((resolve) => value.server.close(() => resolve())));
  assert.equal((await fetch(`${value.origin}/api/v1/capabilities`)).status, 401);
  const capabilities = await fetch(`${value.origin}/api/v1/capabilities`, { headers: auth });
  assert.equal(capabilities.status, 200);
  const capabilityBody = await capabilities.json() as any;
  assert.equal(capabilityBody.schema_version, "1.0");
  assert.equal(capabilityBody.devices.length, 7);
  assert.equal(capabilityBody.execution_policy.mode, "catalog-bound-direct");
  assert.equal(capabilityBody.execution_policy.allowlist.length, 48);
  assert.ok(capabilityBody.devices.flatMap((device: any) => device.actions).every((action: any) => action.execution_allowed));
  const state = await fetch(`${value.origin}/api/v1/state`, { headers: auth });
  assert.equal(state.status, 200);
  const stateBody = await state.json() as any;
  assert.equal(stateBody.schema_version, "1.0");
  assert.equal(stateBody.perceptions.length, 2);
});

test("AI action contract identifies the client and preserves idempotency", async (context) => {
  const value = await start(); context.after(() => new Promise<void>((resolve) => value.server.close(() => resolve())));
  const call = (key: string) => fetch(`${value.origin}/api/v1/actions`, { method: "POST", headers: { ...auth, "Content-Type": "application/json", "Idempotency-Key": key }, body: JSON.stringify({ action_id: "light.living_room.off", parameters: {} }) });
  const first = await call("api-intent-1"); const replay = await call("api-intent-1"); const next = await call("api-intent-2");
  assert.equal(first.status, 201); assert.equal(replay.status, 200); assert.equal(next.status, 201);
  const firstBody = await first.json() as any; const replayBody = await replay.json() as any; const nextBody = await next.json() as any;
  assert.equal(replayBody.command_id, firstBody.command_id); assert.notEqual(nextBody.command_id, firstBody.command_id);
  assert.deepEqual(value.log.entries.map((entry) => entry.client_id), ["chatgpt", "chatgpt", "chatgpt"]);
});

test("out-of-range parameters and unregistered actions are rejected without execution", async (context) => {
  const value = await start(); context.after(() => new Promise<void>((resolve) => value.server.close(() => resolve())));
  const response = await fetch(`${value.origin}/api/v1/actions`, { method: "POST", headers: { ...auth, "Content-Type": "application/json", "Idempotency-Key": "bad-channel" }, body: JSON.stringify({ action_id: "media.tv.channel.select", parameters: { channel: 13 } }) });
  const unregistered = await fetch(`${value.origin}/api/v1/actions`, { method: "POST", headers: { ...auth, "Content-Type": "application/json", "Idempotency-Key": "scene" }, body: JSON.stringify({ action_id: "automation.scene.execute", parameters: {} }) });
  assert.equal(response.status, 400); assert.equal(unregistered.status, 400);
  assert.equal(value.log.entries[0].status, "rejected");
});

test("AI action contract cannot accept raw appliance or signal IDs", async (context) => {
  const value = await start(); context.after(() => new Promise<void>((resolve) => value.server.close(() => resolve())));
  const call = (parameters: Record<string, unknown>, key: string) => fetch(`${value.origin}/api/v1/actions`, { method: "POST", headers: { ...auth, "Content-Type": "application/json", "Idempotency-Key": key }, body: JSON.stringify({ action_id: "light.living_room.off", parameters }) });
  assert.equal((await call({ appliance_id: "raw" }, "raw-appliance")).status, 400);
  assert.equal((await call({ signal_id: "raw" }, "raw-signal")).status, 400);
  assert.equal(value.log.entries.length, 2);
  assert.ok(value.log.entries.every((entry) => entry.status === "rejected"));
});

test("revoked client key fails independently", async (context) => {
  const revoked = new ClientAuthenticator([{ id: "grok", key_sha256: createHash("sha256").update(KEY).digest("hex"), enabled: false }]);
  const server = createAppServer({ config: { mode: "mock", nature: null }, authenticator: revoked, commandStore: new MemoryCommandStore() });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve)); context.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  assert.equal((await fetch(`${origin}/api/v1/state`, { headers: auth })).status, 401);
});

test("state adapter failure returns unknown state while capabilities remain available", async (context) => {
  const adapter = new MockAdapter();
  adapter.readState = async () => { throw new Error("simulated read failure"); };
  const server = createAppServer({ config: { mode: "mock", nature: null }, authenticator, commandStore: new MemoryCommandStore(), adapter });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve)); context.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const stateResponse = await fetch(`${origin}/api/v1/state`, { headers: auth });
  assert.equal(stateResponse.status, 200);
  const state = await stateResponse.json() as any;
  assert.equal(state.devices.length, 7);
  assert.ok(state.devices.flatMap((device: any) => Object.values(device.fields)).every((field: any) => field.status === "unknown"));
  assert.deepEqual(state.perceptions.map((item: any) => item.status), ["unknown", "unknown"]);
  assert.equal((await fetch(`${origin}/api/v1/capabilities`, { headers: auth })).status, 200);
});
