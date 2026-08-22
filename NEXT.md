# NEXT — inferencemesh

現在地点: origin/main = dc45ac9（push済・PRIVATE）。テスト315件 全pass。
AFK セッション 2026-08-22 17:10〜23:10。

🔴 **AFK 中の制約**: `OPENROUTER_API_KEY` を使う live probe / sync の実ネットワーク実行は禁止
（従量課金）。オフラインで完結する作業だけを進める。実測が要る項目は P3 に置いてある。

## P1


## P2


- ヒンディー語とマラーティー語は分離できないまま（デーヴァナーガリーに区別する文字が無い。
  語彙で分けるしかない）。ベラルーシ語も `uk` と分けていない（`be` の要求がまだ無いため）
- he/el/hy/ka/bn/ta は判定できるが**プロンプトが英語**なので、測っているのは指示追従。
  検証できない言語のプロンプトを自作しない（instrument が検証不能になる）

## P3（実測・ネットワークが要るので AFK 中はやらない）

- 🔴 OpenRouter カタログにある**未登録の無料モデル18件**を probe してから採用する。
  `sync --provider=openrouter --dry-run` で一覧が出る。probe 前の追加は禁止
  （2026-08-16 に「カタログにあるのに無料枠を離れていた」実績がある）
- `maxConcurrent` の実測の残り（llm7 は 2026-08-22 に実測して 1 と判明・登録済み）。
  他プロバイダは鍵が要るので、本人が「その無料枠を使ってよい」と決めてから
- `sync` のカタログ追加の残り（NVIDIA / Chutes / ModelScope / OVHcloud）。
  OpenRouter は実装済み・キーレスなので AFK 中でも引ける
- `probe --language` を他言語で実走させ、registry の `languages` と突き合わせる

## 完了

- ✅ 🔴 llm7 の `maxConcurrent` を**実測**して 1 と確定（commit b646431, push済）。
  ROADMAP Now の1件。鍵不要なので課金枠を使わずに測れた。3回とも再現
- ✅ 環境変数10個のうち8個が README に無かったので表を追加し、
  **ドキュメントが遅れたらテストが落ちる**ようにした（commit dc45ac9, push済）
- ✅ 自己レビューで自分の当日変更から2件発見（commit aedbca8, push済）:
  ledger のロード失敗が永久に記憶される / `fail()` が `process.exit` を使っていた

- ✅ 起動時エラー2件（commit c480e8c, push済）: ポート衝突が生のスタックトレース /
  `INFERENCEMESH_REGISTRY` のタイプミスで黙って埋め込みレジストリにフォールバック
- ✅ ターミナル版 setup が Cloudflare の account id を聞いていなかった（commit 53aba28, push済）。
  ブラウザ版には最初から入力欄がある。鍵だけ貼っても必ず検証に失敗する状態だった
- ✅ 🔴 package.json の `bin`/`exports`/`types` が**存在しないパス**を指していた（commit 524c723, push済）。
  実体は `dist/src/…`。公開すれば `npx inferencemesh` も `import` も即壊れる。
  実際に pack → 空プロジェクトに install → bin 実行・import・型定義まで確認

- ✅ CLI/ゲートウェイの入力検証（commit ef46158, push済）。バンドル版で全コマンドを叩いて発見:
  存在しないプロファイルでスタックトレース / `--privacy` `--capabilities` の打ち間違いが
  「registry が悪い」ように見えるメッセージになる / `--min-context=abc` が NaN で無効化。
  ゲートウェイでは `mesh/fastest` が **500**（＝サーバ側の障害）として返っていたのを 400 に
- ✅ 出荷レジストリの signupSteps 完備をテストで固定（commit fde1dc8, push済）

- ✅ 鍵の同時保存で片方が消える競合を修正（commit d7f96f4, push済）。
  「保存しました」と表示した後に消える種類。修正を戻してテストが落ちることを確認済み
- ✅ `estimateTokens` が日本語を英語の規則（4文字=1トークン）で数えていた（commit e6a16e4, push済）。
  約4倍の過小評価で、日次トークン上限が効かない方向（＝使い過ぎ）にずれる
- ✅ Gemini の `response_format: json_schema` が黙って無視されていた（commit 59eeadc, push済）。
  明示的に失敗させ、mesh が対応プロバイダにフォールバックするようにした

- ✅ 「同じコードが Worker でも動く」をテストで固定（commit fe9ec63, push済）。
  index.ts から辿れる範囲に node: の import が入ったら落ちる。**わざと壊して発火を確認済み**
- ✅ `expiresAt` を probe / route にも出すようにした（commit 549b3fa, push済）。
  sync のレポートは「レジストリを作り直す時」にしか読まれないので、定期実行する側に出す
- ✅ 簡体/繁体の区別（commit 8bfacf7, push済）。`zh` 単体は両方を受け入れる

- ✅ README の「鍵はログに出ない — テストで強制」が**半分しか強制されていなかった**ので
  テストを追加（commit b7b929a, push済）。ドキュメントの古いテスト数（148/83）も削除
- ✅ config の検証強化（commit 4ec93a8, push済）。`capabilities` の打ち間違い・maxPrivacy の
  打ち間違い・languages の 72（0.72 のつもり）・expiresAt・defaultProfile が全部素通りしていた

- ✅ Docker 2件（commit befb413, push済）: HEALTHCHECK がトークン無しで認証必須の /healthz を
  叩いていて**永久に unhealthy**（実測 failing streak 3）/ 鍵の保存先が read-only の /app 配下で
  **検証成功後に書き込み失敗**。ビルドして実測確認

- ✅ `install.sh` を fail-closed に（commit 80ec571, push済）。SHA256SUMS が取れない/
  エントリが無い場合に黙ってインストールしていた。`file://` のローカル配布物で全5経路を実測。
  ついでに EXIT トラップの戻り値で「成功したのに exit 1」になる穴と、0711 のパーミッションも修正
- ✅ `discover-providers.mjs` 3件（commit 2d474ac, push済）: 空のカタログ応答を diff 扱いして
  全件 GONE + baseline 破壊 / 全カタログ失敗でも exit 0（「静かな週」と区別がつかない）/
  `process.exit()` でパイプ出力の末尾を捨てる（cli.ts が一度学んだ問題の再発）
- ✅ ledger の競合修正（commit 913c525, push済）。実測で rpm=2 に3件通っていた

- ✅ 単一バイナリ/バンドルで `inferencemesh setup` が ENOENT で即死していたのを修正
  （commit 71e142c, push済）。release workflow と install.sh が配るのはこのビルド。
  あわせて .env の 0600 化（既存ファイルには mode が効かない）と mergeEnv の空行混入も修正
- ✅ ゲートウェイのトークンを journal に出さないようにした（commit ebd6569, push済）。
  TTY のときだけ setup URL にトークンを出す。setup ページの不変条件3つもテスト化
  （外部ホストを読まない / token は fragment から / 鍵をブラウザ storage に置かない）
- ✅ 文字種を共有する言語の誤判定を修正（commit e129ebf, push済）。
  ウクライナ語が `ru` の claim を confirm しなくなった。ペルシア語/アラビア語も同様。
  判定は「否定にしか使えない」設計（両方の固有文字が出たら証拠なしとして扱う）
- ✅ 判定できる文字種を6つ追加（he/el/hy/ka/bn/ta・commit 877c369, push済）。
  カウンタを範囲テーブルから生成するようにした（手書き並列リストは同期漏れで無音の0になる）
- ✅ `probe` の3つの「嘘をつく緑」を修正（commit 16aad73, push済）:
  status をメッセージの正規表現ではなく `detail.attempts` から読む /
  `languages` が何も言っていない言語を claim 扱いして FAULT にしていた /
  1件も測れていない実行が「no contradictions」と表示されていた。
  純粋部分を `src/probe-report.ts` に切り出してテスト（cli.ts は import で CLI が走るのでテスト不能）
- ✅ CI: push/PR で `npm test`（Node 20/22）+ bundle の smoke test（commit 89a7b9c, push済）。
  タグ時にしか検証されない状態を解消。smoke step の2つの穴も塞いだ
  （キーレス provider 依存 / `bash -e` で `node … | head` の exit code が握り潰される）
- ✅ OpenRouter カタログリーダー（キーレス・無料枠のみ）+ `expiresAt`
  （commit 995fed1, push済）。`pricing.overrides` の時間帯課金を無料判定に織り込み済み
- ✅ sync のバグ修正: カタログが表現できない能力（`code`）を消さないようにした（同 commit）
- ✅ `probe --language=<tag>` 実装（commit 517b9ba）。判定器は純粋・オフラインでテスト可能
- ✅ `openrouter-free/openai/gpt-oss-20b:free` を disabled（無料枠から離脱・404 を probe が検出）
