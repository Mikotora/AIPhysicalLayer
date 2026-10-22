# Conversation client adapters

`integrations/common/v1.ts` is the vendor-neutral client contract. It defines only three operations: capability read, state read, and one action execution. Core, Policy, Registry, persistence, and physical adapters do not import a conversation-vendor module.

`integrations/chatgpt/adapter.ts` maps those operations to Custom GPT Action `operationId` values. The OpenAPI schema and conversational instructions are delivery artifacts for that adapter, not Core behavior.

`integrations/mcp/adapter.ts` is that sibling adapter. It maps `get_capabilities`, `get_state`, and `execute_action` to the same frozen v1 operations over Streamable HTTP at `/mcp`. External authentication belongs to the Secure MCP Tunnel boundary; a dedicated local client identity authenticates the façade to Core. Existing Policy, idempotency, audit, and physical Adapter contracts remain shared.
