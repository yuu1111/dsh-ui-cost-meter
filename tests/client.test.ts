/**
 * 配信されるバンドルの検証
 *
 * ビルド済みの lib/client.js をローダー形式ごと読み込み プラグイン面の公開と
 * 統計ドックへの登録を確かめる 描画は react-dom/server で行い ピルが出す
 * 数字と 出さない条件を見る
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createElement, type FunctionComponent } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { z as zod } from "zod";
import { costMeterProjection } from "../src/index";
import type { CostMeterView } from "../src/shared";

/**
 * ローダーが捕まえた登録
 */
interface LoadedBundle {
	id: string;
	exports: Record<string, unknown>;
}

/**
 * 偽のスロット登録面が捕まえた値
 */
interface CapturedRegistration {
	key: string;
	options: Record<string, unknown>;
	component: unknown;
}

/**
 * バンドルをローダー形式ごと読み込む
 * @returns モジュール名とプラグイン面
 */
function loadBundle(): LoadedBundle {
	const code = readFileSync(
		new URL("../lib/client.js", import.meta.url),
		"utf8",
	);
	let loaded: LoadedBundle | undefined;
	const window = {
		__ModuleLoader__: {
			load: (entry: {
				id: string;
				factory: (
					require: (specifier: string) => unknown,
				) => Record<string, unknown>;
			}) => {
				loaded = { id: entry.id, exports: entry.factory(requireForBundle) };
			},
		},
	};
	// シェルが配るモジュールだけを require で見せる
	const requireForBundle = (specifier: string): unknown => {
		if (specifier === "react") return React;
		if (specifier === "react/jsx-runtime") return jsxRuntime;
		if (specifier === "react-dom") return reactDom;
		if (specifier === "@deepseek-ai/dsh-client-ui-primitives")
			return {
				useAnchoredPosition: () => null,
				useDismissOnOutsidePointer: () => undefined,
			};
		throw new Error(`unexpected require: ${specifier}`);
	};
	new Function("window", "require", code)(window, requireForBundle);
	if (loaded === undefined)
		throw new Error("バンドルがローダーへ登録しなかった");
	return loaded;
}

/**
 * style タグを入れる口だけを持つ偽の document
 *
 * bun test には DOM が無いため ピルの見た目を配る経路だけ手で用意する
 */
const styleTags: { id: string; textContent: string; remove: () => void }[] = [];
(globalThis as { document?: unknown }).document = {
	getElementById: (id: string) =>
		styleTags.find((tag) => tag.id === id)?.id ? { id } : null,
	createElement: () => {
		const element = {
			id: "",
			textContent: "",
			remove: () => {
				const index = styleTags.indexOf(element);
				if (index >= 0) styleTags.splice(index, 1);
			},
		};
		styleTags.push(element);
		return element;
	},
	head: { append: () => undefined },
};

const React = await import("react");
const jsxRuntime = await import("react/jsx-runtime");
const reactDom = await import("react-dom");

/**
 * 偽のクライアントコンテキストを作る
 * @param captured - 登録を書き込む先
 * @returns `apply` へ渡すコンテキスト
 */
function fakeContext(captured: CapturedRegistration[]): unknown {
	return {
		effect: (callback: () => unknown) => {
			const dispose = callback();
			return typeof dispose === "function" ? dispose : () => undefined;
		},
		slots: {
			inject: (_key: string, callback: () => unknown) => {
				callback();
				return () => undefined;
			},
			register: (options: Record<string, unknown>, component: unknown) => {
				captured.push({ key: String(options.name), options, component });
				return () => undefined;
			},
		},
	};
}

const viewSchema: zod.ZodType<CostMeterView> = zod.strictObject({
	symbol: zod.string(),
	total: zod.number(),
	input: zod.number(),
	output: zod.number(),
	cacheRead: zod.number(),
	cacheWrite: zod.number(),
	tokens: zod.number(),
	unpricedTokens: zod.number(),
	provider: zod.string().nullable(),
	model: zod.string().nullable(),
});

const view: CostMeterView = {
	symbol: "$",
	total: 0.4212,
	input: 0.1,
	output: 0.3212,
	cacheRead: 0,
	cacheWrite: 0,
	tokens: 1_000_000,
	unpricedTokens: 0,
	provider: "opencode-go",
	model: "deepseek-flash",
};

describe("client bundle", () => {
	test("ローダー形式でプラグイン面を公開する", () => {
		const loaded = loadBundle();
		expect(loaded.id).toBe("dsh-ui-cost-meter");
		expect(loaded.exports.inject).toEqual(["slots"]);
		expect(typeof loaded.exports.apply).toBe("function");
	});

	test("統計ドックへ統計ピルの後ろのピルとして登録する", () => {
		const loaded = loadBundle();
		const captured: CapturedRegistration[] = [];
		(loaded.exports.apply as (ctx: unknown) => void)(fakeContext(captured));
		expect(captured).toHaveLength(1);
		expect(captured[0]?.key).toBe("conversation.composer.dock");
		expect(captured[0]?.options.id).toBe("cost");
		expect(captured[0]?.options.order).toBe(10);
	});

	test("パネルは組み込みの統計ダイアログと同じ面と組で持つ", () => {
		const loaded = loadBundle();
		const captured: CapturedRegistration[] = [];
		(loaded.exports.apply as (ctx: unknown) => void)(fakeContext(captured));
		const css =
			styleTags.find((tag) => tag.id === "dsh-ui-cost-meter/style.css")
				?.textContent ?? "";

		// 組み込みの統計ピルのダイアログと同じ面 影 角丸を使う
		expect(css).toContain("background:var(--dsw-specific-menu)");
		expect(css).toContain("box-shadow:var(--dsw-elevation-prominent)");
		expect(css).toContain("border-radius:var(--dsw-radius-lg)");

		// 面は不透明ではないため 背後をぼかす組の宣言を必ず添える
		expect(css).toContain("backdrop-filter:var(--dsw-menu-backdrop-filter)");
	});

	test("金額があればピルを描く", () => {
		const loaded = loadBundle();
		const captured: CapturedRegistration[] = [];
		(loaded.exports.apply as (ctx: unknown) => void)(fakeContext(captured));
		const pill = captured[0]?.component as FunctionComponent<{
			useProjection: (key: string) => CostMeterView;
		}>;
		const markup = renderToStaticMarkup(
			createElement(pill, {
				useProjection: () => viewSchema.parse(view),
			}),
		);
		// シェルの統計ピルと同じく 押すと開く引き金として描く
		expect(markup).toContain("dsh-ui-cost-meter-pill");
		expect(markup).toContain('aria-haspopup="dialog"');
		expect(markup).toContain(">0.421<");
		expect(markup).not.toContain("dsh-ui-cost-meter-unpriced");
	});

	test("課金が無ければ何も描かない", () => {
		const loaded = loadBundle();
		const captured: CapturedRegistration[] = [];
		(loaded.exports.apply as (ctx: unknown) => void)(fakeContext(captured));
		const pill = captured[0]?.component as FunctionComponent<{
			useProjection: (key: string) => CostMeterView;
		}>;
		const markup = renderToStaticMarkup(
			createElement(pill, {
				useProjection: () => viewSchema.parse({ ...view, total: 0, tokens: 0 }),
			}),
		);
		// 席の目印だけを残し ピルは描かない
		expect(markup).not.toContain("dsh-ui-cost-meter-pill");
	});

	test("未設定トークンがあれば印を付ける", () => {
		const loaded = loadBundle();
		const captured: CapturedRegistration[] = [];
		(loaded.exports.apply as (ctx: unknown) => void)(fakeContext(captured));
		const pill = captured[0]?.component as FunctionComponent<{
			useProjection: (key: string) => CostMeterView;
		}>;
		const markup = renderToStaticMarkup(
			createElement(pill, {
				useProjection: () =>
					viewSchema.parse({ ...view, unpricedTokens: 1_200 }),
			}),
		);
		expect(markup).toContain("dsh-ui-cost-meter-unpriced");
	});
});

describe("projection definition", () => {
	test("状態を JSON のまま畳む", () => {
		const definition = costMeterProjection({ symbol: "$", rates: {} });
		const state = definition.init(undefined as never, undefined as never);
		expect(JSON.parse(JSON.stringify(state))).toEqual(state);
		expect(state.wire.total).toBe(0);
	});
});
