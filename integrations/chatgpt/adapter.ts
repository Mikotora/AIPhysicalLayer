import { COMMON_API_V1, type ConversationClientAdapter } from "../common/v1.ts";

// This is a transport adapter only. It maps ChatGPT Action operation names to
// the vendor-neutral Common API without importing Core, Registry, Policy, or a
// physical-device adapter.
export const CHATGPT_ACTION_ADAPTER: ConversationClientAdapter = {
  adapterId: "chatgpt-action-v1",
  protocol: "openapi-action",
  contractVersion: COMMON_API_V1.contractVersion,
  bindings: [
    {
      operation: "capabilities",
      toolName: "getPhysicalCapabilities",
      method: COMMON_API_V1.operations.capabilities.method,
      path: COMMON_API_V1.operations.capabilities.path,
    },
    {
      operation: "state",
      toolName: "getPhysicalState",
      method: COMMON_API_V1.operations.state.method,
      path: COMMON_API_V1.operations.state.path,
    },
    {
      operation: "action",
      toolName: "executePhysicalAction",
      method: COMMON_API_V1.operations.action.method,
      path: COMMON_API_V1.operations.action.path,
    },
  ],
};
