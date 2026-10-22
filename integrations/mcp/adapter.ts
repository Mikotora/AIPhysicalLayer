import { COMMON_API_V1, type ConversationClientAdapter } from "../common/v1.ts";

export const MCP_ADAPTER: ConversationClientAdapter & { endpoint: "/mcp" } = {
  adapterId: "streamable-http-mcp-v1",
  protocol: "mcp-streamable-http",
  contractVersion: COMMON_API_V1.contractVersion,
  endpoint: "/mcp",
  bindings: [
    {
      operation: "capabilities",
      toolName: "get_capabilities",
      method: COMMON_API_V1.operations.capabilities.method,
      path: COMMON_API_V1.operations.capabilities.path,
    },
    {
      operation: "state",
      toolName: "get_state",
      method: COMMON_API_V1.operations.state.method,
      path: COMMON_API_V1.operations.state.path,
    },
    {
      operation: "action",
      toolName: "execute_action",
      method: COMMON_API_V1.operations.action.method,
      path: COMMON_API_V1.operations.action.path,
    },
  ],
};
