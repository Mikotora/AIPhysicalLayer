import test from "node:test";
import assert from "node:assert/strict";
import { COMMON_API_V1 } from "../integrations/common/v1.ts";
import { MCP_ADAPTER } from "../integrations/mcp/adapter.ts";
import { MCP_ACCEPTANCE_CASES, MCP_TOOL_NAMES } from "../integrations/mcp/acceptance.ts";
import { CHATGPT_ACCEPTANCE_CASES } from "../integrations/chatgpt/acceptance.ts";
import { findActionDefinition, validateActionParameters } from "../src/action-catalog.ts";

test("MCP is a replaceable adapter over the frozen common v1 contract", () => {
  assert.equal(MCP_ADAPTER.contractVersion, COMMON_API_V1.contractVersion);
  assert.equal(MCP_ADAPTER.protocol, "mcp-streamable-http");
  assert.equal(MCP_ADAPTER.endpoint, "/mcp");
  assert.deepEqual(MCP_ADAPTER.bindings.map((item) => item.toolName), ["get_capabilities", "get_state", "execute_action"]);
  assert.deepEqual(MCP_ADAPTER.bindings.map((item) => item.path), ["/ai/v1/capabilities", "/ai/v1/state", "/ai/v1/actions"]);
});

test("MCP reuses every frozen ChatGPT conversation acceptance case", () => {
  assert.strictEqual(MCP_ACCEPTANCE_CASES, CHATGPT_ACCEPTANCE_CASES);
  assert.equal(MCP_ACCEPTANCE_CASES.length, 8);
  assert.deepEqual(Object.values(MCP_TOOL_NAMES), ["get_capabilities", "get_state", "execute_action"]);
  for (const item of MCP_ACCEPTANCE_CASES) {
    for (const call of item.expectedCalls) {
      if (call.operation !== "action") continue;
      const definition = findActionDefinition(call.actionId ?? "", "nature");
      assert.ok(definition, item.id);
      assert.equal(validateActionParameters(definition, call.parameters ?? {}), undefined, item.id);
    }
  }
});
