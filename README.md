# AIPhysicalLayer

[日本語の説明は下にあります](#日本語)

AIPhysicalLayer is a local physical-device layer for AI clients. It provides one vendor-neutral model for capabilities, observed state, and explicitly requested actions, then exposes that model through REST and MCP adapters.

The default adapter is an in-memory Mock. A Nature Remo adapter is included for users who configure their own account, local bindings, authentication boundaries, and action policy.

## Status

This repository is an experimental implementation, not a safety-certified control system. Start with Mock mode. Do not connect real devices until you have reviewed the catalog, local bindings, authentication, logs, and failure behavior for your own environment.

## Architecture

```text
AI client
  -> authenticated REST gateway or MCP facade
  -> Action Core / Catalog / Policy
  -> idempotency store and audit log
  -> Mock adapter or locally configured Nature adapter
```

The Core listens on loopback by default. Internet-facing authentication belongs at a separate gateway or authenticated tunnel; the Core itself must not be exposed directly.

The common API provides:

- capability discovery, including executable actions and parameter contracts;
- observed and explicitly unknown device state;
- one catalog-approved action per request;
- idempotency and duplicate-send prevention;
- separate `last_command` history that is never treated as observed state.

See [Architecture](docs/ARCHITECTURE.md), [API](docs/API.md), [MCP](docs/MCP.md), and [Operations](docs/OPERATIONS.md) for details.

## Requirements

- Node.js 24 or later
- pnpm
- macOS for Keychain-based gateway helpers and the bundled service workflow
- Optional: a Nature Remo account and token for Nature mode
- Optional: ngrok for the browser/REST gateway
- Optional: an authenticated Secure MCP Tunnel for remote MCP clients
- Optional: a dedicated Google OAuth client for the multi-client remote MCP gateway

Mock/Core code may work on other platforms, but the complete service workflow has not been validated there.

## Quick start: Mock only

Install dependencies and run the tests:

```sh
pnpm install --frozen-lockfile
pnpm test
```

The test suite injects fake network responses. It does not require device credentials and does not operate physical devices.

Run only the local Mock Core:

```sh
cp .env.example .env.local
node --env-file=.env.local src/server.ts
```

`ADAPTER_MODE=mock` is the default. The Core listens on `http://127.0.0.1:8787`.

To avoid accidental real-device use, do not set `ADAPTER_MODE=nature`, do not provide a Nature token, and do not run the managed service commands while evaluating the repository.

## Local configuration

Committed files contain placeholders only. Copy an example to its ignored local path and set mode `0600` where it contains identifiers or hashes.

| Example | Ignored local file | Purpose |
|---|---|---|
| `.env.example` | `.env.local` | adapter mode, token reference, binding path |
| `config/ai-clients.example.json` | `config/ai-clients.json` | client IDs and SHA-256 key hashes |
| `config/nature-bindings.example.json` | `config/nature-bindings.json` | local appliance and signal bindings |
| `config/runtime.example.json` | `config/runtime.json` | local service and gateway paths |
| `config/ngrok-traffic-policy.example.yml` | a private policy path | browser OAuth and API path boundary |
| `remote-mcp-gateway/config/remote-mcp-gateway.example.json` | `remote-mcp-gateway/config/remote-mcp-gateway.json` | OAuth gateway limits and identifiers |

The Secure MCP Tunnel profile is vendor-generated and is not included as an example because its exact format and credential references are installation-specific. Store it under `.runtime/` and keep API keys in a referenced local file, never inline in Git-tracked content.

Never commit `.env.local`, `data/`, `.runtime/`, real configuration files, tunnel profiles, keys, tokens, logs, databases, callback URLs, or device identifiers.

## REST and MCP integrations

- REST API: `GET /api/v1/capabilities`, `GET /api/v1/state`, and `POST /api/v1/actions`
- AI gateway aliases: `/ai/v1/*`
- Streamable HTTP MCP facade: `http://127.0.0.1:8792/mcp`
- Generic ChatGPT Action schema: `integrations/chatgpt/action.openapi.json`
- Generic client instructions: `integrations/chatgpt/INSTRUCTIONS.md`

The OpenAPI server URL is a placeholder and must be replaced only in a private local copy or in the client configuration. Do not commit a deployed hostname.

## Safety model

- Listen on loopback unless a separately authenticated gateway is intentionally configured.
- Accept only catalog action IDs and validated parameters.
- Keep raw appliance IDs, signal IDs, raw IR, macros, scenes, and credentials outside API inputs and responses.
- Require one `Idempotency-Key` or MCP `intent_id` per user intent.
- Reuse a key only for an exact transport retry; use a new key for a new explicit request.
- Never retry a failed or `unknown` outcome automatically.
- Treat `last_command` as history, not evidence of current physical state.
- Keep audit data and SQLite databases untracked and mode `0600`.
- Keep real-device authorization with the operator; connecting an AI client is not blanket permission to operate devices.

### SQLite unavailable

If the command store cannot be opened or written, actions continue with process-local in-memory duplicate prevention. The result carries `recording.status: temporary`, states that the operation was not persistently recorded, and requires the AI client to tell the user that duplicate prevention is temporary.

The temporary record lasts only for the Core process lifetime and can be lost after a process or computer restart. `last_command` is returned as unknown when it cannot be read. Recovery of SQLite automatically restores normal persistence for new intents. Temporary records are not silently replayed, resent, or retroactively written.

## Testing boundaries

`pnpm test` runs unit and integration tests with Mock adapters and injected network responses. It does not start the managed services, contact the Nature Cloud API, open an external tunnel, or operate a physical device.

This public copy intentionally omits household-specific acceptance logs and real-device test scripts. Validate any real deployment separately and never publish its credentials, identifiers, state values, or audit logs.

## Security

Do not expose ports `8787`, `8791`, `8792`, or `8794` directly to the Internet. Review the exact authentication and forwarding boundary before exposing the `8790` gateway.

If you discover a security issue, do not include tokens, keys, personal information, logs, or live URLs in a public issue.

## 日本語

AIPhysicalLayer（AI共通身体層）は、AIが家の家電を「読む」「動かす」ための、特定のAI会社に縛られない共通の層です。ChatGPT、Claude、Grokなど、どのAIからも同じ形で、次の3つを扱えるようにします。

- 何ができるか（能力）
- 今どうなっているか（状態）
- 何をしてほしいか（操作）

### 大事にしていること

- **見えないものを、見えたことにしない**：観測できた値と「分からない（unknown）」を分けて返します。最後に送った命令（last_command）は、今の状態の証拠としては扱いません。
- **勝手に送り直さない**：失敗した命令や、結果が分からない命令は、自動で再送しません。同じ依頼の二重送信も防ぎます。
- **止めるより、伝えながら動く**：記録を保存できない時も操作は続けます。ただし、その事実をAIが必ず人に伝えられる形で返します。
- **判断は人に残す**：AIをつないだことは、何でも動かしてよいという許可ではありません。

### はじめかた

まずはMock（模擬）モードで試してください。本物の家電にはつながりません。手順は英語の「Quick start: Mock only」を参照してください。

### 注意

これは実験的な実装で、安全性の認証を受けた制御システムではありません。本物の家電につなぐ前に、ご自分の環境で設定、認証、ログ、失敗した時の動きを確かめてください。鍵、トークン、ログ、家電のIDなどは公開しないでください。

## License

MIT. Copyright (c) 2026 Mikotora. See [LICENSE](LICENSE).
