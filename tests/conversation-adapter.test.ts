import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { COMMON_API_V1 } from "../integrations/common/v1.ts";
import { CHATGPT_ACTION_ADAPTER } from "../integrations/chatgpt/adapter.ts";
import { CHATGPT_ACCEPTANCE_CASES } from "../integrations/chatgpt/acceptance.ts";
import { findActionDefinition, validateActionParameters } from "../src/action-catalog.ts";

const schemaPath = new URL("../integrations/chatgpt/action.openapi.json", import.meta.url);

test("ChatGPT is a replaceable adapter over the vendor-neutral v1 contract", async () => {
  const schema = JSON.parse(await readFile(schemaPath, "utf8")) as any;
  assert.equal(CHATGPT_ACTION_ADAPTER.contractVersion, COMMON_API_V1.contractVersion);
  assert.equal(COMMON_API_V1.stability, "frozen");
  assert.equal(COMMON_API_V1.frozenAt, "2026-10-01");
  assert.deepEqual(
    CHATGPT_ACTION_ADAPTER.bindings.map(({ operation, toolName, method, path }) => ({ operation, toolName, method, path })),
    [
      { operation: "capabilities", toolName: "getPhysicalCapabilities", method: "GET", path: "/ai/v1/capabilities" },
      { operation: "state", toolName: "getPhysicalState", method: "GET", path: "/ai/v1/state" },
      { operation: "action", toolName: "executePhysicalAction", method: "POST", path: "/ai/v1/actions" },
    ],
  );
  for (const binding of CHATGPT_ACTION_ADAPTER.bindings) {
    const operation = schema.paths[binding.path][binding.method.toLowerCase()];
    assert.equal(operation.operationId, binding.toolName);
  }
});

test("conversation acceptance cases reference valid catalog actions and parameters", () => {
  assert.equal(CHATGPT_ACCEPTANCE_CASES.length, 8);
  for (const acceptanceCase of CHATGPT_ACCEPTANCE_CASES) {
    for (const call of acceptanceCase.expectedCalls) {
      if (call.operation !== "action") continue;
      assert.equal(call.newIntent, true, `${acceptanceCase.id}: each explicit actuation must be a new intent`);
      const definition = findActionDefinition(call.actionId ?? "", "nature");
      assert.ok(definition, `${acceptanceCase.id}: unknown action ${call.actionId}`);
      assert.equal(validateActionParameters(definition, call.parameters ?? {}), undefined, acceptanceCase.id);
    }
  }
});

test("acceptance matrix distinguishes state, parameterized action, and explicit repeat", () => {
  const stateOnly = CHATGPT_ACCEPTANCE_CASES.filter((item) => item.id.includes("temperature") || item.id.includes("humidity") || item.id.includes("state") || item.id.includes("unknown"));
  assert.ok(stateOnly.every((item) => item.expectedCalls.every((call) => call.operation === "state")));

  const aircon = CHATGPT_ACCEPTANCE_CASES.find((item) => item.id === "living-room-air-conditioner-cool-24");
  assert.deepEqual(aircon?.expectedCalls.map((call) => call.operation), ["capabilities", "action", "action"]);

  const repeat = CHATGPT_ACCEPTANCE_CASES.find((item) => item.id === "explicit-repeat-is-a-new-intent");
  assert.equal(repeat?.expectedCalls.filter((call) => call.operation === "action").length, 2);
});
