# AIPhysicalLayer 運用ガイド

## 一括操作

プロジェクト直下で実行します。

```sh
./bin/aipl start
./bin/aipl status
./bin/aipl stop
```

`start` は次を順に起動し、途中で失敗した場合は、その実行で起動したプロセスだけを停止します。

1. Core / Action API: `127.0.0.1:8787`
2. 設定で有効な場合だけ、Remote MCP共通玄関: `127.0.0.1:8794/mcp`
3. Streamable HTTP MCP façade: `127.0.0.1:8792/mcp`
4. OpenAI Secure MCP Tunnel: MCPだけをoutbound HTTPSで接続
5. OFF専用入口: `127.0.0.1:8790`
6. intent control: `127.0.0.1:8791`
7. ngrok管理API: `127.0.0.1:4040`
8. Google OAuth付きHTTPS Tunnel: `8790`だけをupstreamに指定

PIDとログはGit管理外の `.runtime/` に保存します。`.env.local` の値、Googleアカウント、Cookie、OAuth情報はstatusやログへ表示しません。自動ログイン起動や常駐設定は行いません。

通常の`start`はCatalog連動の直接操作Policyを使います。手書きのaction allowlistや`start:test`はありません。

## 状態確認

```sh
./bin/aipl status
```

一度の確認で以下を表示します。

- Coreプロセスと `GET /api/health`
- MCP façadeの `GET 127.0.0.1:8792/health`
- Secure MCP Tunnelの生存・接続準備状態
- Plugin経路でCapabilityとStateが実際に読め、Action toolが公開されているか
- 8790入口の `GET /health`
- 8791 intent controlの `GET /health`
- ngrok Tunnelが指定Originから `127.0.0.1:8790` を向いているか
- Nature Cloud APIの読み取り専用 `GET /1/appliances` が認証済みで到達できるか
- 有効な場合、8794の監査書込可否、OAuth clientの自己申告名・戻り先・最終使用・refresh期限、Google主電源状態

状態確認では家電操作を送信しません。末尾の `device operation during status: none` がその確認です。

JSONで取得する場合:

```sh
./bin/aipl status --json
```

## 日常の照明OFF

初回intentは起動時に用意されています。Google OAuthで保護された公開URLを開き、5分以内に「リビング照明を消す」を一度押します。

完了後、次の操作要求は結果ページの「新しい消灯操作を準備する」から発行できます。ローカルから発行する場合は次の一括コマンドを使います。これは実機操作を送りません。

```sh
./bin/aipl intent:new
```

各intentは固有のrequest IDと内部Idempotency-Keyを持ちます。同一intentの二重クリック、再読込、再送はNatureへ再送されません。`unknown` も自動再送しません。

## AIクライアント鍵

AI共通APIはクライアント別Bearer鍵を使います。既存の8790 Google OAuth入口には影響しません。

```sh
node scripts/client-key.ts create chatgpt config/ai-clients.json --secret-file .runtime/secrets/chatgpt.key
```

平文鍵はmode 0600のGit管理外ファイルにだけ保存し、チャット、資料、URL、ログへ貼りません。管理起動は`config/ai-clients.json`が存在する場合に、そのパスをCoreと8790へ渡します。

個別失効:

```sh
node scripts/client-key.ts revoke chatgpt config/ai-clients.json
```

鍵設定ファイルにはSHA-256ハッシュだけが保存され、`config/ai-clients.json`はGit管理外です。全クライアントが同じAction Policyを使います。

API契約は`docs/API.md`を参照してください。8787はlocalhost限定のままです。外部AIは既存HTTPS Originの`/ai/v1/*`から8790の固定Gatewayへ入り、Google OAuthではなくクライアント別Bearer鍵で認証します。

Private PluginのMCP経路は別系統です。8792はlocalhost限定で、外部からはOpenAI Secure MCP Tunnelだけを使います。MCP専用identityは`chatgpt-private-plugin`、平文鍵の保管先は`.runtime/secrets/mcp-private-plugin.key`です。接続・読取検証は`docs/MCP.md`を参照してください。

Secure MCP Tunnel clientも`./bin/aipl start / status / stop`の対象です。起動前に既存のGit管理外profileを内容表示せず診断し、停止時は他サービスと一緒に終了します。Tunnel clientはOpenAIへoutbound HTTPS接続するだけで、8792をInternetへ直接公開しません。runtime API keyはprofile内のfile参照先だけに置き、値をコマンドライン、status、ログ、資料へ書きません。

ChatGPT用identityは`chatgpt`、平文鍵の保管先は`.runtime/secrets/chatgpt.key`です。GPT Actionへの設定方法は`docs/CHATGPT.md`を参照してください。鍵値はコマンドライン引数、会話、schema、GPT instructionsへ書きません。

各identityは一つの非公開クライアント専用とし、他用途へ流用しません。クライアントを共有する前に認証欄から鍵を削除し、`client-key.ts revoke chatgpt`でローカルidentityも失効させます。共有版には別鍵またはOAuthを使います。

読取専用の疎通確認:

```sh
node scripts/verify-ai-direct.ts https://your-deployment.example .runtime/secrets/integration-test.key
```

これは未認証が`401`になること、認証済みCapability/Stateが取得できることを確認し、Action POSTは送りません。

未認証Actionが8790で止まり、認証済みでもCatalog外のシーン要求が実行前に拒否されることを、Nature送信なしで確認する場合:

```sh
node scripts/verify-ai-action-boundary.ts https://your-deployment.example .runtime/secrets/integration-test.key
```

## Nature安定IDバインド

```sh
node --env-file=.env.local scripts/refresh-nature-bindings.ts config/nature-bindings.json
```

初回は現在の家電名とtypeを使って対応付け、その後は既存IDを優先して維持します。Natureアプリで表示名や学習信号名を変更しても、同じIDが存在する限り再バインドしません。IDが消えた場合は別家電へ推測で付け替えず停止します。

`config/nature-bindings.json`はGit管理外・mode 0600です。値を表示、共有、API返却しません。

## 永続化

- `data/commands.sqlite`: 同一client/source + Idempotency-Keyの予約、結果、要求内容指紋、device別`last_command`
- `data/actions.jsonl`: 監査ログ
- `data/ai-access.jsonl`: AIアクセス監査（時刻、client ID、method、固定path、status、認証header種別、credential文字数のみ。値は記録しない）
- どちらもGit管理外
- DBファイルはmode 0600
- 同じintentの再送はCore再起動後も実行しない
- 新しいintent/keyなら同じactionを再び実行できる

## 期限切れ

操作ページには5分の残り時間を表示します。期限が切れるとボタンを無効化し、ページ再発行リンクを表示します。期限切れPOSTも8790で拒否され、8787・Natureへは送られません。

## 障害時の見方

| status項目 | 意味 | 最初に見るもの |
|---|---|---|
| `core: unavailable` | 8787が停止または応答不能 | `.runtime/logs/core.log` |
| `mcp: unavailable` | 8792のMCP façadeが停止 | `.runtime/logs/mcp.log` |
| `secureMcpTunnel: unavailable` | Secure MCP Tunnelが停止または接続未完了 | `.runtime/logs/secure-mcp-tunnel.log` |
| `door: unavailable` | 8794停止、監査書込不能、または設定不足 | `.runtime/logs/remote-mcp-gateway.log` と `docs/REMOTE_MCP_GATEWAY.md` |
| `plugin: unavailable` | PluginからCapability / State / Actionを使う準備が未完了 | `mcp`と`secureMcpTunnel`の両方 |
| `entry: unavailable` | 8790が停止または応答不能 | `.runtime/logs/entry.log` |
| `intentControl: unavailable` | 8791が停止 | `.runtime/logs/entry.log` |
| `ngrok: unavailable` | Tunnel停止、URL/upstream不一致 | `.runtime/logs/ngrok.log` と `config/runtime.json` |
| `nature: unavailable` | 認証、回線、Nature Cloud側の問題 | `.env.local` の項目名が揃っているか。値は表示・共有しない |

実操作で `unknown` が出た場合は自動再送せず、照明を目視確認してから新しいintentを発行します。

## 設定境界

- 秘密値・内部ID: `.env.local`、`config/nature-bindings.json`、ngrok標準設定内のみ
- 非秘密の運用設定: `config/runtime.json`
- ngrok Traffic Policy: `config/runtime.json` が指す既存ファイル
- Tunnel対象: `127.0.0.1:8790`のみ
- 8787 / 8791 / 8792 / 8793: localhost限定
- 8794: localhost限定。8790が許可する共通玄関exact pathだけを中継
- 実機Policy: Catalog登録済み ∩ Nature直接操作バインド済み ∩ ローカルIDバインド済み
- 除外: Catalog外、raw ID/IR、private macro、自動化、シーン、ショートカット
