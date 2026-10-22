# AI共通身体層 試作版アーキテクチャ

## 二つの入口

```text
人間: ChatGPT Work -> Google OAuth -> ngrok -> 8790 OFF専用入口
AI:   ChatGPT Action等 -> Bearerクライアント -> ngrok -> 8790 /ai/v1/* 固定Gateway
                                          | Bearerを再検証
                                          v
                           8787 Action Core / Policy / Audit
                                |             |
                         SQLite command DB   JSONL監査ログ
                                |
                         Mock Adapter | Nature Adapter

AI:   Private Plugin -> Secure MCP Tunnel -> 8792 /mcp
                                               | 専用Bearerをローカル読込
                                               v
                                      8787 Common API v1

AI:   Claude -> ngrok existing endpoint -> 8790 exact-path proxy -> 8794 Remote MCP + OAuth
                                                                       | dedicated Core identity
                                                                       v
                                                               8787 Common API v1 reads
```

ngrok対象は従来どおり8790だけです。8787、8791、8792、8794を直接外部公開する設計変更は行っていません。ngrok Traffic Policyは、人間向けパスにはGoogle OAuthを維持し、`/ai/v1/*`と共通玄関のexact pathだけを各ローカル認証境界へ委譲します。8792とSecure MCP Tunnelは凍結した既存経路です。

## 分離した責務

- `action-catalog.ts`: Natureで技術的に送信可能と確認した共通actionとparameter契約
- `action-policy.ts`: Catalog・Nature直接操作写像・ローカル安定IDバインドの共通部分から許可actionを生成
- `registry.ts`: 6家電、Lapis、読取フィールド、共通Capability表現
- `core.ts`: 入力検証、Policy、intent単位冪等性、`last_command`、監査
- `command-store.ts`: `(client/source, Idempotency-Key)`単位の予約・結果と、device単位`last_command`のSQLite永続化。SQLite障害時は同一プロセスのメモリへ縮退し、復旧後の新規intentから自動でSQLiteへ戻す
- `auth.ts`: ベンダー非依存Bearer鍵の識別、ハッシュ照合、個別失効
- `nature-profiles.ts`: 共通actionからNatureの標準ボタン／学習信号／エアコン操作への静的写像
- `config/nature-bindings.json`: 家電ID・signal IDのGit管理外mode 0600バインド。API応答へ出さない
- `adapters/nature.ts`: Nature Cloud形式と共通State / Action形式の変換
- `off-entry.ts`: 既存のGoogle OAuth後ブラウザセッション、OFF専用UI、外部AI用の固定パスBearer Gateway
- `ai-access-log.ts`: AI GET/POSTの時刻、client ID、method、固定path、statusだけを記録。鍵、Cookie、本文、状態値は記録しない
- `integrations/chatgpt/`: 共通RESTをChatGPT Actionへ見せるOpenAPI定義と振る舞い。Coreへベンダー分岐を持ち込まない
- `integrations/common/v1.ts`: 固定済みの3操作による会話クライアント共通契約
- `integrations/chatgpt/adapter.ts`: 共通3操作とCustom GPT Actionの`operationId`だけを対応付ける交換可能Adapter
- `integrations/mcp/`: 同じ共通3操作をStreamable HTTP MCPの3ツールへ対応付ける交換可能Adapter
- `mcp-server.ts`: `127.0.0.1:8792/mcp`だけで待ち受けるstateless façade。Secure MCP Tunnelを外部認証境界とし、専用ローカル鍵でCoreを呼ぶ
- `mcp-access-log.ts`: 時刻、固定client ID、tool名、結果分類だけを記録。引数、状態値、鍵、内部IDは記録しない
- `remote-mcp-gateway/`: 別依存境界のMCP SDK v2、OAuth認可サーバー、Google本人確認、ハッシュ化トークンDB、読み取り専用2ツール
- `remote-mcp-gateway.sqlite`: Git管理外・mode 0600。DCR/CIMD client、認可コード、アクセストークン、回転refresh tokenを保存し、平文tokenは保存しない
- `remote-mcp-access.jsonl`: 共通玄関のclient、自己申告名、tool、結果分類だけを記録。引数とState値を記録しない

Coreより上へNature家電ID、信号ID、Token、Nature固有レスポンスを返しません。表示名は初回バインド生成のヒントにだけ使い、実行・State対応付けは安定IDで行います。

## Stateの意味

- Nature APIで現在状態として取得できる値は `status: observed` とする
- 取得できないフィールドも省略せず `status: unknown` とする
- Lapis測定値は独立した`perceptions`として、値・単位・測定時刻・sourceを持つ
- 共通身体層から成功送信した履歴は`last_command`に保持し、現在状態フィールドへ混ぜない
- `last_command`はSQLiteに保存し、再起動後もStateへ重ねる。現在状態とは別の履歴であり、observed値を上書きしない

## 冪等性

冪等性の単位はAIクライアントと`Idempotency-Key`の組です。Adapter実行前にSQLiteへ`attempting`を予約します。同じクライアント・同じキー・同じ内容は成功結果を再生し、Adapterを再実行しません。同じキーで内容を変えた要求、または`attempting`、failed、unknownを含む消費済みキーの再試行は、再起動後も拒否します。

SQLiteを利用できない場合は、同じ予約と結果分類をCoreプロセス内のメモリへ保存して操作を継続します。この保護は永続ではないため、全結果へ`recording.status: temporary`を付けます。復旧後の新しいintentはSQLiteへ保存しますが、障害中にメモリへ記録したintentは同じプロセス内で引き続き消費済みとして扱い、Adapterへ再送しません。`last_command`のSQLite読取が失敗した場合は従来どおり履歴を不明として返し、メモリ上の履歴で現在状態を補いません。

新しいキーは新しいintentです。同じactionであっても回数制限せず、Adapterを再実行します。action名を理由に抑止しません。同時実行だけはAdapter境界で拒否します。

## 認証

AI共通APIは`Authorization: Bearer`を必須にします。保存するのはクライアントID、鍵のSHA-256、enabledだけです。平文鍵はGit管理外のmode 0600ローカルファイルにだけ保存します。クライアントごとに別鍵を持ち、監査ログへ`client_id`を記録します。`enabled: false`にしたクライアントだけを失効できます。

現時点のPolicyは全クライアント共通で、ベンダー別権限差はありません。Google OAuthは8790の人間向け入口に残り、Bearer鍵の代替ではありません。

ChatGPT直接接続v1はPrivate Custom GPT Actionのサーバー間Bearer機能を使います。Private Plugin / MCPは同じ3 APIを`get_capabilities`、`get_state`、`execute_action`へ変換する薄いfaçadeです。外部認証はOpenAI Secure MCP Tunnel、Core認証は`chatgpt-private-plugin`専用ローカル鍵で分離します。

会話クライアント固有の分岐は接続アダプターに限定し、Core、Policy、Registry、Nature Adapterには追加しません。

## 安全境界

- Catalog登録済みかつNature直接操作として静的バインド済みで、ローカルIDバインドも存在するactionだけを許可
- 静的parameter schemaとNatureの動的capability範囲をPOST前に検証
- Nature TokenとIDはCore外のNature Adapter内に閉じる
- 未登録device/action/parameterを拒否
- raw ID、raw IR、private macro、自動化、シーン、ショートカットを拒否
- Adapterの`unknown`を同一intentで再送しない
- 8787 / 8790 / 8791 / 8792は`127.0.0.1`待受
- MCPの外部接続はoutbound-onlyの認証済みSecure MCP Tunnelに限定し、ngrokや公開URLへ載せない
- 共通玄関は8794の別プロセスで、8790のexact-path allowlistからだけ到達させる。公開toolは読み取り2つだけ
- 8790のAI Gatewayは3つのexact pathだけを8787へ転送し、未認証要求はCoreへ到達させない
- 実機テストはMock自動テスト完了後、明示許可を得た一連の操作だけ実施
