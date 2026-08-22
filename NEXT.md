# NEXT — inferencemesh

現在地点: origin/main = b7b929a（push済・PRIVATE）。テスト270件 全pass。
AFK セッション 2026-08-22 17:10〜23:10。

🔴 **AFK 中の制約**: `OPENROUTER_API_KEY` を使う live probe / sync の実ネットワーク実行は禁止
（従量課金）。オフラインで完結する作業だけを進める。実測が要る項目は P3 に置いてある。

## P1


## P2


- ヒンディー語とマラーティー語は分離できないまま（デーヴァナーガリーに区別する文字が無い。
  語彙で分けるしかない）。ベラルーシ語も `uk` と分けていない（`be` の要求がまだ無いため）
- he/el/hy/ka/bn/ta は判定できるが**プロンプトが英語**なので、測っているのは指示追従。
  検証できない言語のプロンプトを自作しない（instrument が検証不能になる）
- `judgeLanguage` は簡体字と繁体字を区別しない。`zh-Hans` / `zh-Hant` を分けて要求されても
  同じ判定になる（Han の共通部分が大きいので、区別するなら簡体専用字での判定が要る）

## P3（実測・ネットワークが要るので AFK 中はやらない）

- 🔴 OpenRouter カタログにある**未登録の無料モデル18件**を probe してから採用する。
  `sync --provider=openrouter --dry-run` で一覧が出る。probe 前の追加は禁止
  （2026-08-16 に「カタログにあるのに無料枠を離れていた」実績がある）
- `maxConcurrent` の実測（ROADMAP Now）。並列度を上げて 429 が出る点を探す。要キー・要課金枠
- `sync` のカタログ追加の残り（NVIDIA / Chutes / ModelScope / OVHcloud）。
  OpenRouter は実装済み・キーレスなので AFK 中でも引ける
- `probe --language` を他言語で実走させ、registry の `languages` と突き合わせる

## 完了

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
