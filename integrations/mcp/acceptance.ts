import { CHATGPT_ACCEPTANCE_CASES } from "../chatgpt/acceptance.ts";

// The MCP façade deliberately reuses the frozen conversation acceptance matrix.
// Only transport tool names change; user intent and Common API semantics do not.
export const MCP_ACCEPTANCE_CASES = CHATGPT_ACCEPTANCE_CASES;

export const MCP_TOOL_NAMES = {
  capabilities: "get_capabilities",
  state: "get_state",
  action: "execute_action",
} as const;
