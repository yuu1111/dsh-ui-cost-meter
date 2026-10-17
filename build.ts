/**
 * lib/ をビルドする
 *
 * ホスト側は ESM として出し ブラウザ側は CJS へ束ねてから client-modules が
 * 配信するローダー形式（`window.__ModuleLoader__.load({ id, factory })`）へ包む
 * ブラウザ側が実行時に要求してよいのは shell が配るプラットフォームモジュール
 * だけで それ以外を取り込むとバンドルが二重に読み込まれるため 許可した
 * specifier 以外を検出したら失敗する
 */

import { readFile, rm, writeFile } from "node:fs/promises";

/**
 * 配信側がモジュール名として使う値
 *
 * client modules は最も近い package.json の name をモジュール名にするため
 * この値は package.json の name と一致させる 試験が一致を見ている
 */
const MODULE_ID = "dsh-ui-cost-meter";

/**
 * 出力先 DSH のプラグイン慣例に合わせる
 */
const OUT_DIR = "lib";

/**
 * ホスト側が実行時に要求してよい specifier
 *
 * いずれも profile の node_modules から解決できるため バンドルへ抱え込まない
 */
const HOST_EXTERNALS = ["zod", "@deepseek-ai/schemastery"];

/**
 * ブラウザ側が実行時に要求してよい specifier
 *
 * いずれも shell が最初から持つプラットフォームモジュールで `dsh.client.external`
 * の宣言は要らない
 */
const CLIENT_EXTERNALS = [
	"react",
	"react/jsx-runtime",
	"react-dom",
	"@deepseek-ai/dsh-client-ui-primitives",
];

/**
 * 配信されるバンドルは読み込み時に自分自身をローダーへ登録する
 */
const LOADER_HEAD = `window.__ModuleLoader__.load({
\tid: ${JSON.stringify(MODULE_ID)},
\tfactory: (require) => {
\t\tvar module = { exports: {} };
\t\tvar exports = module.exports;
`;

/**
 * ローダーの factory から プラグイン面を返して閉じる
 */
const LOADER_TAIL = `
\t\treturn module.exports;
\t}
});
`;

/**
 * プラグイン面として外へ出す名前
 */
const EXPORTS = ["apply", "inject"];

/**
 * 失敗したビルドのログを出して中断する
 *
 * @param label - どちらのビルドか
 * @param result - Bun.build の結果
 */
function assertBuilt(
	label: string,
	result: { success: boolean; logs: readonly unknown[] },
): void {
	if (result.success) {
		return;
	}
	for (const log of result.logs) {
		console.error(log);
	}
	throw new Error(`${label} のビルドに失敗した`);
}

/**
 * 束ねたバンドルが満たすべき条件を確かめる
 *
 * 実行時に解決するモジュールを許可リストへ限定し プラグイン面の公開を確認する
 * @param body - 包む前の CJS バンドル
 */
function assertClientBundle(body: string): void {
	const required = new Set(
		[...body.matchAll(/\brequire\(\s*["']([^"']+)["']\s*\)/g)].map(
			(match) => match[1] ?? "",
		),
	);
	for (const specifier of required) {
		if (!CLIENT_EXTERNALS.includes(specifier)) {
			throw new Error(
				`client バンドルが許可していないモジュールを要求している: ${specifier}`,
			);
		}
	}
	if (!/\bmodule\.exports\s*=/.test(body)) {
		throw new Error("client バンドルが読み出し面を公開していない");
	}
	for (const name of EXPORTS) {
		if (!new RegExp(`\\b${name}\\s*:`).test(body)) {
			throw new Error(`client バンドルが ${name} を公開していない`);
		}
	}
}

await rm(OUT_DIR, { force: true, recursive: true });

assertBuilt(
	"host",
	await Bun.build({
		entrypoints: ["src/index.ts"],
		outdir: OUT_DIR,
		target: "node",
		format: "esm",
		external: HOST_EXTERNALS,
	}),
);

assertBuilt(
	"client",
	await Bun.build({
		entrypoints: ["src/client.tsx"],
		outdir: OUT_DIR,
		target: "browser",
		format: "cjs",
		external: CLIENT_EXTERNALS,
		jsx: { development: false },
	}),
);

const clientPath = `${OUT_DIR}/client.js`;
const bundle = await readFile(clientPath, "utf8");
assertClientBundle(bundle);
await writeFile(clientPath, LOADER_HEAD + bundle + LOADER_TAIL);

console.log(`built ${OUT_DIR}/index.js and ${clientPath} for ${MODULE_ID}`);
