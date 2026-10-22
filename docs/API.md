# AI共通API契約 v1

**状態: Frozen v1**

v1では3つのpath、認証方式、冪等性の意味、監査、`observed` / `unknown` / `last_command`の意味を固定します。後方互換なフィールド追加はv1内で許容し、既存フィールドの削除・意味変更、認証や冪等性の破壊的変更はv2で行います。

外部AIクライアントのベースURLは、既存ngrok HTTPS Originです。公開パスは次の3本だけです。

- `GET /ai/v1/capabilities`
- `GET /ai/v1/state`
- `POST /ai/v1/actions`

8790はこれらを対応するlocalhostの`/api/v1/*`へ固定転送します。生の8787は`127.0.0.1`待受のままで、Internetへ公開しません。全要求に次を付けます。

```http
Authorization: Bearer <client-secret>
```

鍵をHTML、URL、ログ、会話へ入れません。レスポンスへNature Token、家電ID、信号IDは含めません。

ChatGPT Action用のOpenAPI定義は`integrations/chatgpt/action.openapi.json`です。認証鍵はschemaやtool argumentへ入れず、ChatGPT側のAPI key / Bearer認証欄へ別設定します。操作定義はCore共通契約のままで、ChatGPT固有フィールドはありません。

会話クライアント共通の固定path定義は`integrations/common/v1.ts`、ChatGPT固有のtool名対応は`integrations/chatgpt/adapter.ts`です。Coreはどちらもimportしません。

Streamable HTTP MCPはこの契約を変更せず、`127.0.0.1:8792/mcp`で`get_capabilities`、`get_state`、`execute_action`へ写像します。MCP側の`intent_id`だけがHTTPの`Idempotency-Key`へ変換されます。詳細は`docs/MCP.md`です。

## Capability取得

```http
GET /ai/v1/capabilities
```

6家電とLapis、各state field、48の直接操作、parameter schema、`technical_available`、`execution_allowed`を返します。`execution_policy.mode`は`catalog-bound-direct`、`allowlist`はCatalog・直接操作バインド・ローカルIDバインドの共通部分です。

## State取得

```http
GET /ai/v1/state
```

代表形式:

```json
{
  "schema_version": "1.0",
  "observed_at": "2026-09-29T00:00:00.000Z",
  "devices": [{
    "device_id": "light.living_room",
    "fields": {
      "power": {
        "status": "observed",
        "value": "off",
        "observed_at": "2026-09-29T00:00:00.000Z",
        "source": "nature_cloud.current_state"
      }
    },
    "last_command": {
      "command_id": "...",
      "action_id": "light.living_room.off",
      "completed_at": "...",
      "status": "succeeded"
    }
  }],
  "perceptions": [{
    "perception_id": "environment.living_room.temperature",
    "status": "observed",
    "value": 25.3,
    "unit": "celsius",
    "measured_at": "...",
    "source": "lapis.sensor.temperature"
  }]
}
```

取得不能なdevice fieldは`{"status":"unknown","observed_at":null,"source":"unavailable"}`です。Lapisの測定値を取得できない場合も、対応するperceptionを省略せず`{"perception_id":"...","status":"unknown","measured_at":null,"source":"unavailable"}`として返します。Natureの家電一覧とLapisセンサーは独立して縮退し、片方が取得できれば、その値は`observed`のまま保持します。`last_command`用の永続ストアが読めない場合は現在状態を優先し、履歴は不明として付けません。

## Action実行

```http
POST /ai/v1/actions
Content-Type: application/json
Idempotency-Key: <intentごとの一意キー>

{
  "action_id": "light.living_room.off",
  "parameters": {}
}
```

新規成功は`201`、同一client・同一intentの成功再生は`200`です。Catalog外、未バインド、静的parameter範囲外は`400`で拒否します。エアコン温度等の動的範囲はNature capabilityをGETし、POST前に検証します。タイムアウト等は`outcome: unknown`となり、同じキーでは再送しません。予約、成功、failed、unknown、要求内容の指紋はSQLiteへ保存されるため、Core再起動後も同じキーを再実行しません。新しいキーなら同じactionを再び実行できます。

SQLiteが使えない間も、新しい操作は止めません。予約、成功、failed、unknownをCoreプロセス内メモリへ一時記録し、同じキーの二重送信と`unknown`の自動再送を防ぎます。成功・失敗・unknownの結果には次の`recording`を付け、AIクライアントは警告を必ず人へ伝えます。

```json
{
  "recording": {
    "status": "temporary",
    "persistent": false,
    "store": "memory",
    "duplicate_prevention": "temporary",
    "valid_until": "core_process_or_mac_restart",
    "must_tell_user": true,
    "message": "記録帳（SQLite）が使えないため、この操作は永続記録されていません。二重押し防止はメモリ上だけの一時的なもので、CoreプロセスまたはMacの再起動で失われます。"
  }
}
```

SQLiteへ再接続できると、その後の新しいintentは自動で通常の永続記録へ戻ります。障害中に一時記録したintentは復旧後も同じCoreプロセス内ではメモリ記録を優先し、再送しません。障害中の一時記録をSQLiteへ勝手に再送・再実行・遡及保存しません。

要求形式は`action_id`と`parameters`だけです。appliance ID、device ID、signal ID、raw IR、private macroを指定するフィールドはありません。自動化／シーン／ショートカットはCatalog外です。

## AIクライアント鍵

鍵設定は`config/ai-clients.json`等のGit管理外パスを使います。管理起動はそのファイルをCoreと8790へ渡します。

```sh
node scripts/client-key.ts create chatgpt config/ai-clients.json --secret-file .runtime/secrets/chatgpt.key
node scripts/client-key.ts revoke chatgpt config/ai-clients.json
node scripts/client-key.ts enable chatgpt config/ai-clients.json
```

`--secret-file`を付けると、平文鍵は指定したmode 0600ファイルへ保存され、端末には表示されません。鍵設定ファイルへ保存するのはSHA-256だけです。ChatGPT、Grok、Claude等は任意のclient IDで登録でき、コードにベンダー分岐はありません。`enabled: false`のクライアントは8790と8787の両方で拒否されます。

## 認証境界

- ngrokは人間向けブラウザパスへ従来のGoogle OAuthを適用する
- `/ai/v1/*`だけはGoogle OAuthのCookieに依存せず、8790でBearer認証する
- 未認証要求は8790で`401`となり、8787へ転送されない
- 8790を通過した要求も8787で同じBearer鍵を再検証する
- 任意upstream、任意パス、任意HTTPメソッドは転送しない
- 8790はAIアクセスについて時刻、client ID、method、固定path、status、Authorization header種別、credential文字数だけを`data/ai-access.jsonl`へ記録し、Authorization値、Cookie、request body、State値は記録しない
