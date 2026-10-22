import test from "node:test";
import assert from "node:assert/strict";
import { findActionDefinition, listActionDefinitions, validateActionParameters } from "../src/action-catalog.ts";
import { ActionPolicy } from "../src/action-policy.ts";
import { buildCapabilityDocument } from "../src/capabilities.ts";
import { createDeviceRegistry } from "../src/registry.ts";
import { listNatureDirectActionIds, natureBindingFor } from "../src/nature-profiles.ts";

test("catalog-bound direct Policy allows every and only bound direct Catalog action", () => {
  const actions = listActionDefinitions("nature");
  assert.equal(actions.length, 48);
  assert.ok(findActionDefinition("light.living_room.on", "nature"));
  assert.ok(findActionDefinition("climate.room.set_temperature", "nature"));
  assert.ok(findActionDefinition("media.tv.playback", "nature"));
  assert.ok(findActionDefinition("appliance.generic.filter_clean", "nature"));
  assert.ok(findActionDefinition("light.living_room.favorite", "nature"));
  assert.ok(findActionDefinition("media.tv.color.yellow", "nature"));
  const document = buildCapabilityDocument(createDeviceRegistry("nature"), new ActionPolicy());
  assert.equal(document.devices.length, 7);
  assert.equal(document.execution_policy.mode, "catalog-bound-direct");
  assert.deepEqual(document.execution_policy.allowlist, actions.map((item) => item.id).sort());
  assert.deepEqual(listNatureDirectActionIds(), actions.map((item) => item.id).sort());
  assert.ok(actions.every((item) => natureBindingFor(item.id)));
  assert.ok(document.devices.flatMap((device) => device.actions).every((item) => item.execution_allowed));
  assert.equal(findActionDefinition("automation.scene.execute", "nature"), undefined);
  assert.equal(natureBindingFor("automation.scene.execute"), undefined);
});

test("catalog validates common parameters without adapter-specific request shapes", () => {
  const definition = findActionDefinition("media.tv.channel.select", "nature");
  assert.ok(definition);
  assert.equal(validateActionParameters(definition, { channel: 7 }), undefined);
  assert.match(validateActionParameters(definition, { channel: 13 }) ?? "", /maximum/);
  assert.match(validateActionParameters(definition, { button: "ch-7" }) ?? "", /unknown parameter/);
  const invalidCases: Array<[string, Record<string, unknown>]> = [
    ["climate.room.set_mode", { mode: "turbo" }],
    ["climate.living_room.set_fan_speed", { value: "9" }],
    ["climate.room.set_vertical_direction", { value: "diagonal" }],
    ["media.tv.input.select", { input: "hdmi-secret" }],
    ["media.tv.navigate", { key: "factory-menu" }],
    ["media.tv.playback", { key: "erase-all" }],
  ];
  for (const [actionId, parameters] of invalidCases) {
    const action = findActionDefinition(actionId, "nature"); assert.ok(action);
    assert.ok(validateActionParameters(action, parameters));
  }
});

test("Nature Policy fails closed when a local appliance or learned-signal binding is missing", () => {
  const partial = ActionPolicy.forNature({ version: 1, appliances: { "light.living_room": "local-id" }, signals: {} });
  assert.equal(partial.allows("light.living_room.on"), true);
  assert.equal(partial.allows("light.living_room.mode.reading"), false);
  assert.equal(partial.allows("media.tv.power_toggle"), false);
});
