import test from "node:test";
import assert from "node:assert/strict";
import { CoreApiError, McpCoreClient } from "../integrations/mcp/core-client.ts";

test("MCP Core client keeps its dedicated credential downstream and preserves intent idempotency", async () => {
  const calls: Array<{ url: string; headers: Headers; body?: string }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), headers: new Headers(init?.headers), body: typeof init?.body === "string" ? init.body : undefined });
    return new Response(JSON.stringify({ status: "succeeded", replayed: calls.length > 1 }), { status: calls.length > 1 ? 200 : 201 });
  };
  const client = new McpCoreClient(async () => "x".repeat(43), "http://127.0.0.1:8787", fetchImpl);
  await client.executeAction("light.living_room.off", {}, "same-intent-01");
  await client.executeAction("light.living_room.off", {}, "same-intent-01");
  assert.equal(calls.length, 2);
  assert.ok(calls.every((call) => call.headers.get("authorization") === `Bearer ${"x".repeat(43)}`));
  assert.ok(calls.every((call) => call.headers.get("idempotency-key") === "same-intent-01"));
  assert.ok(calls.every((call) => call.body === JSON.stringify({ action_id: "light.living_room.off", parameters: {} })));
});

test("MCP Core client does not retry an unknown action outcome", async () => {
  let calls = 0;
  const client = new McpCoreClient(async () => "x".repeat(43), "http://127.0.0.1:8787", async () => {
    calls += 1;
    throw new Error("connection lost");
  });
  await assert.rejects(client.executeAction("light.living_room.off", {}, "unknown-intent-01"), (error: unknown) => {
    assert.ok(error instanceof CoreApiError);
    assert.equal(error.outcome, "unknown");
    return true;
  });
  assert.equal(calls, 1);
});

test("MCP Core client preserves a temporary recording warning on action errors", async () => {
  const recording = { status: "temporary", persistent: false, must_tell_user: true };
  const client = new McpCoreClient(async () => "x".repeat(43), "http://127.0.0.1:8787", async () =>
    Response.json({ error: "ambiguous", outcome: "unknown", recording }, { status: 502 }));
  await assert.rejects(client.executeAction("light.living_room.off", {}, "temporary-intent-01"), (error: unknown) => {
    assert.ok(error instanceof CoreApiError);
    assert.deepEqual(error.recording, recording);
    return true;
  });
});
