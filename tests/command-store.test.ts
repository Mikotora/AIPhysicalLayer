import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MemoryCommandStore, ResilientCommandStore, SqliteCommandStore } from "../src/command-store.ts";
import { ActionCore } from "../src/core.ts";
import { MockAdapter } from "../src/adapters/mock.ts";
import { MemoryActionLog } from "../src/logger.ts";
import { createDeviceRegistry } from "../src/registry.ts";
import { ActionPolicy } from "../src/action-policy.ts";

const request = { device: "light.living_room", action: "off", parameters: {} };
const context = { idempotencyKey: "persistent-intent", source: "ai-client", clientId: "integration-test" } as const;
function makeCore(adapter: MockAdapter, store: SqliteCommandStore) { return new ActionCore([adapter], new MemoryActionLog(), createDeviceRegistry("mock"), new ActionPolicy(), store); }

test("successful intent and last_command survive a Core restart", async (contextApi) => {
  const directory = await mkdtemp(join(tmpdir(), "aipl-store-")); contextApi.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "commands.sqlite");
  const firstAdapter = new MockAdapter(); const firstStore = new SqliteCommandStore(path); const first = makeCore(firstAdapter, firstStore);
  const response = await first.execute(request, context); firstStore.close();

  const secondAdapter = new MockAdapter(); const secondStore = new SqliteCommandStore(path); const second = makeCore(secondAdapter, secondStore);
  const replay = await second.execute(request, context);
  assert.equal(replay.command_id, response.command_id); assert.equal(replay.replayed, true); assert.equal(secondAdapter.executionCount, 0);
  const state = await second.readState();
  assert.equal(state.devices.find((device) => device.device_id === "light.living_room")?.last_command?.command_id, response.command_id);
  await second.execute(request, { ...context, idempotencyKey: "new-persistent-intent" });
  assert.equal(secondAdapter.executionCount, 1);
  secondStore.close();
});

test("unknown or interrupted intent remains consumed after restart", async (contextApi) => {
  const directory = await mkdtemp(join(tmpdir(), "aipl-store-")); contextApi.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "commands.sqlite");
  const failing = new MockAdapter(); failing.failNext = "unknown";
  const firstStore = new SqliteCommandStore(path); await assert.rejects(makeCore(failing, firstStore).execute(request, context)); firstStore.close();
  const secondAdapter = new MockAdapter(); const secondStore = new SqliteCommandStore(path);
  await assert.rejects(makeCore(secondAdapter, secondStore).execute(request, context), /already consumed/);
  assert.equal(secondAdapter.executionCount, 0); secondStore.close();
});

test("SQLite outage uses temporary memory idempotency, then new intents automatically return to SQLite", async (contextApi) => {
  const directory = await mkdtemp(join(tmpdir(), "aipl-store-")); contextApi.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "commands.sqlite");
  const events: Array<{ event: string; reason?: string }> = [];
  let available = false;
  const store = new ResilientCommandStore(path, {
    open: (value) => {
      if (!available) throw new Error("unable to open database file");
      return new SqliteCommandStore(value);
    },
    report: (event) => events.push(event),
  });
  const adapter = new MockAdapter();
  const core = new ActionCore([adapter], new MemoryActionLog(), createDeviceRegistry("mock"), new ActionPolicy(), store);

  const temporary = await core.execute(request, { ...context, idempotencyKey: "temporary-intent" });
  assert.equal(temporary.recording?.status, "temporary");
  assert.equal(temporary.recording?.must_tell_user, true);
  assert.match(temporary.recording?.message ?? "", /永続記録されていません/);
  const replay = await core.execute(request, { ...context, idempotencyKey: "temporary-intent" });
  assert.equal(replay.replayed, true);
  assert.equal(replay.recording?.duplicate_prevention, "temporary");
  assert.equal(adapter.executionCount, 1);
  const degradedState = await core.readState();
  assert.ok(degradedState.devices.every((device) => device.last_command === undefined));

  available = true;
  const persistent = await core.execute(request, { ...context, idempotencyKey: "persistent-after-recovery" });
  assert.equal(persistent.recording, undefined);
  assert.equal(adapter.executionCount, 2);
  const oldReplay = await core.execute(request, { ...context, idempotencyKey: "temporary-intent" });
  assert.equal(oldReplay.replayed, true);
  assert.equal(oldReplay.recording?.status, "temporary");
  assert.equal(adapter.executionCount, 2);
  assert.deepEqual(events, [
    { event: "degraded", reason: "storage_unavailable" },
    { event: "recovered" },
  ]);
  store.close();

  const restartedAdapter = new MockAdapter();
  const restartedStore = new SqliteCommandStore(path);
  const restarted = new ActionCore([restartedAdapter], new MemoryActionLog(), createDeviceRegistry("mock"), new ActionPolicy(), restartedStore);
  const persistentReplay = await restarted.execute(request, { ...context, idempotencyKey: "persistent-after-recovery" });
  assert.equal(persistentReplay.replayed, true);
  assert.equal(restartedAdapter.executionCount, 0);
  restartedStore.close();
});

test("unknown result during SQLite outage is marked temporary and the same intent is not resent", async () => {
  const store = new ResilientCommandStore("ignored.sqlite", { open: () => { throw new Error("disk I/O error"); } });
  const adapter = new MockAdapter(); adapter.failNext = "unknown";
  const core = new ActionCore([adapter], new MemoryActionLog(), createDeviceRegistry("mock"), new ActionPolicy(), store);
  await assert.rejects(core.execute(request, { ...context, idempotencyKey: "temporary-unknown" }), (error: unknown) => {
    assert.equal((error as { outcome?: string }).outcome, "unknown");
    assert.equal((error as { recording?: { status?: string } }).recording?.status, "temporary");
    return true;
  });
  await assert.rejects(core.execute(request, { ...context, idempotencyKey: "temporary-unknown" }), (error: unknown) => {
    assert.match((error as Error).message, /already consumed/);
    assert.equal((error as { recording?: { status?: string } }).recording?.status, "temporary");
    return true;
  });
  assert.equal(adapter.executionCount, 0);
});

test("a runtime SQLite write failure falls back after the adapter send and marks the result temporary", async () => {
  const primary = new MemoryCommandStore();
  primary.setLastCommand = () => { throw new Error("disk I/O error"); };
  let opens = 0;
  const store = new ResilientCommandStore("ignored.sqlite", {
    open: () => {
      opens += 1;
      if (opens === 1) return primary;
      throw new Error("disk I/O error");
    },
  });
  const adapter = new MockAdapter();
  const core = new ActionCore([adapter], new MemoryActionLog(), createDeviceRegistry("mock"), new ActionPolicy(), store);
  const result = await core.execute(request, { ...context, idempotencyKey: "runtime-write-failure" });
  assert.equal(result.recording?.status, "temporary");
  const replay = await core.execute(request, { ...context, idempotencyKey: "runtime-write-failure" });
  assert.equal(replay.replayed, true);
  assert.equal(replay.recording?.status, "temporary");
  assert.equal(adapter.executionCount, 1);
});
