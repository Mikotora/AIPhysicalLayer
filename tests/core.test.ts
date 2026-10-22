import test from "node:test";
import assert from "node:assert/strict";
import { ActionCore, ActionValidationError } from "../src/core.ts";
import { MockAdapter } from "../src/adapters/mock.ts";
import { MemoryActionLog } from "../src/logger.ts";
import { ActionPolicy } from "../src/action-policy.ts";
import { createDeviceRegistry } from "../src/registry.ts";
import { MemoryCommandStore } from "../src/command-store.ts";

const request = { device: "light.living_room", action: "off", parameters: {} };
function fixture(allowed?: string[]) {
  const adapter = new MockAdapter(); const log = new MemoryActionLog();
  return { adapter, log, core: new ActionCore([adapter], log, createDeviceRegistry("mock"), new ActionPolicy(allowed)) };
}

test("same intent replays once but a new intent may execute the same action again", async () => {
  const value = fixture();
  const first = await value.core.execute(request, { idempotencyKey: "intent-1", source: "ai-client", clientId: "chatgpt" });
  const replay = await value.core.execute(request, { idempotencyKey: "intent-1", source: "ai-client", clientId: "chatgpt" });
  const secondIntent = await value.core.execute(request, { idempotencyKey: "intent-2", source: "ai-client", clientId: "chatgpt" });
  assert.equal(replay.command_id, first.command_id);
  assert.equal(replay.replayed, true);
  assert.notEqual(secondIntent.command_id, first.command_id);
  assert.equal(value.adapter.executionCount, 2);
  assert.deepEqual(value.log.entries.map((entry) => entry.status), ["succeeded", "replayed", "succeeded"]);
  assert.ok(value.log.entries.every((entry) => entry.client_id === "chatgpt"));
});
test("same key cannot change action and unknown attempts are never auto-retried", async () => {
  const value = fixture(["light.living_room.off", "light.living_room.on"]);
  await value.core.execute(request, { idempotencyKey: "collision", source: "local-api" });
  await assert.rejects(value.core.execute({ ...request, action: "on" }, { idempotencyKey: "collision", source: "local-api" }), /different action/);
  value.adapter.failNext = "unknown";
  await assert.rejects(value.core.execute(request, { idempotencyKey: "unknown-intent", source: "local-api" }), /simulated/);
  await assert.rejects(value.core.execute(request, { idempotencyKey: "unknown-intent", source: "local-api" }), /already consumed/);
  assert.equal(value.adapter.executionCount, 1);
});

test("Catalog-outside operations and raw identifiers cannot reach an adapter", async () => {
  const value = fixture();
  await assert.rejects(value.core.execute({ device: "raw-appliance-id", action: "send", parameters: { signal_id: "raw-signal-id" } }, { idempotencyKey: "raw-id", source: "local-api" }), ActionValidationError);
  await assert.rejects(value.core.execute({ ...request, appliance_id: "raw-appliance-id" }, { idempotencyKey: "raw-field", source: "local-api" }), /unknown field/);
  assert.equal(value.adapter.executionCount, 0);
  assert.equal(value.log.entries[0].action_id, null);
  assert.equal(value.log.entries[0].status, "rejected");
});

test("state keeps observed values separate from last_command", async () => {
  const value = fixture();
  await value.core.execute(request, { idempotencyKey: "state-intent", source: "local-api" });
  const state = await value.core.readState();
  const light = state.devices.find((device) => device.device_id === "light.living_room");
  assert.equal(light?.fields.power.status, "observed");
  assert.equal(light?.last_command?.action_id, "light.living_room.off");
});

test("adapter state failure degrades every readable value to unknown without throwing", async () => {
  const adapter = new MockAdapter();
  adapter.readState = async () => { throw new TypeError("private upstream detail"); };
  const issues: Array<{ stage: string; reason: string }> = [];
  const core = new ActionCore([adapter], new MemoryActionLog(), createDeviceRegistry("mock"), new ActionPolicy(), new MemoryCommandStore(), (issue) => issues.push(issue));
  const state = await core.readState();
  assert.equal(state.devices.length, 7);
  assert.equal(state.devices.find((device) => device.device_id === "climate.living_room")?.fields.power.status, "unknown");
  assert.deepEqual(state.perceptions.map((item) => [item.perception_id, item.status]), [
    ["environment.living_room.temperature", "unknown"],
    ["environment.living_room.humidity", "unknown"],
  ]);
  assert.deepEqual(issues, [{ stage: "adapter", reason: "adapter_unavailable" }]);
});

test("last-command storage failure preserves observed current state", async () => {
  const adapter = new MockAdapter(); const store = new MemoryCommandStore();
  store.listLastCommands = () => { throw new Error("disk I/O error"); };
  const issues: Array<{ stage: string; reason: string }> = [];
  const core = new ActionCore([adapter], new MemoryActionLog(), createDeviceRegistry("mock"), new ActionPolicy(), store, (issue) => issues.push(issue));
  const state = await core.readState();
  assert.equal(state.devices.find((device) => device.device_id === "light.living_room")?.fields.power.status, "observed");
  assert.ok(state.devices.every((device) => device.last_command === undefined));
  assert.deepEqual(issues, [{ stage: "last_command_store", reason: "storage_io_error" }]);
});
