# ChatGPT Action adapter

The ChatGPT adapter maps the vendor-neutral REST contract to three Action operations. It does not add ChatGPT-specific behavior to the Core, Catalog, Policy, persistence, or physical adapter.

```text
ChatGPT Action
  -> HTTPS /ai/v1/capabilities | /ai/v1/state | /ai/v1/actions
  -> authenticated gateway
  -> loopback Core
```

The schema is `integrations/chatgpt/action.openapi.json`; the client behavior rules are `integrations/chatgpt/INSTRUCTIONS.md`. The committed server URL is a placeholder. Replace it only in a private local copy or in the client configuration.

## Private client setup

1. Create a private GPT and add an Action.
2. Copy the OpenAPI schema into the Action editor after replacing the placeholder URL locally.
3. Configure API-key authentication with a Bearer credential created for this client only.
4. Put the credential in the client authentication field, never in the schema, instructions, URL, or conversation.
5. Copy `integrations/chatgpt/INSTRUCTIONS.md` into the GPT instructions.
6. Test `getPhysicalCapabilities` and `getPhysicalState` first. Do not execute an action during read-only validation.

Generate a dedicated local key without printing it:

```sh
node scripts/client-key.ts create chatgpt config/ai-clients.json --secret-file .runtime/secrets/chatgpt.key
```

Keep the GPT private while it uses a credential that reaches your environment. Before sharing a client, remove its credential and revoke the matching local identity:

```sh
node scripts/client-key.ts revoke chatgpt config/ai-clients.json
```

## Read-only validation

- capability discovery returns only the common catalog and parameter contracts;
- state returns observed and explicit unknown values;
- `last_command` remains separate from current state;
- an unauthenticated request is rejected before it reaches the Core;
- no action request or command-store row is created.

Access audit records may contain time, client ID, fixed path, HTTP method, response status, authorization-header class, and credential length. They must not contain the credential value, cookies, request bodies, capabilities, or state values.

## Action behavior

`executePhysicalAction` accepts one common action and its catalog-defined parameters. Each new user intent uses a new `Idempotency-Key`; only an exact transport retry may reuse a key. A failed or `unknown` outcome is never retried automatically.

When a result contains `recording.status: temporary`, the client must state that SQLite was unavailable, the operation was not persistently recorded, and duplicate prevention is only temporary in memory.

Real-device validation requires separate operator authorization and is outside this public repository's test procedure.
