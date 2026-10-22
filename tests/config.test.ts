import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { ConfigurationError, readAppConfig } from "../src/config.ts";

test("Mock remains the default and needs no Nature secrets", () => {
  assert.deepEqual(readAppConfig({}), { mode: "mock", nature: null });
});

test("Nature mode fails closed and names only missing variables", () => {
  assert.throws(
    () => readAppConfig({ ADAPTER_MODE: "nature" }),
    (error: unknown) => {
      assert.ok(error instanceof ConfigurationError);
      assert.match(error.message, /NATURE_ACCESS_TOKEN/);
      assert.match(error.message, /NATURE_BINDINGS_FILE/);
      return true;
    },
  );
});

test("Nature configuration is read only from the server environment", () => {
  const bindingPath = join(tmpdir(), `nature-bindings-${randomUUID()}.json`);
  writeFileSync(bindingPath, JSON.stringify({ version: 1, appliances: { "light.living_room": "appliance" }, signals: { "light.room.cycle": "signal" } }));
  assert.deepEqual(readAppConfig({
    ADAPTER_MODE: "nature",
    NATURE_ACCESS_TOKEN: " local-test-token ",
    NATURE_BINDINGS_FILE: bindingPath,
  }), {
    mode: "nature",
    nature: {
      accessToken: "local-test-token",
      bindings: { version: 1, appliances: { "light.living_room": "appliance" }, signals: { "light.room.cycle": "signal" } },
    },
  });
});
