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
`symbol` が示すものに揃えてください

**設定しなくても値付けします** 同梱の単価表が OpenCode Go・OpenCode Zen・
Command Code のモデルを生成時点のぶんだけ持っています

| provider | route 数 | 数字の出どころ |
|---|---|---|
| `opencode-go` | 37 | [models.dev](https://models.dev/api.json) の単価を `https://opencode.ai/zen/go/v1/models` が実際に配る id だけに絞ったもの |
| `opencode` | 82 | 同じく `https://opencode.ai/zen/v1/models` に対して |
| `command-code` | 89 | id は `https://api.commandcode.ai/provider/v1/models` 各モデルの単価は `https://commandcode.ai/models/` の下のページの Input・Output・Cache read |

`rates` に書くのは 同梱の数字が自分の支払いと違う route だけでかまいません ピーク時間の
単価 別のプラン 同梱の表が知らない provider などです 同じ key を書けばその route だけ
差し替わります

```yaml
- id: cost-meter
  name: dsh-ui-cost-meter
  config:
    symbol: '$'
    rates:
      deepseek-official/deepseek-flash:
        input: 0.15
        output: 0.6
        cacheRead: 0.003
        cacheWrite: 0
```

| フィールド | 意味 |
|---|---|
| `symbol` | 金額の前に付ける記号 既定は `$` |
| `defaults` | 同梱の単価表を使うか 既定は `true` `false` にすると `rates` と `fallback` が指す route だけを値付けします |
| `rates` | 単価表 キーは `"<provider>/<model>"` 次に `"<model>"` 同梱の表より優先されます |
| `fallback` | どのキーにも一致しない route の単価 省略すると既定では値付けしない |

同梱のキーが使う provider 名は `opencode-go`・`opencode`・`command-code` です
同じ provider に別の名前を付けた profile では既定が効かないため その名前で `rates` を
書いてください

### 同梱の表が約束しないこと

route ごとに1つしか置けないため 同梱の表は provider が公表する **オフピーク** の単価を
持ちます

- DeepSeek の公示単価と Command Code の V4.1 Flash・V4 Flash はピークにちょうど倍に
  なります ピークは月曜から金曜の 01:00-04:00 UTC と 06:00-10:00 UTC です
  Command Code の V4 Flash Fast は終日同じ単価で V4.1 Flash Fast はキャッシュ読み
  だけが倍になりません
- ここに挙げた provider はキャッシュ書きを課金しません そのため `cacheWrite` は
  `0` です ただし公表単価にキャッシュ書きがある OpenCode Zen はその値を持ちます
- Command Code の GOAT プランはこれらのモデルをトークン単位では請求しません
  月10ドルのプランに DeepSeek V4.1 Flash の **60ドル** ぶんの月次クレジットが付き
  V4.1 Flash Fast も同じ枠を使います そのためこの単価が作るピルは請求額ではなく
  クレジットの消費を示します OpenCode Go も同じく月10ドルのプランの使用上限に対する
  計量です
- endpoint が配っていても上流が単価を公表していない id が OpenCode Go に10 件
  OpenCode Zen に2 件あります 同梱の表は推測せずこれらを載せません

単価の無い route は推測せず **未設定** として数えます 合計には入らず ピルの金額に
末尾の `+` が付きます 内訳のパネルには未設定のトークン数が出るため 単価の抜けが
黙って間違った金額になることはありません

## 数字の出どころ

ホスト側は `costMeter` セッション投影を登録します `request/header` で route を決め
確定した `assistant/message`（表面にメッセージを残さなかった課金済みの試行は
`assistant/attempt`）が stream に埋め込んだ usage を畳みます 同じターンとステップの
再報告は前の標本を差し替え `llm/retry-started` はその枠を閉じるため 再試行は
足し込まれます 入力・出力・キャッシュ読み・キャッシュ書きのトークンを route の
単価で値付けします 同梱の表は行の `rates` の下に重ねます

ブラウザ側は `conversation.composer.dock` 枠へ1つ登録し React の portal で
シェルの統計ピルの行（`[data-composer-stats]`）へ差し込みます そのため字・間隔・
高さがその行のまま揃い 別の行を始めません 行の目印を持たないシェル
（DSH 0.2.1 以降）では 包まずにドックの行へそのまま並べます

ピルとそのパネルはシェル側の宣言（`--dsw-*` のトークン・寸法・角丸・2列の行の
組み方）をそのまま持ちます 外部のバンドルはシェルが配るプラットフォームモジュール
だけを読め その CSS Modules には届かないためです

## 注意

- **請求書ではありません** ハーネスのトークン計数に いま効いている単価を掛けたものです
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
bun run lint      # biome
```

同梱する値段の一覧 `src/rates.generated.ts` は `bun run rates:update` で
作り直せます [models.dev](https://models.dev/api.json) と OpenCode の各 `/models`
Command Code の各モデルページを読み 上流が単価を公表していない id は警告に出して
飛ばします 更新はこのコマンドを回して差分をコミットするだけです

`lib/` は生成物で git からは除外しています `build.ts` はホスト側を ESM として
（`zod` と `@deepseek-ai/schemastery` は external） ブラウザ側を CJS へ束ねて
client modules が配信する `window.__ModuleLoader__.load({ id, factory })` 形式へ
包みます

## ライセンス

MIT
