import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const EXPECTED_TOOLS = ["execute_action", "get_capabilities", "get_state"];

export type McpReadiness = {
  tools: string[];
  deviceCount: number;
  stateCount: number;
  perceptionCount: number;
  actionAvailable: true;
  actuationPerformed: false;
};

export async function verifyMcpReadiness(endpoint: string, forbiddenSecret = ""): Promise<McpReadiness> {
  const client = new Client({ name: "ai-physical-layer-status", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(endpoint));
  try {
    await client.connect(transport);
    const listed = await client.listTools();
    const tools = listed.tools.map((tool) => tool.name).sort();
    if (JSON.stringify(tools) !== JSON.stringify(EXPECTED_TOOLS)) throw new Error("unexpected MCP tool set");
    const action = listed.tools.find((tool) => tool.name === "execute_action");
    if (!action || action.annotations?.readOnlyHint !== false) throw new Error("MCP action tool is not available");

    const capabilities = await client.callTool({ name: "get_capabilities", arguments: {} });
    const state = await client.callTool({ name: "get_state", arguments: {} });
    if (capabilities.isError || state.isError) throw new Error("MCP read tool returned an error");
    const serialized = JSON.stringify({ capabilities, state });
    if (forbiddenSecret && serialized.includes(forbiddenSecret)) throw new Error("credential appeared in an MCP result");
    if (/NATURE_ACCESS_TOKEN|appliance_id|signal_id/i.test(serialized)) throw new Error("an internal identifier appeared in an MCP result");

    const capabilityBody = object(capabilities.structuredContent);
    const stateBody = object(state.structuredContent);
    return {
      tools,
      deviceCount: Array.isArray(capabilityBody?.devices) ? capabilityBody.devices.length : 0,
      stateCount: Array.isArray(stateBody?.devices) ? stateBody.devices.length : 0,
      perceptionCount: Array.isArray(stateBody?.perceptions) ? stateBody.perceptions.length : 0,
      actionAvailable: true,
      actuationPerformed: false,
    };
  } finally {
    await transport.close().catch(() => undefined);
  }
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
