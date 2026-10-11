/**
 * 既定の単価表を作り直す
 *
 * 上流のカタログから単価を引いて `src/rates.generated.ts` を書く 出力は
 * プラグインへ同梱され 設定の `rates` が同じ key を上書きする
 *
 *   bun run rates:update
 */

import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { Rates } from "../src/shared";
import { rateEntries } from "./sources";

/** 書き出す先 */
const OUTPUT = fileURLToPath(
	new URL("../src/rates.generated.ts", import.meta.url),
);

/**
 * 上流が単価を出していない id の寄せ先
 *
 * OpenCode Go は `deepseek-flash` も配るが models.dev の単価表は
 * `deepseek-v4.1-flash` にしか無い 両者は同じモデルで models.dev の
 * family も名前も一致するため 単価を共有させる それ以外の id は
 * 推測せず落とし 未設定トークンとして数えさせる
 */
const ALIASES: Readonly<Record<string, string>> = {
	"opencode-go/deepseek-flash": "opencode-go/deepseek-v4.1-flash",
};

/**
 * 書き出すファイルの前書き
 */
const HEAD = `/**
 * 既定の単価表
 *
 * このファイルは \`bun run rates:update\` が書く 手で直しても次の生成で消える
 * 設定の \`rates\` に同じ key を書けばその route だけ差し替えられる
 *
 * 出典:
 * - opencode-go / opencode: https://models.dev/api.json と 各 provider の /models
 * - command-code: https://api.commandcode.ai/provider/v1/models と
 *   https://commandcode.ai/models/<slug>
 *
 * 単価は provider が公表するオフピークの値で 100万トークンあたり ピークや
 * 入力の大きさで変わる route と Command Code のキャッシュ書きはここでは
 * 0 のまま 実際に払う額に合わせて設定で上書きする
 */

import type { Rates } from "./shared";

export const DEFAULT_RATES: Readonly<Record<string, Rates>> = {
`;

/**
 * 単価を並べた表を作る
 * @returns key から単価への表
 */
async function buildTable(): Promise<Map<string, Rates>> {
	const table = new Map<string, Rates>();
	for (const entry of await rateEntries()) {
		table.set(`${entry.provider}/${entry.id}`, entry.rates);
	}
	for (const [alias, target] of Object.entries(ALIASES)) {
		const rates = table.get(target);
		if (rates === undefined) throw new Error(`${target} が表に無い`);
		table.set(alias, rates);
	}
	return table;
}

/**
 * key の辞書順で並べる
 *
 * 差分を読みやすくするためだけの並びで 実行時の意味は無い
 * @param left - 比べる組
 * @param right - 比べられる組
 * @returns 辞書順の比較結果
 */
function byKey(
	left: readonly [string, Rates],
	right: readonly [string, Rates],
): number {
	if (left[0] === right[0]) return 0;
	return left[0] < right[0] ? -1 : 1;
}

/**
 * 表を TypeScript のソースにする
 * @param table - 書き出す表
 * @returns ソース全体
 */
function emit(table: ReadonlyMap<string, Rates>): string {
	const rows = [...table.entries()]
		.sort(byKey)
		.map(
			([key, rates]) =>
				`\t${JSON.stringify(key)}: { input: ${rates.input}, output: ${rates.output}, cacheRead: ${rates.cacheRead}, cacheWrite: ${rates.cacheWrite} },`,
		);
	return `${HEAD}${rows.join("\n")}\n};\n`;
}

const table = await buildTable();
await writeFile(OUTPUT, emit(table));
console.log(`${table.size} routes を ${OUTPUT} へ書いた`);
