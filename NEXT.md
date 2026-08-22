# NEXT — inferencemesh

現在地点: origin/main = e129ebf（push済・PRIVATE）。テスト260件 全pass。
AFK セッション 2026-08-22 17:10〜23:10。

🔴 **AFK 中の制約**: `OPENROUTER_API_KEY` を使う live probe / sync の実ネットワーク実行は禁止
（従量課金）。オフラインで完結する作業だけを進める。実測が要る項目は P3 に置いてある。

## P1

- `src/setup-ui.ts`（ブラウザからの鍵登録ページ）が未テスト。`setup.ts` 側は済

## P2

- ヒンディー語とマラーティー語は分離できないまま（デーヴァナーガリーに区別する文字が無い。
  語彙で分けるしかない）。ベラルーシ語も `uk` と分けていない（`be` の要求がまだ無いため）
- he/el/hy/ka/bn/ta は判定できるが**プロンプトが英語**なので、測っているのは指示追従。
  検証できない言語のプロンプトを自作しない（instrument が検証不能になる）
- `judgeLanguage` は簡体字と繁体字を区別しない。`zh-Hans` / `zh-Hant` を分けて要求されても
  同じ判定になる（Han の共通部分が大きいので、区別するなら簡体専用字での判定が要る）
- `dist/providers.default.json` はビルド生成物。ルートの `providers.default.json` を編集しても
  リビルドするまで `node dist/src/cli.js` には効かない（実際に一度これで混乱した）。
  README か CLAUDE.md に1行入れるか、registry の解決順を見直す

## P3（実測・ネットワークが要るので AFK 中はやらない）

- 🔴 OpenRouter カタログにある**未登録の無料モデル18件**を probe してから採用する。
  `sync --provider=openrouter --dry-run` で一覧が出る。probe 前の追加は禁止
  （2026-08-16 に「カタログにあるのに無料枠を離れていた」実績がある）
- `maxConcurrent` の実測（ROADMAP Now）。並列度を上げて 429 が出る点を探す。要キー・要課金枠
- `sync` のカタログ追加の残り（NVIDIA / Chutes / ModelScope / OVHcloud）。
  OpenRouter は実装済み・キーレスなので AFK 中でも引ける
- `probe --language` を他言語で実走させ、registry の `languages` と突き合わせる

## 完了

- ✅ 単一バイナリ/バンドルで `inferencemesh setup` が ENOENT で即死していたのを修正
  （commit 71e142c, push済）。release workflow と install.sh が配るのはこのビルド。
  あわせて .env の 0600 化（既存ファイルには mode が効かない）と mergeEnv の空行混入も修正
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
