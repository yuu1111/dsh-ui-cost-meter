# dsh-ui-cost-meter

English | [日本語](README.ja.md)

Real-time spend for the DeepSeek Harness Web GUI: one pill under the composer,
beside the shipped turn/token pills, that says how much the session has cost so
far.

```
⏱ 1 turns 71 steps · 285 tok/s    🗄 7.3M tok · Cache hit 99%    $ 0.42
```

The amount rides the session projection seam, so it is whole-log (paging and
compaction cannot change it), it survives reloads, and it is priced from the
durable provider usage the harness already logs. The pill is shaped like the
shipped stats pills: clicking it opens a breakdown panel that repeats their
dialog's title, rule, and label/value rows, naming each cache bucket, the
unpriced tokens, and the route that priced them.

## Install

```sh
dsh plugin --profile web add dsh-ui-cost-meter
```

Under a source checkout, `add link:<path>` works the same way. The plugin
declares its own bundle patch, so the row appears in the profile without
editing `cordis.patch.yml`.

## Configure

Every field lives on the plugin row, and every price is per **one million
tokens** in whatever currency `symbol` names.

**No configuration is needed.** The plugin ships a rate table for every model
OpenCode Go, OpenCode Zen, and Command Code served when it was generated:

| Provider | Routes | Where the numbers come from |
|---|---|---|
| `opencode-go` | 36 | [models.dev](https://models.dev/api.json), kept only for the ids `https://opencode.ai/zen/go/v1/models` actually serves |
| `opencode` | 85 | the same, against `https://opencode.ai/zen/v1/models` |
| `command-code` | 87 | `https://api.commandcode.ai/provider/v1/models` for the ids, each model's page under `https://commandcode.ai/models/` for Input, Output, and Cache read |

Write `rates` only for the routes where the shipped number is wrong for you —
a peak-hour price, a different plan, a provider the table has never heard of.
Your key replaces the shipped one for that route:

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

| Field | Meaning |
|---|---|
| `symbol` | Prefixed to every amount. Default `$`. |
| `defaults` | Use the shipped table. Default `true`; `false` prices only what `rates` and `fallback` name. |
| `rates` | Unit prices keyed by `"<provider>/<model>"`, then `"<model>"`. Your key wins over the shipped table. |
| `fallback` | Unit prices for every route no key matches. Omit it to leave unmatched routes unpriced. |

The shipped keys carry the provider names `opencode-go`, `opencode`, and
`command-code`. A profile that names the same provider something else gets no
default for it and needs its own `rates` entries.

### What the shipped table does not promise

One rate per route can only carry one number, so the table holds the **off-peak**
price each provider publishes:

- DeepSeek's list price and Command Code's V4.1 Flash and V4 Flash are exactly
  double at peak, which runs 01:00-04:00 and 06:00-10:00 UTC, Monday through
  Friday. Command Code bills V4 Flash Fast flat, and doubles everything on V4.1
  Flash Fast except the cache read.
- No provider here bills a cache write, so `cacheWrite` is `0`, except on
  OpenCode Zen where the published price has one.
- Command Code's GOAT plan is not a per-token invoice: the $10/month plan grants
  **$60** of DeepSeek V4.1 Flash credits a month, and V4.1 Flash Fast draws on
  the same allowance, so the pill reads as credits burned rather than an amount
  owed. OpenCode Go's $10/month plan likewise meters its rates against the
  plan's limits.
- Ten OpenCode Go ids and two OpenCode Zen ids that the endpoints serve have no
  published price anywhere upstream. The table leaves them out on purpose
  rather than guess.

A route with no matching rate is not guessed at: its tokens are counted as
**unpriced**, contribute nothing to the total, and make the pill mark its amount
with a trailing `+`. The panel then names how many tokens were left unpriced, so
a missing rate is visible instead of silently wrong.

## Where the numbers come from

The host half registers the `costMeter` session projection. It folds the
durable log: a `request/header` sets the route, and each settled
`assistant/message` (or `assistant/attempt`, which preserves a billed attempt
that left no surface message) contributes the provider usage embedded in its
stream. A re-reported sample for the same turn and step replaces the earlier
one; `llm/retry-started` closes that slot so a retried attempt adds instead.
Input, output, cache-read, and cache-write tokens are then priced by the route's
rates, with the shipped table folded under the row's own `rates`.

The client half registers one entry on the `conversation.composer.dock` slot
and renders it into the shipped stats row (`[data-composer-stats]`) with a React
portal, so the cost pill shares that row's font, spacing, and vertical rhythm
instead of starting a row of its own. Without a stats row to join (a session
that has produced no steps or tokens yet) it falls back to drawing its own
centered row.

The pill and its panel carry the shell's own declarations — the same `--dsw-*`
tokens, sizes, radius, and two-column row grid as the shipped pills and their
dialog — because a third-party bundle can only reach the platform modules the
shell seeds, not its CSS modules.

## Caveats

- **Not a billing record.** The figures are the harness's own token accounting
  times the rates in play. The provider's invoice is the authority; a wrong rate
  is a wrong pill.
- **One rate per route.** A provider that changes its price mid-session, or a
  route whose price depends on the request size, needs a rate that reflects what
  you actually pay.
- **Currency is yours to name.** Nothing here converts between currencies.

## Development

```sh
bun install
bun run build     # lib/index.js (host half) and lib/client.js (browser half)
bun test          # pricing fold, formatting, and the built bundle
bun run check     # type check
bun run lint      # biome
```

`src/rates.generated.ts` is the price list the plugin ships, and
`bun run rates:update` rebuilds it. The generator reads
[models.dev](https://models.dev/api.json) plus each provider's `/models`
endpoint for OpenCode, and each Command Code model page for Command Code. Ids
upstream does not price are skipped and named on stderr, so refreshing the table
is one command and a commit.

`lib/` is generated and ignored by git. `build.ts` bundles the host half as ESM
(with `zod` and `@deepseek-ai/schemastery` left external) and the browser half
as CJS wrapped in the `window.__ModuleLoader__.load({ id, factory })` loader
format the client module system serves.

## License

MIT
