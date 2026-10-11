/**
 * 同梱の既定単価表の検証
 *
 * 上流のカタログから作った表が設定へどう畳まれるかを固定する 表そのものは
 * 生成物なので 値の正しさは `bun run rates:update` の再実行で確かめる
 */

import { describe, expect, test } from "bun:test";
import {
	apply,
	Config,
	type CostConfig,
	type CostMeterState,
} from "../src/index";
import { DEFAULT_RATES } from "../src/rates.generated";
import type { CostMeterView } from "../src/shared";

/** 表に載ってよい provider DSH の route 名と揃える */
const PROVIDERS = ["opencode-go", "opencode", "command-code"];

/**
 * 登録された投影の呼び出し面
 */
interface Definition {
	init: (context: never, seq: never) => CostMeterState;
	apply: (state: CostMeterState, event: never) => CostMeterState;
	wire: { view: (state: CostMeterState) => CostMeterView };
}

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
 * 行の設定で投影を組み イベント列を畳んで配る値だけ取り出す
 * @param config - 行の `config` に書く値
 * @param events - 畳むイベント列
 * @returns クライアントが読む値
 */
function fold(config: CostConfig, events: readonly unknown[]): CostMeterView {
	let definition: Definition | undefined;
	apply(
		{
			sessionProjections: {
				register: (registered: Definition) => {
					definition = registered;
				},
			},
		} as never,
		config,
	);
	const registered = definition as Definition;
	let state = registered.init({} as never, 0 as never);
	for (const event of events) state = registered.apply(state, event as never);
	return registered.wire.view(state);
}

describe("既定の単価表", () => {
	test("全ての key が provider と model に分かれる", () => {
		const keys = Object.keys(DEFAULT_RATES);
		expect(keys.length).toBeGreaterThan(150);
		for (const key of keys) {
			const separator = key.indexOf("/");
			expect(separator).toBeGreaterThan(0);
			expect(PROVIDERS).toContain(key.slice(0, separator));
			expect(key.length).toBeGreaterThan(separator + 1);
		}
	});

	test("単価は有限の非負数", () => {
		for (const [key, rates] of Object.entries(DEFAULT_RATES)) {
			for (const [field, value] of Object.entries(rates)) {
				expect(Number.isFinite(value), `${key}/${field}`).toBe(true);
				expect(value, `${key}/${field}`).toBeGreaterThanOrEqual(0);
			}
		}
	});

	test("上流の公表値と一致する", () => {
		expect(DEFAULT_RATES["opencode-go/deepseek-v4.1-flash"]).toEqual({
			input: 0.15,
			output: 0.6,
			cacheRead: 0.003,
			cacheWrite: 0,
		});
		expect(DEFAULT_RATES["opencode-go/deepseek-flash"]).toEqual(
			DEFAULT_RATES["opencode-go/deepseek-v4.1-flash"],
		);
		expect(DEFAULT_RATES["opencode/claude-opus-5"]).toEqual({
			input: 5,
			output: 25,
			cacheRead: 0.5,
			cacheWrite: 6.25,
		});
		expect(
			DEFAULT_RATES["command-code/deepseek/deepseek-v4-flash-fast"],
		).toEqual({
			input: 0.28,
			output: 0.56,
			cacheRead: 0.07,
			cacheWrite: 0,
		});
	});

	test("無償の route は0で載る", () => {
		expect(DEFAULT_RATES["command-code/stealth/glyph-cluster:free"]).toEqual({
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
		});
	});
});

describe("既定表の畳み込み", () => {
	test("設定を書かなくても既定表で値付けする", () => {
		const view = fold(Config({}), [
			header("opencode-go", "deepseek-v4.1-flash"),
			message(0, 0, { inputTokens: 1_000_000, outputTokens: 1_000_000 }),
		]);
		expect(view.total).toBeCloseTo(0.75, 10);
		expect(view.unpricedTokens).toBe(0);
	});

	test("設定の単価が既定表に勝つ", () => {
		const view = fold(
			Config({
				rates: {
					"opencode-go/deepseek-v4.1-flash": {
						input: 1,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
					},
				},
			}),
			[
				header("opencode-go", "deepseek-v4.1-flash"),
				message(0, 0, { inputTokens: 1_000_000, outputTokens: 0 }),
			],
		);
		expect(view.total).toBeCloseTo(1, 10);
	});

	test("既定表を切ると未設定として数える", () => {
		const view = fold(Config({ defaults: false }), [
			header("opencode-go", "deepseek-v4.1-flash"),
			message(0, 0, { inputTokens: 1_000_000, outputTokens: 0 }),
		]);
		expect(view.total).toBe(0);
		expect(view.unpricedTokens).toBe(1_000_000);
	});

	test("既定表を切っても設定の単価は効く", () => {
		const view = fold(
			Config({
				defaults: false,
				rates: {
					"command-code/deepseek/deepseek-v4-flash": {
						input: 0.15,
						output: 0.6,
						cacheRead: 0.003,
						cacheWrite: 0,
					},
				},
			}),
			[
				header("command-code", "deepseek/deepseek-v4-flash"),
				message(0, 0, { inputTokens: 1_000_000, outputTokens: 1_000_000 }),
			],
		);
		expect(view.total).toBeCloseTo(0.75, 10);
	});
});
