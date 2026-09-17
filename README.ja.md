# dsh-ui-cost-meter

[English](README.md) | 日本語

DeepSeek Harness の Web GUI に いまのセッションがいくら使ったかを出すピルを1つ足す
プラグインです シェルが持つターン数とトークンのピルと同じ行に並びます

```
⏱ 1 turns 71 steps · 285 tok/s    🗄 7.3M tok · Cache hit 99%    $ 0.42
```

金額はセッション投影の上に載っているため ログ全体の集計になり ページングや圧縮で
変わりません 再読み込みでも消えず 値付けはハーネスがすでに耐久ログへ記録している
provider usage だけから行います ピルはシェルの統計ピルと同じ形で 押すと内訳の
パネルが開きます（入力・出力・キャッシュ・合計と 値付けに使った route）

## 導入

```sh
dsh plugin --profile web add dsh-ui-cost-meter
```

ソースから使う場合は `add link:<path>` でも同じです プラグインが自分の bundle patch を
持っているため profile の `cordis.patch.yml` を書き換えなくても行が入ります

## 設定

設定はすべてプラグインの行に置きます 単価はすべて **100万トークンあたり** で 通貨は
`symbol` が示すものに揃えてください 下の例は DeepSeek V4.1 Flash（`deepseek-flash`
OpenCode Go 側の id は `deepseek-v4.1-flash` Command Code 側は
`deepseek/deepseek-v4.1-flash`）と DeepSeek V4 Pro を DeepSeek の公示単価
（オフピーク）で値付けします 公式 API と OpenCode Go と Command Code は同じ数字を
請求します 実際に払う額に合わせて書き換えてください

```yaml
- id: cost-meter
  name: dsh-ui-cost-meter
  config:
    symbol: '$'
    rates:
      opencode-go/deepseek-flash:
        input: 0.15
        output: 0.6
        cacheRead: 0.003
        cacheWrite: 0
      opencode-go/deepseek-v4-pro:
        input: 0.66
        output: 1.98
        cacheRead: 0.022
        cacheWrite: 0
      deepseek-official/deepseek-flash:
        input: 0.15
        output: 0.6
        cacheRead: 0.003
        cacheWrite: 0
      deepseek-official/deepseek-v4-pro:
        input: 0.66
        output: 1.98
        cacheRead: 0.022
        cacheWrite: 0
      command-code/deepseek/deepseek-v4.1-flash:
        input: 0.15
        output: 0.6
        cacheRead: 0.003
        cacheWrite: 0
```

route ごとに1つしか置けないためここではオフピークを示します ピークはどの欄もちょうど
倍で 月曜から金曜の 01:00-04:00 UTC と 06:00-10:00 UTC にあたります DeepSeek は
キャッシュ書きを課金しないため `cacheWrite` は `0` のままです 廃止された
`deepseek-v4-flash` と `deepseek-v4-flash-vision-exp` の id は現在 V4.1 Flash へ
回され Flash の単価で課金されます OpenCode Go は月10ドルの定額プランで この単価は
トークンの請求額ではなく プランの使用上限に対する計量に使われます Command Code も
同じ単価を Go プラン以上で示しています

出典: [DeepSeek Models & Pricing](https://api-docs.deepseek.com/quick_start/pricing)
[OpenCode Go](https://opencode.ai/docs/go/)
[Command Code: DeepSeek V4.1 Flash](https://commandcode.ai/models/deepseek-v4-1-flash)

| フィールド | 意味 |
|---|---|
| `symbol` | 金額の前に付ける記号 既定は `$` |
| `rates` | 単価表 キーは `"<provider>/<model>"` 次に `"<model>"` で route のキーが優先 |
| `fallback` | どのキーにも一致しない route の単価 省略すると既定では値付けしない |

単価の無い route は推測せず **未設定** として数えます 合計には入らず ピルの金額に
末尾の `+` が付きます 内訳のパネルには未設定のトークン数が出るため 単価の抜けが
黙って間違った金額になることはありません

## 数字の出どころ

ホスト側は `costMeter` セッション投影を登録します `request/header` で route を決め
確定した `assistant/message`（表面にメッセージを残さなかった課金済みの試行は
`assistant/attempt`）が stream に埋め込んだ usage を畳みます 同じターンとステップの
再報告は前の標本を差し替え `llm/retry-started` はその枠を閉じるため 再試行は
足し込まれます 入力・出力・キャッシュ読み・キャッシュ書きのトークンを route の
単価で値付けします

ブラウザ側は `conversation.composer.dock` 枠へ1つ登録し React の portal で
シェルの統計ピルの行（`[data-composer-stats]`）へ差し込みます そのため字・間隔・
高さがその行のまま揃い 別の行を始めません 行がまだ無いセッション（ステップも
トークンも無い状態）では自前の行として中央に描きます

ピルとそのパネルはシェル側の宣言（`--dsw-*` のトークン・寸法・角丸・2列の行の
組み方）をそのまま持ちます 外部のバンドルはシェルが配るプラットフォームモジュール
だけを読め その CSS Modules には届かないためです

## 注意

- **請求書ではありません** ハーネスのトークン計数に設定の単価を掛けたものです
  正しいのは provider の請求で 単価を間違えればピルも間違えます
- **route ごとに1つの単価です** セッション途中で価格が変わる provider や
  リクエストの大きさで単価が変わる route は 実際に払う額に合わせてください
- **通貨の換算はしません** `symbol` が示す通貨でそのまま出します

## 開発

```sh
bun install
bun run build     # lib/index.js（ホスト側）と lib/client.js（ブラウザ側）
bun test          # 値付け・整形・ビルド済みバンドルの検証
bun run check     # 型チェック
```

`lib/` は生成物で git からは除外しています `build.ts` はホスト側を ESM として
（`zod` と `@deepseek-ai/schemastery` は external） ブラウザ側を CJS へ束ねて
client modules が配信する `window.__ModuleLoader__.load({ id, factory })` 形式へ
包みます

## ライセンス

MIT
