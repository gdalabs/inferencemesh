# NEXT — inferencemesh

現在地点: ローカル main = origin/main = edfcce8（**未 push なし**・PRIVATE）。テスト366件 全pass。
バンドル・単一バイナリ・コンテナの3形態で起動確認済み（コンテナからの実推論も通した）。
最終セッション 2026-08-27（OrcaRouter 登録・口座単位 quota → push・CI green）。

- 2026-08-27: 溜まっていた6本を push。CI（Node 20 / Node 22 / bundle smoke）は3ジョブとも green。
  🔴 CI に警告が出ている: `actions/checkout@v4` と `actions/setup-node@v4` は Node 20 ランタイムで、
  GitHub 側が Node 24 に強制昇格させている。**今は動いているが、v5 に上げるまで警告は消えない**


## Autonomous Session 2026-08-22

- Summary: 配布物（npm パッケージ・単一バイナリ・コンテナ・インストーラ）が
  **どれも新規ユーザーの最初の一歩で壊れていた**のを実測で見つけて直した。
  あわせて ROADMAP Now の1件（llm7 の同時実行上限）を実測で確定し、
  「ドキュメントが黙って古くなる」箇所をテストで固定した。
- Completed: 下の「完了」節に全件（commit 単位で 30 本、すべて push 済）
- Files changed: `src/cli.ts` `src/setup.ts` `src/server/node.ts` `src/ledger.ts`
  `src/config.ts` `src/registry.ts` `src/sync.ts` `src/catalogs.ts` `src/language-probe.ts`
  `src/gateway.ts` `src/mesh.ts` `src/probe-report.ts`(新) `src/version.ts`(新)
  `examples/worker.ts`(新) `Dockerfile` `install.sh` `package.json` `providers.default.json`
  `.github/workflows/ci.yml`(新) `README.md` `ROADMAP.md` `CLAUDE.md` + テスト9ファイル
- Validation: `npm test` 331件（Node 20 / Node 22 の両方で実行）/ クリーンビルド /
  クローンして `npm ci` から再現 / `docker build` + コンテナ healthy /
  `npm pack` → 空プロジェクトに install → bin・import・型定義 /
  単一バイナリを実際にビルドして起動 / 公式 OpenAI SDK で4経路 /
  `install.sh` を file:// のローカル配布物で全5経路
- Git: gdalabs/inferencemesh (PRIVATE) / main / 30 commits / 全て push 済 / 未 push なし
- Decisions:
  - **llm7 の maxConcurrent=1 を registry に書いた**。鍵不要なので誰の無料枠も使わずに
    測れる唯一の対象で、3回再現した。他プロバイダは本人が「その枠を使ってよい」と
    決めるまで測らない
  - **`sync` の新規プロバイダ枠を `public` に変更**（従来 `internal`）。機密性は人間の判断
  - **he/el/hy/ka/bn/ta のプロンプトは書かなかった**。検証できない言語の文面を自作すると
    測定器そのものが検証不能になる
  - **`.env.example` は触っていない**。secrets フックがそのファイル名を含むコマンドを
    止めるため、回避せず本人の手に残した
- Pending approval: **公開（public 化）の判断**。監査は通っている（下記）
- Problems / Unresolved:
  - リリースワークフローは**一度も走っていない**（タグが無い）。最初のタグが唯一の検証機会
  - ヒンディー語とマラーティー語は判定不能のまま（区別する文字が無い）
  - 未登録の無料モデル18件は probe するまで採用しない（鍵が要る）
- Next: ①公開判断 → ②最初のタグでリリース経路を検証 → ③OpenRouter の18件を probe して採用
- Cost requests: 無し（今日の作業は全て無料経路のみ。OPENROUTER_API_KEY は未使用）

## P1


## P2

- サンプルの環境変数ファイル（リポジトリ直下のテンプレート）が古い。
  NVIDIA/ZAI/MODELSCOPE/OVH/LLM7 の変数と KEYS/LEDGER/PUBLIC_HEALTH が無い。
  🔴 ただし `block-git-secrets.sh` がそのファイル名を含むコマンドを止めるので、
  編集・commit は本人の手でやる方が早い（フックは回避しない）


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

- ✅ 公式 OpenAI SDK で実測（commit bd57c0f）。models.list / completion / streaming /
  エラー分類すべて通過。`/v1/models` に `created` を追加（SDK が必須として型付け・commit 03d92f9）
- ✅ `version` コマンド追加（commit 28112b4）。配布バイナリに自分のバージョンを言う手段が無かった
- ✅ setup ページのインライン JS を構文検査（commit 75e0508）。壊れても 200 で白紙を返すだけなので
  既存テストは全部通ってしまう。わざと壊して発火を確認
- ✅ 未記載だった route の3フラグを追記し、ドリフトをテストで固定（commit 37274a9）

- ✅ `sync` が新規プロバイダ枠を `maxPrivacy: internal` で作っていたのを `public` に
  （commit 7a7cd23, push済）。機密性の判断を機械がしていた
- ✅ Worker のスニペットが**そのままでは型が通らなかった**ので、
  ビルドでコンパイルされる `examples/worker.ts` にして README とずれたら落ちるようにした
  （commit 8209422 / 9ed67ac, push済）。Docker ビルドが落ちたのもここで検出して修正
- ✅ 公開前監査: 全50コミットの author/committer が GDA Labs、履歴全体で PII ゼロ、
  鍵らしき文字列はテスト用の偽値のみ、追跡ファイル58件にバイナリなし

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

## ✅ 受信箱 消化済み — OrcaRouter（2026-08-27 対応完了）

Root セッション（2026-08-25）からの引き渡しは全て処理した。commit 2df6524 / 6ef92c0 / 279db5a。

**登録したのは3モデル**（`deepseek/deepseek-v4-flash-free` / `qwen/qwen3.8-27b-free` /
`tencent/hy3-free`）。2026-08-27 に text・tool_calls・json_object を実測し、code は
生成関数を実際に node で走らせて確認した（tencent だけ finish_reason='length' で判定不能なので
capabilities に code を入れていない）。

🔴 **`orcarouter/free` は意図的に外した。** 裏側を明かさないルーターで、実測では
`deepseek-v4-flash` に解決した。どの事業者に渡るかがリクエストごとに変わりうるので、
capability も context も privacy も記録できない。`stealth/*` を弾くのと同じ理由。

### この作業で出た、引き渡し内容と食い違った実測

- 🔴 **10req/分・50req/日 はモデル単位では書けなかった。** quota のキーが
  `provider/model` だったので、3モデルに書くと 30req/分 を許す。`ProviderConfig.quota` を
  新設し、口座単位で予約 → モデル単位で予約 → 内側が拒否したら外側を払い戻す2層にした。
  実サーバで11発目が `account rpm 10/10` で止まり、**同じ鍵の別モデルも止まる**ことを確認済み
- 🔴 **カタログは「トークンが無料」と言っていない。** `pricing` は `{"request":"0.000000"}` だけで
  per-token 価格を持たない。だから `CatalogSource` は足していない（無料判定が機械的にできない）
- 🔴 **contextWindow は無料枠のリクエスト上限であって、モデルの context 長ではない。**
  qwen はカタログ上 65536 だが無料枠は約56kで 400。しかも上限はトークンではなく
  リクエストのサイズで効く（同一テキストで prompt_tokens が 55,803 / 30,339 / 30,268 と
  割れたまま3件とも通った）。書いたのは ASCII での実測下限で、**日本語ではより早く上限に当たる**

### 後始末（2026-08-27・commit 83088a5 で完了）

- ✅ `providers.example.json` に2層の quota を両方載せた。旧コメントは
  「the per-minute quota **below**」と書きながら、そのファイルに quota が1つも無かった
- ✅ ROADMAP: OrcaRouter を同時実行測定の「鍵は要るが完全無料」という第3のケースとして追記。
  リクエストサイズ上限の表現方法を Now に新項目として追加
- 🔴 ✅ **コンテナが昨日から自分のテストに落ちていた。** README を4言語化した時点
  （commit 6c05344）から Dockerfile が `README.md` しかコピーしておらず、翻訳テスト5件が
  ENOENT。**その間に誰もイメージを建てなかったので気づかれなかった**。glob に変更して修正。
  Dockerfile のコメントには**同じ見落としが過去2回**記録されていた（今回が3回目）
- ✅ 3モデルとも思考型で、小さい `max_tokens` だと `content: null` /
  `finish_reason: 'length'` が返ることをレジストリに記録

### まだ残っていること

- OrcaRouter の `maxConcurrent` は未実測（推測で書かない方針のため空のまま）。
  **完全無料なので他社の枠を使わずに測れる唯一の対象**だが、50req/日 なので測る日は他をやらない
- `languages` / `quality` は未評価のまま（`DEFAULT_QUALITY_SCORE` で中立に扱われる）
- 🔴 `contextWindow` に書いたのは **ASCII での実測下限**。日本語ではより早く上限に当たる。
  リクエストサイズ上限を表現する方法自体が未設計（ROADMAP の Now）


## まだ本人の判断待ち

1. **公開（public 化）の判断** — 監査は通っている
2. ✅ 最初のタグでリリース経路を検証 → `v0.1.0-rc.1`（2026-09-05）でrelease workflowが史上初完走。5バイナリ＋SHA256SUMS公開済み
3. OpenRouter の未登録無料モデル18件を probe して採用（鍵が要る）
4. ✅ 未 push の commit → 解消済み（2026-09-05、main にpush済み。以降も都度push）
5. OrcaRouterワークスペースに定着したGitHub連携（`err_free_access_denied` で無料枠が現在停止中。コンソール→profile settingsで本人が操作）
6. `.env` への `CLOUDFLARE_ACCOUNT_ID` と `MISTRAL_API_KEY` 投入（投入後にprobe実測）

## セッション 2026-09-05（OpenCode + MuseSpark）

- 開発エージェントを有料から MuseSpark（無料）に切替。opencode権限は全体自動（`~/.config/opencode/opencode.json` に `"permission": "allow"`、再起動で反映）
- 分岐解消：`probe-reply-budget` を `origin/main` にrebase＋未コミット吸収。テスト388件（366→+22）
- CI v5化（checkout/setup-node。upload/download-artifactはv4が現行のため据置）
- `v0.1.0-rc.1` で初リリース検証。CIはNode 20の1件flake（server-stream 50ms固定sleep）→同一jobリラン緑→poll化修正（`29dc0c2`）
- 無料枠検証：Cloudflare OpenAI互換は公式確認（adapter対応済み、あとはACCOUNT_IDのみ）。SambaNova無料枠は撤回済み（402）と判明し除外。Mistral Experimentは生存（鍵取得は本人の手）
- 腐敗対応：`qwen/qwen3.8-27b-free` が `/v1/models`＋`/api/free-package/public` の両方から消滅 → registryでdisabled化（削除せず、`58ccefb`）。orcaのFREE_MODELSからも除去。`docs/models.md` 再生成
- 新候補（未probe）：`inclusionai/ling-3.0-flash-sante:free`（openrouter/nous）、llm7の `gpt-5.5-openai-compact`/`gpt-6-astra`、orcarouterの `z-ai/glm-5.3-flash-free`
- 🔴 OrcaRouter無料枠は現在アカウントゲートで停止中（`err_free_access_denied`、retryable:false。再試行は無意味）。qwen以外の2件もprobe不能。ゲート解除後に再probeすること
