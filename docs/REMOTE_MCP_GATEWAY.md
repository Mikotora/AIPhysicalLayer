# Remote MCP共通玄関（Phase 2 multi-client / Phase 3 actions）

## Boundary

The common gateway is a separate process on `127.0.0.1:8794`. It does not replace the existing MCP server on `127.0.0.1:8792`, and it does not change the Secure MCP Tunnel. The public `8790` entry proxies only the exact paths listed below to `8794`; all other paths retain their existing behavior.

- `/mcp`
- `/.well-known/oauth-protected-resource`
- `/.well-known/oauth-protected-resource/mcp`
- `/.well-known/oauth-authorization-server`
- `/.well-known/openid-configuration`
- `/oauth/authorize`
- `/oauth/token`
- `/oauth/register`
- `/oauth/google/callback`
- `/oauth/consent`

Phase 3 publishes `get_capabilities`, `get_state`, and `execute_action` after a fresh consent for both `mcp:read` and `mcp:act`. `execute_action` accepts every one of the 48 common Catalog action IDs; the unchanged Core Policy remains the final execution allowlist. The gateway adds no AI-specific branch to Core, Catalog, Policy, or the Nature Adapter.

Access tokens issued in Phase 1 have only `mcp:read`. They continue to expose only the two read tools, and refresh rotation preserves that exact scope. They are never upgraded automatically. Removing and reconnecting the Claude connector starts a fresh Google login and consent and is required to obtain `mcp:act`.

For compatibility with Claude's reconnect flow, a new authorization request may omit `scope` or request only `mcp:read`. Either form starts the explicit Phase 3 consent flow; it does not upgrade an existing token. Only approval on the `読み取り＋家電操作` consent page permits the authorization code exchange to issue a new `mcp:read mcp:act` token. Unknown or broader scope values are rejected. Authorization-request logs record only the client kind/status, scope shape (`absent`, `read-only`, `read-act`, or `other`), and a rejection classification; they do not record client IDs, redirect values, states, PKCE material, or tokens.

The gateway does not add a second confirmation dialog when a tool is called. The AI client performs its own tool approval. The consent page says `読み取り＋家電操作` and shows the AI's self-claimed name and exact callback host.

## Multi-client registration approval

- One DCR registration may present 1–10 unique callback URIs. Exact duplicates are collapsed before the limit is applied. Every URI is validated independently and must be an exact HTTPS URI with no userinfo, fragment, or wildcard; one invalid URI rejects the entire registration. CIMD retains its single-callback metadata shape.
- A DCR callback set not yet approved is stored as one `pending` registration; a new valid callback is not rejected merely for being new.
- A pending client cannot start Google OAuth, create an OAuth transaction or authorization code, or obtain access/refresh tokens.
- `door:pending` prints the registration's total URI/domain counts, then groups every full URI by hostname for owner review.
- `door:approve` approves the selected registration as one unit and adds only all URIs in that registration to the local SQLite allowlist. A retry whose complete callback set is already approved can proceed; path, query, and trailing-slash variants remain different URIs.
- `door:reject` records the decision and revokes the whole pending registration without adding any callback from it.
- Pending registrations expire after `pendingClientTtlSeconds`; `maxPendingClients`, `maxClients`, and the existing registration rate limit bound resource use.
- Registration approval is separate from Google identity and consent. Approval only opens the next gate; Google authentication and the `読み取り＋家電操作` consent page remain mandatory.
- Authorization accepts only a `redirect_uri` exactly present in that client's approved set. The authorization code is bound to the selected URI, and token exchange requires the same URI again.
- The consent page lists every approved callback hostname for that client. Its `form-action` CSP contains only the unique origins in that client's approved set, never origins belonging only to another client.
- Existing clients are migrated as approved. Existing Claude tokens, refresh scope, connection status, and callback are not changed.
- Registration audit entries contain only a non-reversible client reference, self-claimed name, client kind, unique callback hostnames, URI count, timestamp, and decision. They omit the full client ID, exact callback URI, tokens, state, and PKCE material.
- A rejected DCR request writes one `oauth_client_registration_rejected` classification event to the gateway runtime log. It records only the rejection class, metadata shapes, redirect count, scheme/host kind/port presence, recognized grant/auth-method classes, and—for HTTPS domain callbacks only—the hostname. It never records a complete callback URI, path, query, client ID/secret, token, state, or PKCE value. Successful registrations do not emit this diagnostic event, and logging failure does not change the registration response.

## Action safety and reporting

- The input is `action_id`, Catalog-shaped `parameters`, and `intent_id`.
- The gateway derives a non-reversible Core `Idempotency-Key` from OAuth client identity plus `intent_id`. The same client and intent are stable; different clients cannot collide.
- The gateway sends at most one action request. `unknown` is never retried automatically.
- The tool result includes the action ID, human-readable action name, result classification, and an `observed` or `unknown` post-action state classification.
- If Core had to use temporary in-memory idempotency because its SQLite command store was unavailable, the gateway preserves the `recording` warning and adds an explicit rule requiring the AI to relay it to the user.
- A command or `last_command` never becomes an observed state by inference. The tool description and every unknown result say this explicitly.
- An audit attempt is written before Core is called. If it cannot be written, the action is rejected without reaching Core. Result-audit failure after a possible send is returned as `unknown` with no automatic retry.
- Action audit records contain the OAuth client identity, self-claimed name, action ID/name, phase, and result classification. They omit parameters, `intent_id`, derived idempotency keys, state values, and secrets.

## OAuth and storage

- OAuth authorization code flow requires PKCE S256.
- The authorization server supports Client ID Metadata Documents and DCR.
- Optional bootstrap configuration may seed a reviewed callback as already approved. New exact callback approvals live in `data/remote-mcp-gateway.sqlite` and are managed with `door:pending`, `door:approve`, and `door:reject`.
- Access and refresh tokens are opaque. Only SHA-256 hashes are stored in `data/remote-mcp-gateway.sqlite`.
- Refresh tokens rotate. Reuse of a rotated token revokes every door token for that client.
- The dedicated Google OAuth client secret and Google refresh token are stored in macOS Keychain, not in the repository or SQLite.
- Google identity is matched by one configured stable `sub`, not by email.
- Every refresh checks the Google grant. A revoked grant revokes all door clients; a network or ambiguous Google failure refuses the refresh without guessing.
- Tool audit records contain time, OAuth client ID, self-claimed client name, tool name, phase, and result classification. Action records also contain only the common action ID and human-readable name. They do not contain arguments, returned state, idempotency material, or tokens.

## Configuration files

Copy the examples before enabling the process:

```sh
cd AIPhysicalLayer
cp remote-mcp-gateway/config/remote-mcp-gateway.example.json remote-mcp-gateway/config/remote-mcp-gateway.json
chmod 600 remote-mcp-gateway/config/remote-mcp-gateway.json
```

To avoid editing either JSON file by hand, use the interactive configurator after the personal file has been copied and the Google client secret has been stored in Keychain:

```sh
./bin/aipl door:configure
```

It can open the localhost-only Google `sub` discovery flow, reads the pasted `sub` with terminal echo disabled, updates the Google client ID, adds or updates the `remoteMcpGateway` runtime block, and asks explicitly whether `enabled` should be true. Before replacing either JSON file it writes mode-0600 backups under `.runtime/backups/`; the replacements are validated and atomic. It never prints the client ID or `sub`, and it does not start or stop services or call Core.

Fill in the dedicated Google OAuth client ID and the one allowed Google `sub`. The example's `bootstrapApprovedRedirectUris` seeds a reviewed callback on a fresh database; later approvals are stored in SQLite. The legacy `allowedRedirectUris` key remains readable for migration. Do not put the Google client secret in this file.

If the allowed `sub` is not known yet, first register both of these exact redirect URIs on the dedicated Google Web OAuth client:

```text
https://<the-existing-public-origin>/oauth/google/callback
http://127.0.0.1:8795/oauth/google/sub-callback
```

After storing the Google client secret in Keychain as described below, run:

```sh
./bin/aipl door:google-sub
```

This starts a five-minute helper bound only to `127.0.0.1`, opens Google sign-in, validates `state`, PKCE, nonce, issuer, and audience, then shows the verified `sub` only in the localhost browser page. It does not print or save the `sub`, request a refresh token, start AIPhysicalLayer services, or call Core. Copy the displayed value directly into `allowedGoogleSub`; do not paste it into chat.

Add the `remoteMcpGateway` object from `config/runtime.example.json` to the ignored `config/runtime.json`. Keep `enabled` as `false` until the remaining setup is complete.

Create the gateway-only Core identity. This does not call Core and does not operate a device:

```sh
./bin/aipl door:core-key:create
```

Store the dedicated Google client secret without placing it in shell history or an argument:

```sh
IFS= read -r -s AIPL_GOOGLE_SECRET
printf '%s' "$AIPL_GOOGLE_SECRET" | ./bin/aipl door:google-secret:set
unset AIPL_GOOGLE_SECRET
./bin/aipl door:google-secret:exists
```

The Google Web application must register exactly this redirect shape using the already configured public origin:

```text
https://<the-existing-public-origin>/oauth/google/callback
```

Only `openid email` is requested. Google's current documentation exempts basic identity-only scopes from the seven-day refresh-token expiration normally applied to external apps in Testing, but the implementation still treats any invalidated token as revoked.

After the Core key, Keychain secret, and ngrok policy are ready, set `remoteMcpGateway.enabled` to `true`. A running old `8790` process does not pick up initial gateway enablement; use the clean managed-start procedure in the operations handoff. A Phase 3 code update itself changes only the 8794 process and does not require Core, 8790, 8792, either tunnel, or ngrok to restart.

## ngrok Traffic Policy

The upgrade keeps the existing endpoint and the existing two Traffic Policy rules. It expands the same bypass expression used by `/ai/v1/` to include only the exact Common Door paths; it does not add a rule or endpoint.

Run only after reviewing the configured policy path:

```sh
./bin/aipl door:policy:upgrade
```

The script writes a mode-0600 backup beside the policy file and never prints identity values.

## Process management

When enabled before a clean `./bin/aipl start`, the gateway is included in the managed process state. These commands are local administrative operations:

```sh
./bin/aipl status
./bin/aipl door:clients
./bin/aipl door:pending
./bin/aipl door:approve <client-id>
./bin/aipl door:reject <client-id>
./bin/aipl door:revoke <client-id>
./bin/aipl door:revoke-all
./bin/aipl door:stop
./bin/aipl door:start
```

`door:stop` refuses to kill an unmanaged process. It stops only the managed `8794` process and leaves Core, `8790`, `8792`, both tunnel paths, and ngrok alone.

## Claude / Grok / Grok Bot connection

After the clean managed start and policy upgrade, add the connector in Claude on the web using:

```text
https://<the-existing-public-origin>/mcp
```

Complete Google sign-in and the local consent page on the web first. Claude mobile can then use a connector already added to the account. Confirm `./bin/aipl status` and `./bin/aipl door:clients` before any real read or action.

For a new client such as Grok or Grok Bot, the first attempt may stop before Google authentication. Inspect and decide locally:

```sh
./bin/aipl door:pending
./bin/aipl door:approve '<client-id>'
# or
./bin/aipl door:reject '<client-id>'
```

Verify the self-claimed name, client kind, entire callback URI, and registration time before approval. Retry the connector after approval. If the client uses DCR and discards its first client ID, the exact approved callback lets the retry create a separate approved client. Google authentication and the local consent page still follow.

Existing Phase 1 connections must be removed and added again so the new consent is explicit. For a code-only Phase 3 restart, the user runs:

```sh
./bin/aipl door:stop
./bin/aipl door:start
./bin/aipl status
```

These commands restart only managed 8794. They do not stop Core, 8790, 8792, Secure MCP Tunnel, or ngrok, and they do not operate a device.
