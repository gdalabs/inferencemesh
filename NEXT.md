# NEXT — inferencemesh

現在地点: `probe --language` を実装して commit 517b9ba（未push）。テスト180件 全pass。
AFK セッション 2026-08-22 17:10〜23:10。

🔴 **AFK 中の制約**: `OPENROUTER_API_KEY` を使う live probe / sync の実ネットワーク実行は禁止
（従量課金）。オフラインで完結する作業だけを進める。実測が要る項目は P3 に置いてある。

## P1

- 🔴 CI がタグ push でしか走らない。`.github/workflows/release.yml` の test job は
  `on: push: tags` 配下なので、**PR も main への push も何も検証されない**。
  OSS として contributor の PR が無検証で並ぶ状態。`ci.yml` を足す
- `src/cli.ts` にテストが1件も無い。`probe --language` の行組み立て・claim との突き合わせ・
  exit code が未検証（判定器そのものは `test/language-probe.test.ts` で検証済み）。
  純粋な部分を関数に切り出してテストする
- `src/setup.ts` / `src/setup-ui.ts` が未テスト。CLAUDE.md に
  「readline/promises が pipe で2問目を返さない」「fragment を送らないブラウザで401」の
  実績バグが記録されている領域

## P2

- 判定できる言語を増やす（`src/language-probe.ts`）。文字種で確定できるのに未対応:
  ヘブライ / ギリシャ / アルメニア / ジョージア / ベンガル / タミル。
  ラテン文字圏は機能語表の11言語のみで、それ以外は `unjudged` にしかならない
- `judgeLanguage` は簡体字と繁体字を区別しない。`zh-Hans` / `zh-Hant` を分けて要求されても
  同じ判定になる（Han の共通部分が大きいので、区別するなら簡体専用字での判定が要る）
- `dist/providers.default.json` はビルド生成物。ルートの `providers.default.json` を編集しても
  リビルドするまで `node dist/src/cli.js` には効かない（実際に一度これで混乱した）。
  README か CLAUDE.md に1行入れるか、registry の解決順を見直す

## P3（実測・ネットワークが要るので AFK 中はやらない）

- `maxConcurrent` の実測（ROADMAP Now）。並列度を上げて 429 が出る点を探す。要キー・要課金枠
- `sync` のカタログ追加（OpenRouter / NVIDIA / Chutes / ModelScope / OVHcloud）
- `probe --language` を他言語で実走させ、registry の `languages` と突き合わせる

## 完了

- ✅ `probe --language=<tag>` 実装（commit 517b9ba）。判定器は純粋・オフラインでテスト可能
- ✅ `openrouter-free/openai/gpt-oss-20b:free` を disabled（無料枠から離脱・404 を probe が検出）
