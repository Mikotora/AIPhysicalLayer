import test from "node:test";
import assert from "node:assert/strict";
import { NatureAdapter } from "../src/adapters/nature.ts";
import { ActionCore } from "../src/core.ts";
import { MemoryActionLog } from "../src/logger.ts";
import { createDeviceRegistry } from "../src/registry.ts";
import { ActionPolicy } from "../src/action-policy.ts";

const CONFIG = { accessToken: "test-token-never-real", bindings: { version: 1 as const, appliances: {
  "appliance.generic": "generic", "climate.room": "ac-room", "light.room": "light-room",
  "climate.living_room": "ac-living", "media.tv": "tv", "light.living_room": "living-light",
}, signals: {
  "light.room.cycle": "cycle-id", "appliance.generic.dehumidify.high": "high",
} } };
const appliances = [
  { id: "ac-room", nickname: "名前変更後の部屋エアコン", type: "AC", settings: { temp: "24", mode: "cool", vol: "auto", dir: "auto", dirh: "swing", button: "", updated_at: "2026-09-29T00:00:00Z" }, aircon: { tempUnit: "c", range: { modes: { cool: { temp: ["24"], vol: ["auto"], dir: ["auto"], dirh: ["swing"] }, warm: { temp: ["22"], vol: ["auto"], dir: ["auto"], dirh: ["swing"] } } } }, signals: [] },
  { id: "light-room", nickname: "名前変更後の部屋照明", type: "IR", signals: [{ id: "cycle-id", name: "信号名も変更済み" }] },
  { id: "ac-living", nickname: "名前変更後のリビングエアコン", type: "AC", settings: { temp: "22", mode: "dry", vol: "auto", dir: "", dirh: "", button: "power-off", updated_at: "2026-09-29T00:01:00Z" }, aircon: { tempUnit: "c", range: { modes: { dry: { temp: ["22"], vol: ["auto"], dir: [""], dirh: [""] } } } }, signals: [] },
  { id: "tv", nickname: "名前変更後のテレビ", type: "TV", tv: { state: { input: "t" } }, signals: [] },
  { id: "living-light", nickname: "名前変更後のリビング照明", type: "LIGHT", light: { state: { power: "on", brightness: "80" } }, signals: [] },
  { id: "generic", nickname: "部屋のエアコン追加ボタン", type: "IR", signals: [{ id: "high", name: "変更後の信号名" }] },
];
const devices = [{ newest_events: { te: { val: 25.3, created_at: "2026-09-29T00:02:00Z" }, hu: { val: 48, created_at: "2026-09-29T00:03:00Z" } } }];

test("health check uses only GET and never returns secrets", async () => {
  const methods: string[] = [];
  const adapter = new NatureAdapter(CONFIG, async (_url, init) => { methods.push(String(init?.method)); return Response.json([]); });
  const result = await adapter.healthCheck();
  assert.deepEqual(methods, ["GET"]);
  assert.equal(result.status, "ok");
  assert.doesNotMatch(JSON.stringify(result), /test-token|configured-light/);
});

test("readState resolves stable appliance IDs after display names change", async () => {
  const methods: string[] = [];
  const adapter = new NatureAdapter(CONFIG, async (url, init) => {
    methods.push(String(init?.method)); return Response.json(String(url).endsWith("/1/devices") ? devices : appliances);
  });
  const state = await adapter.readState();
  assert.deepEqual(methods, ["GET", "GET"]);
  const roomAc = state.devices.find((item) => item.device_id === "climate.room")!;
  assert.deepEqual(roomAc.fields.power.value, "on");
  assert.deepEqual(roomAc.fields.setpoint_temperature.value, 24);
  const roomLight = state.devices.find((item) => item.device_id === "light.room")!;
  assert.equal(roomLight.fields.power.status, "unknown");
  const livingLight = state.devices.find((item) => item.device_id === "light.living_room")!;
  assert.equal(livingLight.fields.power.status, "observed");
  assert.equal(livingLight.fields.brightness.value, 80);
  assert.equal(state.devices.find((item) => item.device_id === "media.tv")?.fields.input.value, "terrestrial");
  assert.deepEqual(state.perceptions.map((item) => [item.perception_id, item.value]), [["environment.living_room.temperature", 25.3], ["environment.living_room.humidity", 48]]);
  assert.doesNotMatch(JSON.stringify(state), /ac-room|living-light|test-token/);
});

test("appliance rate limiting leaves device fields unknown but preserves Lapis observations", async () => {
  const issues: Array<{ source: string; reason: string; httpStatus?: number }> = [];
  const adapter = new NatureAdapter(CONFIG, async (url) => String(url).endsWith("/1/appliances")
    ? new Response("rate limited", { status: 429 })
    : Response.json(devices), (issue) => issues.push(issue));
  const state = await adapter.readState();
  assert.equal(state.devices.find((item) => item.device_id === "climate.room")?.fields.power.status, "unknown");
  assert.deepEqual(state.perceptions.map((item) => [item.status, "value" in item ? item.value : null]), [["observed", 25.3], ["observed", 48]]);
  assert.deepEqual(issues, [{ source: "appliances", reason: "rate_limited", httpStatus: 429 }]);
});

test("Nature transport and Lapis shape failures return explicit unknown values", async () => {
  const issues: Array<{ source: string; reason: string }> = [];
  const adapter = new NatureAdapter(CONFIG, async (url) => {
    if (String(url).endsWith("/1/appliances")) throw new TypeError("private network detail");
    return Response.json([{ newest_events: { te: { val: "25.3", created_at: "changed" } } }]);
  }, (issue) => issues.push(issue));
  const state = await adapter.readState();
  assert.equal(state.devices.find((item) => item.device_id === "light.living_room")?.fields.power.status, "unknown");
  assert.deepEqual(state.perceptions.map((item) => item.status), ["unknown", "unknown"]);
  assert.deepEqual(issues, [
    { source: "appliances", reason: "network_error" },
    { source: "lapis_temperature", reason: "missing_or_invalid_value" },
    { source: "lapis_humidity", reason: "missing_or_invalid_value" },
  ]);
  assert.doesNotMatch(JSON.stringify(state), /private network detail/);
});

test("common actions are translated inside the Nature adapter", async () => {
  const requests: Array<{ url: string; method: string; body: string }> = [];
  const adapter = new NatureAdapter(CONFIG, async (url, init) => {
    requests.push({ url: String(url), method: String(init?.method), body: String(init?.body ?? "") });
    return String(init?.method) === "GET" ? Response.json(appliances) : Response.json({});
  });
  await adapter.execute({ actionId: "media.tv.input.select", device: "media.tv", action: "input.select", parameters: { input: "terrestrial" } });
  await adapter.execute({ actionId: "light.room.cycle", device: "light.room", action: "cycle", parameters: {} });
  await adapter.execute({ actionId: "climate.room.set_mode", device: "climate.room", action: "set_mode", parameters: { mode: "heat" } });
  const posts = requests.filter((item) => item.method === "POST");
  assert.match(posts[0].url, /\/tv$/); assert.equal(posts[0].body, "button=input-terrestrial");
  assert.match(posts[1].url, /\/signals\/cycle-id\/send$/);
  assert.match(posts[2].url, /\/aircon_settings$/); assert.match(posts[2].body, /operation_mode=warm/);
  assert.doesNotMatch(JSON.stringify(posts), /test-token/);
});

test("new Favorite and TV color buttons use fixed standard appliance operations", async () => {
  const requests: Array<{ url: string; body: string }> = [];
  const adapter = new NatureAdapter(CONFIG, async (url, init) => {
    requests.push({ url: String(url), body: String(init?.body ?? "") }); return Response.json({});
  });
  await adapter.execute({ actionId: "light.living_room.favorite", device: "light.living_room", action: "favorite", parameters: {} });
  for (const color of ["blue", "red", "green", "yellow"]) {
    await adapter.execute({ actionId: `media.tv.color.${color}`, device: "media.tv", action: `color.${color}`, parameters: {} });
  }
  assert.deepEqual(requests.map((item) => item.body), ["button=on-favorite", "button=blue", "button=red", "button=green", "button=yellow"]);
  assert.ok(requests[0].url.endsWith("/1/appliances/living-light/light"));
  assert.ok(requests.slice(1).every((item) => item.url.endsWith("/1/appliances/tv/tv")));
});

test("configured living-room OFF path remains exact and performs one POST", async () => {
  let capturedUrl = ""; let capturedInit: RequestInit | undefined;
  const adapter = new NatureAdapter(CONFIG, async (url, init) => { capturedUrl = String(url); capturedInit = init; return Response.json({}); });
  const result = await adapter.execute({ actionId: "light.living_room.off", device: "light.living_room", action: "off", parameters: {} });
  assert.equal(capturedUrl, "https://api.nature.global/1/appliances/living-light/light");
  assert.equal(capturedInit?.method, "POST");
  assert.equal(String(capturedInit?.body), "button=off");
  assert.equal(result.state.delivery, "accepted");
});

test("out-of-range dynamic aircon values are rejected before the Nature POST", async () => {
  const methods: string[] = [];
  const adapter = new NatureAdapter(CONFIG, async (_url, init) => {
    methods.push(String(init?.method)); return Response.json(appliances);
  });
  const log = new MemoryActionLog(); const core = new ActionCore([adapter], log, createDeviceRegistry("nature"), new ActionPolicy());
  await assert.rejects(core.executeById("climate.room.set_temperature", { value: 99 }, { idempotencyKey: "bad-temp", source: "ai-client", clientId: "claude" }), /temperature is unavailable/);
  assert.deepEqual(methods, ["GET"]);
  assert.equal(log.entries[0].status, "failed");
});

test("adapter failure is classified and the same intent is not retried", async () => {
  let fetchCount = 0;
  const adapter = new NatureAdapter(CONFIG, async () => { fetchCount += 1; throw new TypeError("private transport detail"); });
  const log = new MemoryActionLog(); const core = new ActionCore([adapter], log, createDeviceRegistry("nature"), new ActionPolicy());
  const context = { idempotencyKey: "nature-unknown", source: "local-api" } as const;
  await assert.rejects(core.executeById("light.living_room.off", {}, context), /request failed/);
  await assert.rejects(core.executeById("light.living_room.off", {}, context), /already consumed/);
  assert.equal(fetchCount, 1);
  assert.deepEqual(log.entries.map((entry) => entry.status), ["unknown", "rejected"]);
  assert.doesNotMatch(JSON.stringify(log.entries), /private transport/);
});
