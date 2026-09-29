# Repository Guidelines

## Project Structure & Module Organization

`src/index.ts` はホスト側の本体で、プラグイン名 `cost-meter` を公開し、`sessionProjections` を待って `costMeter` セッション投影を登録する
投影は耐久ログを畳んでセッション全体の金額を出し、その値付けにはプラグイン行へ設定した100万トークンあたりの単価を使う
`src/client.tsx` はブラウザ側の本体で、`slots` を待ち、1つの style タグを document へ保ち、`conversation.composer.dock` へピルを1つ（id `cost`、`order: 10`）登録してシェルの統計ピルの後ろへ並べる
ピルは React ポータルでシェルの統計ピルの行（`[data-composer-stats]`）へ描画し、その行の字と間隔をそのまま使う
行がまだ現れていなければ中央寄せの自前の行を描く
`src/shared.ts` は両側が合意する定義を置く
投影キー、`Rates`/`Buckets`/`CostParts`/`CostSettings`/`CostMeterView` の型、ゼロ値の定数が入る
値付けと整形の関数（`bucketsFromUsage`、`resolveRates`、`priceBuckets`、`addParts`、`subtractParts`、`formatAmount`、`formatTokens`、`breakdownText`）も入る
ブラウザ側のバンドルは実行時にプラットフォームモジュールしか解決できないため、ここへ副作用を持ち込まない
`build.ts` は Bun のバンドラで `lib/` を出力する
ホスト側は ESM として出し（`zod` と `@deepseek-ai/schemastery` は external）、ブラウザ側は CJS へ束ねて `window.__ModuleLoader__.load({ id, factory })` のローダー形式へ包む
`lib/` は生成物で git の管理外にあり、ローカルでは `bun run build` が書き、公開 tarball へは `prepack` が組み込むためコミットしない
`cordis.patch.yml` はプラグイン行を挿入し、`symbol`/`rates`/`fallback` の設定をコメントで説明する
`knip.ts` は Knip が推論できないソースの入口を並べ、テストは `tests/**/*.test.ts` に置く
`README.md` と `README.ja.md` は互いの翻訳で、常に一緒に更新する
`CLAUDE.md` は `@AGENTS.md` だけを持つため、プロジェクトの指針はこのファイル1つへ集約する

## Build, Test, and Development Commands

`package.json` の `packageManager` が示す Bun を使う

- `bun install` は固定済みの依存を導入する
- `bun run build` は `lib/index.js` と `lib/client.js` を生成し直す
- `bun run check` は `tsc -p tsconfig.json` で型を検査し、ファイルは出力しない
- `bun run lint` は `src/`、`tests/`、ルートの TypeScript ファイル、JSON の manifest を Biome で検査する
- `bun run format` は危険な修正も含めて Biome の修正を適用する
- `bun run test` は `lib/` をビルドし直してから Bun のテストを走らせる
- `npm pack --dry-run --ignore-scripts` は公開されるファイルの組を確かめ、実際の pack や publish では `prepack` が `lib/` をビルドする

.github/workflows/ci.yml が push と pull request で Linux 上の bun install --frozen-lockfile、bun run build、bun run lint、bun run check、bunx knip、bun test、npm pack --dry-run を回す
コミット前にはローカルでも同じ並びを走らせる

## Projection & Pricing Semantics

ここはピルに出る数字を決める部分なので慎重に変える
投影は耐久イベントを畳み、`request/header` が `header.config.provider` と `header.config.model` から現在の route を決める
`assistant/message` は `event.data.usage` の provider usage を寄与させ、それが無ければ `stream` に残る最後の `usage` チャンクを使う
`assistant/attempt` も同じ経路を通り、表面にメッセージを残さなかった課金済みの試行を取りこぼさない
同じターンとステップの再報告は前の標本を足さずに差し替え、`llm/retry-started` がその枠を閉じるため再試行は足し込まれる
`resolveRates` は `"<provider>/<model>"`、`"<model>"`、`fallback` の順に見る
`fallback` は素の object schema を置くと schemastery が省略時にも0埋めの単価を生やし 未設定トークンが黙って0円になるため `FallbackSchema` で包み 省略時は `undefined` を保つ
どのキーにも一致しない route は推測せず、そのトークンを `unpricedTokens` として数え、合計へ入れず、ピルの金額へ末尾の `+` を付ける
状態は耐久キャッシュへ載るため plain JSON に保ち（`stateVersion: 1`）、見た目が変わらない遷移では同じ `wire` の参照を持ち回る
保存する形を変えるときは `stateVersion` と対応する zod スキーマを同時に上げる

## Coding Style & Naming Conventions

strict な TypeScript ESM を書き、`biome.json` と `tsconfig.json` が参照する共有設定（`@yuu1111/biome-config`、`@yuu1111/tsconfig/bun`）に従う
Biome はタブ字下げ、二重引用符、展開した JSON を強制する
JSDoc は日本語で、コードが語れないことだけを書き、常に複数行のブロック形式（`/**` を単独行に、本文、`*/` を単独行に）にして `/** ... */` の一行形式は使わない
関数と変数は `camelCase`、型は `PascalCase` とし、名前付き export だけを使う
行の設定は `@deepseek-ai/schemastery`（`Config`）で、耐久状態とクライアントへ配る `wire` は zod の strict object で検証し、どちらも TypeScript の型と歩調を合わせる

## Client Bundle Constraints

ブラウザ側が `require()` してよいのはシェルが配る `react`、`react/jsx-runtime`、`react-dom`、`@deepseek-ai/dsh-client-ui-primitives` だけとする
それ以外（`slots`、投影、レンダラ）へは `inject` に挙げた cordis サービス経由で届く
`build.ts` は許可外の specifier がバンドルへ現れたとき、バンドルが `module.exports` を代入していないとき、`apply` と `inject` のプラグイン面を欠くときに失敗する
シェルが `react/jsx-dev-runtime` を配らないため `jsx: { development: false }` に固定する
これらの specifier はシェルが最初から配るプラットフォーム名なので、`dsh.client.external` への宣言は要らない

## Testing Guidelines

`bun:test` の `describe`、`test`、`expect` を使い、ファイル名は `*.test.ts` とする
`tests/cost.test.ts` は合成したイベント列を `costMeterProjection` で畳み、単価解決の優先順位、標本の差し替えと足し込み、再試行の扱い、単価の無い route、整形の関数を確認する
`tests/client.test.ts` はビルド済みの `lib/client.js` を読み込む
`window.__ModuleLoader__`、`require`、style タグだけを記録する最小の `globalThis.document` を差し替えて環境を用意し、登録されたピルを `react-dom/server` で描画する
モジュール id、公開するプラグイン面、ドックへの登録、金額と未設定の印を描く条件を確かめる
`bun run test` が先にビルドし直すため検証対象は出荷されるバンドルそのものになり、バンドルを必要としない論理だけ `../src/*.ts` から取り込む

## Commit & Pull Request Guidelines

短い命令形の subject を使う
各コミットは1つの話題に絞り、振る舞いや導入への影響を本文で説明する
PR では振る舞いの変更を要約し、走らせた検証コマンドを並べ、依存する DSH の版があれば記す

## Release

`package.json` の `version` を上げ、一致するタグの GitHub Release を公開する（`v1.0.0` ↔ `1.0.0`）
tarball は `prepack` が作り、`files` が `lib`、`cordis.patch.yml`、両方の README、ライセンスを同梱する
ブラウザ側は公開された `version` に依存しないため、版を上げてもコードの変更は要らない

## Caveats

この金額はハーネス自身のトークン集計へ設定した単価を掛けたもので、請求記録ではない
provider の請求書が正であり、`rates` の誤りはそのまま誤ったピルになる
単価は route ごとに1つなので、途中で値上げする provider には実際に支払う額を反映した単価を置く
通貨間の換算は行わず、`symbol` は通貨を名付けるだけとする
