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
tokens** in whatever currency `symbol` names. The example below prices DeepSeek
V4.1 Flash (`deepseek-flash`; OpenCode Go's own id is `deepseek-v4.1-flash`,
and Command Code's is `deepseek/deepseek-v4.1-flash`) and DeepSeek V4 Pro at
DeepSeek's published off-peak rates, which the official API, OpenCode Go, and
Command Code all charge. Replace them with the rates you actually pay.

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

One rate per route can only carry the off-peak number, so that is what the
example shows: peak is exactly double in every field and covers 01:00-04:00 and
06:00-10:00 UTC, Monday through Friday. DeepSeek bills no cache writes, so
`cacheWrite` stays `0`, and the retired `deepseek-v4-flash` and
`deepseek-v4-flash-vision-exp` ids now route to V4.1 Flash at the Flash price.
OpenCode Go is a $10/month plan, so its rates meter usage against the plan's
limits rather than pricing a per-token invoice. Command Code lists the same
rates on its Go plan and above.

Sources: [DeepSeek Models & Pricing](https://api-docs.deepseek.com/quick_start/pricing),
[OpenCode Go](https://opencode.ai/docs/go/),
[Command Code: DeepSeek V4.1 Flash](https://commandcode.ai/models/deepseek-v4-1-flash).

| Field | Meaning |
|---|---|
| `symbol` | Prefixed to every amount. Default `$`. |
| `rates` | Unit prices keyed by `"<provider>/<model>"`, then `"<model>"`. The route key wins. |
| `fallback` | Unit prices for every route no key matches. Omit it to price nothing by default. |

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
rates.

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
  times the rates you configured. The provider's invoice is the authority; a
  wrong rate in `rates` is a wrong pill.
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
```

`lib/` is generated and ignored by git. `build.ts` bundles the host half as ESM
(with `zod` and `@deepseek-ai/schemastery` left external) and the browser half
as CJS wrapped in the `window.__ModuleLoader__.load({ id, factory })` loader
format the client module system serves.

## License

MIT
