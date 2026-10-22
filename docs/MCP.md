# Streamable HTTP MCP facade

The MCP facade listens on `http://127.0.0.1:8792/mcp`. It maps three MCP tools to the same Common API used by the REST adapter and does not change the Core, Catalog, Policy, persistence, or physical adapters.

```text
AI client
  -> authenticated Secure MCP Tunnel
  -> 127.0.0.1:8792/mcp
  -> dedicated local client identity
  -> 127.0.0.1:8787/api/v1/*
```

The local listener is loopback-only. It must not receive a Nature token or raw appliance/signal identifier. Its dedicated Core credential is read from a Git-ignored mode-0600 file; only the corresponding SHA-256 hash belongs in `config/ai-clients.json`.

## Tools

| Tool | Effect | Common operation |
|---|---|---|
| `get_capabilities` | read-only | capability discovery |
| `get_state` | read-only | state read |
| `execute_action` | physical write | one action execution |

`execute_action` accepts only `action_id`, `parameters`, and `intent_id`. The intent becomes the Common API idempotency key. Replaying the same intent and payload returns its stored result; a new explicit request uses a new intent. Failed and `unknown` outcomes are not retried automatically.

If the Core reports `recording.status: temporary`, the facade preserves the warning and instructs the AI client to tell the user that SQLite persistence was unavailable and duplicate prevention is temporary.

## Read-only verification

After starting the Core and MCP facade in a deliberately configured environment, the following verifier checks the advertised tool set and calls only the two read tools:

```sh
node scripts/verify-mcp-read.ts
```

It checks that credentials and raw physical identifiers are absent from responses and reports counts rather than state values. It does not call `execute_action`.

MCP access audit entries contain only timestamp, fixed client ID, tool name, and result classification. They do not contain arguments, state values, action parameters, credentials, or internal identifiers.

## External connection boundary

Use an authenticated outbound tunnel whose local target is `http://127.0.0.1:8792/mcp`. Do not expose the MCP listener or Core directly to the Internet. Keep client credentials and tunnel profiles outside Git.

Validate in this order:

1. Confirm the expected tool list.
2. Call `get_capabilities` and `get_state` only.
3. Confirm observed and unknown values remain distinct.
4. Perform any physical action only under a separate, explicit operator-approved procedure.
