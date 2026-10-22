import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { listActionDefinitions } from "../src/action-catalog.ts";

const schemaPath = new URL("../integrations/chatgpt/action.openapi.json", import.meta.url);

test("ChatGPT Action schema exposes exactly the three common physical-layer tools", async () => {
  const schema = JSON.parse(await readFile(schemaPath, "utf8")) as any;
  assert.equal(schema.openapi, "3.1.0");
  assert.deepEqual(Object.keys(schema.paths).sort(), [
    "/ai/v1/actions",
    "/ai/v1/capabilities",
    "/ai/v1/state",
  ]);
  assert.equal(schema.paths["/ai/v1/capabilities"].get.operationId, "getPhysicalCapabilities");
  assert.equal(schema.paths["/ai/v1/state"].get.operationId, "getPhysicalState");
  assert.equal(schema.paths["/ai/v1/actions"].post.operationId, "executePhysicalAction");
  assert.equal(schema.paths["/ai/v1/actions"].post["x-openai-isConsequential"], true);
  assert.equal(schema.paths["/ai/v1/capabilities"].get["x-openai-isConsequential"], false);
});

test("ChatGPT Action schema action IDs stay aligned with the common Catalog", async () => {
  const schema = JSON.parse(await readFile(schemaPath, "utf8")) as any;
  const exposed = schema.components.schemas.ActionRequest.properties.action_id.enum as string[];
  const catalog = listActionDefinitions("nature").map((item) => item.id);
  assert.deepEqual([...exposed].sort(), [...catalog].sort());
  assert.equal(new Set(exposed).size, 48);
});

test("ChatGPT Action schema never accepts credentials or raw Nature identifiers as arguments", async () => {
  const source = await readFile(schemaPath, "utf8");
  const schema = JSON.parse(source) as any;
  const action = schema.paths["/ai/v1/actions"].post;
  const headerNames = action.parameters.map((item: any) => item.name.toLowerCase());
  assert.deepEqual(headerNames, ["idempotency-key"]);
  assert.deepEqual(Object.keys(schema.components.schemas.ActionRequest.properties).sort(), ["action_id", "parameters"]);
  assert.doesNotMatch(source, /appliance_id|signal_id|raw_ir|client_secret|bearer <|authorization:/i);
});
