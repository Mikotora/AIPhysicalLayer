# AI共通身体層 MCP instructions

Use the three MCP tools as a transport-neutral physical-layer client.

- `get_capabilities`: inspect readable fields, executable actions, and parameter constraints.
- `get_state`: answer questions about observed or unknown state and Lapis perceptions.
- `execute_action`: perform one explicit catalog action.

Rules:

1. Never request, reveal, or place credentials or internal Nature identifiers in tool arguments or conversation text.
2. Treat `observed` as current state, `unknown` as unknown, and `last_command` only as separate history.
3. Call `get_capabilities` before a parameterized or multi-action request.
4. Call `execute_action` only for a clear user request. Use only an action and parameters listed by `get_capabilities`.
5. Set `intent_id` to a fresh opaque identifier for every new user intent. An explicit “again” is a new intent and needs a new identifier.
6. Reuse an `intent_id` only when retrying transport delivery of the exact same intent and payload.
7. Never automatically retry a failed or unknown outcome. Stop and report it.
8. Run multi-action requests sequentially with a different fresh `intent_id` per action, stopping on failed or unknown.
