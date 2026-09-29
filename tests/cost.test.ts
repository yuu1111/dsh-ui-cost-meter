/**
 * 値付けと整形の検証
 *
 * ピルが出す数字はこの2つだけで決まるため ここを固定する
 */

import { describe, expect, test } from "bun:test";
import { Config, type CostMeterState, costMeterProjection } from "../src/index";
import {
	breakdownRows,
	type CostMeterView,
	type CostSettings,
	formatAmount,
	formatTokens,
	resolveRates,
} from "../src/shared";

const settings: CostSettings = {
	symbol: "$",
	rates: {
		"opencode-go/deepseek-flash": {
			input: 0.22,
			output: 0.66,
			cacheRead: 0.007,
			cacheWrite: 0,
		},
		"deepseek-flash": { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 },
	},
};

const header = (provider: string, model: string) =>
	({
		type: "request/header",
		seq: 0,
		time: 0,
		data: { header: { config: { provider, model } }, reason: "initial" },
	}) as never;

const message = (turn: number, step: number, usage: Record<string, number>) =>
	({
		type: "assistant/message",
		seq: 0,
		time: 0,
		data: { turn, step, message: {}, stream: [], usage },
	}) as never;

/**
 * イベント列を畳んで配る値だけ取り出す
 * @param events - 畳むイベント列
 * @returns クライアントが読む値
 */
function fold(events: readonly unknown[]): CostMeterView {
	const definition = costMeterProjection(settings);
	let state: CostMeterState = definition.init({} as never, 0 as never);
	for (const event of events) state = definition.apply(state, event as never);
	return definition.wire.view(state);
}

describe("Config", () => {
	test("fallback を省略すると値付けしない", () => {
		const config = Config({ symbol: "$", rates: {} });
		expect(config.fallback).toBeUndefined();
		expect(resolveRates(config, "other", "unknown")).toBeUndefined();
	});

	test("fallback は省略した欄を0で埋める", () => {
		const config = Config({ rates: {}, fallback: { input: 1 } });
		expect(config.fallback).toEqual({
			input: 1,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
		});
	});
});

describe("resolveRates", () => {
	test("route の key が model だけの key に勝つ", () => {
		expect(resolveRates(settings, "opencode-go", "deepseek-flash")?.input).toBe(
			0.22,
		);
		expect(resolveRates(settings, "other", "deepseek-flash")?.input).toBe(1);
	});

	test("一致が無ければ undefined", () => {
		expect(resolveRates(settings, "other", "unknown")).toBeUndefined();
	});
});

describe("costMeter projection", () => {
	test("usage を単価で値付けする", () => {
		const view = fold([
			header("opencode-go", "deepseek-flash"),
			message(0, 0, {
				inputTokens: 1_000_000,
				outputTokens: 1_000_000,
				cacheReadTokens: 0,
				cacheWriteTokens: 0,
			}),
		]);
		expect(view.input).toBeCloseTo(0.22, 10);
		expect(view.output).toBeCloseTo(0.66, 10);
		expect(view.total).toBeCloseTo(0.88, 10);
		expect(view.tokens).toBe(2_000_000);
		expect(view.unpricedTokens).toBe(0);
		expect(view.provider).toBe("opencode-go");
		expect(view.model).toBe("deepseek-flash");
	});

	test("同じステップの再報告は前の標本を差し替える", () => {
		const view = fold([
			header("opencode-go", "deepseek-flash"),
			message(0, 0, { inputTokens: 1_000_000, outputTokens: 0 }),
			message(0, 0, { inputTokens: 2_000_000, outputTokens: 0 }),
		]);
		expect(view.tokens).toBe(2_000_000);
		expect(view.total).toBeCloseTo(0.44, 10);
	});

	test("別のステップは足し込む", () => {
		const view = fold([
			header("opencode-go", "deepseek-flash"),
			message(1, 1, { inputTokens: 1_000_000, outputTokens: 0 }),
			message(1, 2, { inputTokens: 1_000_000, outputTokens: 0 }),
		]);
		expect(view.tokens).toBe(2_000_000);
		expect(view.total).toBeCloseTo(0.44, 10);
	});

	test("retry の後は同じステップでも足し込む", () => {
		const view = fold([
			header("opencode-go", "deepseek-flash"),
			message(0, 0, { inputTokens: 1_000_000, outputTokens: 0 }),
			{
				type: "llm/retry-started",
				seq: 0,
				time: 0,
				data: { turn: 0, step: 0 },
			},
			message(0, 0, { inputTokens: 1_000_000, outputTokens: 0 }),
		]);
		expect(view.tokens).toBe(2_000_000);
		expect(view.total).toBeCloseTo(0.44, 10);
	});

	test("単価の無い route は未設定トークンとして数える", () => {
		const view = fold([
			header("other", "unknown"),
			message(0, 0, { inputTokens: 1_000_000, outputTokens: 500 }),
		]);
		expect(view.total).toBe(0);
		expect(view.tokens).toBe(1_000_500);
		expect(view.unpricedTokens).toBe(1_000_500);
	});
});

describe("formatting", () => {
	test("金額は大きさに応じた桁で出す", () => {
		expect(formatAmount(0)).toBe("0.0000");
		expect(formatAmount(0.0012)).toBe("0.0012");
		expect(formatAmount(0.4212)).toBe("0.421");
		expect(formatAmount(12.3456)).toBe("12.35");
	});

	test("トークン数は短い形にする", () => {
		expect(formatTokens(999)).toBe("999");
		expect(formatTokens(1_200)).toBe("1.2k");
		expect(formatTokens(7_300_000)).toBe("7.3M");
	});

	test("内訳の行は未設定トークンと route を明示する", () => {
		const view: CostMeterView = {
			symbol: "$",
			total: 0.42,
			input: 0.1,
			output: 0.32,
			cacheRead: 0,
			cacheWrite: 0,
			tokens: 1_000_000,
			unpricedTokens: 1_200,
			provider: "opencode-go",
			model: "deepseek-flash",
		};
		expect(breakdownRows(view)).toEqual([
			{ label: "Uncached input", value: "$0.100" },
			{ label: "Cached input", value: "$0.000" },
			{ label: "Output", value: "$0.320" },
			{ label: "Unpriced", value: "1.2k tok" },
			{
				label: "Provider / model",
				value: "opencode-go/deepseek-flash",
				route: true,
			},
		]);
	});
});
