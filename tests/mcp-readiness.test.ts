import test from "node:test";
import assert from "node:assert/strict";
import { McpCoreClient } from "../integrations/mcp/core-client.ts";
import { MemoryMcpAccessLog } from "../src/mcp-access-log.ts";
import { verifyMcpReadiness } from "../src/mcp-readiness.ts";
import { createMcpHttpServer } from "../src/mcp-server.ts";

test("daily status verifies Capability, State, and Action availability without actuation", async (context) => {
  const calls: string[] = [];
  const core = new McpCoreClient(async () => "status-secret", "http://core.invalid", async (input) => {
    calls.push(String(input));
    if (String(input).endsWith("/capabilities")) return Response.json({ contract_version: "1.0", devices: [{ id: "light.living_room" }] });
    if (String(input).endsWith("/state")) return Response.json({
      contract_version: "1.0",
      devices: [{ id: "media.tv", fields: { power: { status: "unknown" } } }],
      perceptions: [{ id: "environment.living_room.temperature", value: 25, unit: "celsius" }],
    });
    throw new Error("status must not execute an action");
  });
  const accessLog = new MemoryMcpAccessLog();
  const server = createMcpHttpServer({ coreClient: core, accessLog });
  server.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  context.after(() => server.close());
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server did not bind");

  const result = await verifyMcpReadiness(`http://127.0.0.1:${address.port}/mcp`, "status-secret");
  assert.deepEqual(result.tools, ["execute_action", "get_capabilities", "get_state"]);
  assert.equal(result.deviceCount, 1);
  assert.equal(result.stateCount, 1);
  assert.equal(result.perceptionCount, 1);
  assert.equal(result.actionAvailable, true);
  assert.equal(result.actuationPerformed, false);
  assert.deepEqual(calls, ["http://core.invalid/api/v1/capabilities", "http://core.invalid/api/v1/state"]);
  assert.deepEqual(accessLog.entries.map((item) => item.tool), ["get_capabilities", "get_state"]);
});
