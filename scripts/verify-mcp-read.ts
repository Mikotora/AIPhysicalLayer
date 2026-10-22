import { readFile } from "node:fs/promises";
import { verifyMcpReadiness } from "../src/mcp-readiness.ts";

const endpoint = process.argv[2] ?? "http://127.0.0.1:8792/mcp";
const secretPath = process.argv[3] ?? ".runtime/secrets/mcp-private-plugin.key";
const result = await verifyMcpReadiness(endpoint, (await readFile(secretPath, "utf8")).trim());
console.log(`MCP tools verified: ${result.tools.join(", ")}`);
console.log(`Capability read verified: ${result.deviceCount} device records`);
console.log(`State read verified: ${result.stateCount} device records, ${result.perceptionCount} perceptions`);
console.log("Action tool verified: available");
console.log("Action calls performed: none");
