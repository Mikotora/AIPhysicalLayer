import test from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { McpCoreClient } from "../integrations/mcp/core-client.ts";
import { createMcpHttpServer } from "../src/mcp-server.ts";
import { MemoryMcpAccessLog } from "../src/mcp-access-log.ts";

test("Streamable HTTP MCP exposes exactly three tools and proxies read results without secrets", async (context) => {
  const secret = "private-value-that-must-never-appear";
  const calls: string[] = [];
  const core = new McpCoreClient(async () => secret, "http://core.invalid", async (input, init) => {
    calls.push(String(input));
    assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${secret}`);
    if (String(input).endsWith("/capabilities")) return Response.json({ contract_version: "1.0", devices: [{ id: "light.living_room" }] });
    if (String(input).endsWith("/state")) return Response.json({ contract_version: "1.0", states: [{ id: "media.tv", fields: { power: { status: "unknown" } } }] });
    return Response.json({ status: "succeeded", replayed: false }, { status: 201 });
  });
  const accessLog = new MemoryMcpAccessLog();
  const server = createMcpHttpServer({ coreClient: core, accessLog });
  server.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  context.after(() => server.close());
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server did not bind");

  const client = new Client({ name: "mcp-integration-test", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}/mcp`));
  await client.connect(transport);
  context.after(() => transport.close());

  const tools = await client.listTools();
  assert.deepEqual(tools.tools.map((tool) => tool.name), ["get_capabilities", "get_state", "execute_action"]);
  assert.equal(tools.tools[0].annotations?.readOnlyHint, true);
  assert.equal(tools.tools[2].annotations?.readOnlyHint, false);

  const capabilities = await client.callTool({ name: "get_capabilities", arguments: {} });
  const state = await client.callTool({ name: "get_state", arguments: {} });
  assert.deepEqual(capabilities.structuredContent, { contract_version: "1.0", devices: [{ id: "light.living_room" }] });
  assert.deepEqual(state.structuredContent, { contract_version: "1.0", states: [{ id: "media.tv", fields: { power: { status: "unknown" } } }] });
  assert.doesNotMatch(JSON.stringify([capabilities, state, accessLog.entries]), new RegExp(secret));
  assert.deepEqual(calls, ["http://core.invalid/api/v1/capabilities", "http://core.invalid/api/v1/state"]);
  assert.deepEqual(accessLog.entries.map((entry) => [entry.client_id, entry.tool, entry.status]), [
    ["chatgpt-private-plugin", "get_capabilities", "succeeded"],
    ["chatgpt-private-plugin", "get_state", "succeeded"],
  ]);
});

test("execute_action forwards same intent for replay and a fresh intent for explicit repeat", async (context) => {
  const intentIds: string[] = [];
  const recording = { status: "temporary", persistent: false, must_tell_user: true };
  const core = new McpCoreClient(async () => "x".repeat(43), "http://core.invalid", async (_input, init) => {
    const key = new Headers(init?.headers).get("idempotency-key") ?? "";
    const replayed = intentIds.includes(key);
    intentIds.push(key);
    return Response.json({ status: "succeeded", replayed, recording }, { status: replayed ? 200 : 201 });
  });
  const server = createMcpHttpServer({ coreClient: core, accessLog: new MemoryMcpAccessLog() });
  server.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  context.after(() => server.close());
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server did not bind");
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}/mcp`));
  const client = new Client({ name: "mcp-action-test", version: "1.0.0" });
  await client.connect(transport);
  context.after(() => transport.close());

  const args = { action_id: "media.tv.volume.down", parameters: {}, intent_id: "intent-volume-001" };
  const first = await client.callTool({ name: "execute_action", arguments: args });
  const retry = await client.callTool({ name: "execute_action", arguments: args });
  const repeat = await client.callTool({ name: "execute_action", arguments: { ...args, intent_id: "intent-volume-002" } });
  assert.equal((first.structuredContent as any).replayed, false);
  assert.equal((retry.structuredContent as any).replayed, true);
  assert.equal((repeat.structuredContent as any).replayed, false);
  assert.deepEqual((first.structuredContent as any).recording, recording);
  assert.deepEqual((retry.structuredContent as any).recording, recording);
  assert.deepEqual(intentIds, ["intent-volume-001", "intent-volume-001", "intent-volume-002"]);
});
