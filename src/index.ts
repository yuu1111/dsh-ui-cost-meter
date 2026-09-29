/**
 * ホスト側の本体
 *
 * 耐久ログに残る provider usage を設定の単価で値付けし セッション投影
 * `costMeter` として配る 集計はログ全体を畳んだものなので ページングや圧縮で
 * 変わらない ブラウザ側のピルはこの値を読むだけで 単価を一切知らない
 */

import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-llm-retry/types";
import type { SessionEvent } from "@deepseek-ai/dsh-session";
import type { ProjectionDefinition } from "@deepseek-ai/dsh-session-projection";
import z from "@deepseek-ai/schemastery";
import { z as zod } from "zod";
import {
	addParts,
	type Buckets,
	bucketsEqual,
	bucketsFromUsage,
	type CostMeterView,
	type CostParts,
	type CostSettings,
	PROJECTION_KEY,
	priceBuckets,
	type Rates,
	resolveRates,
	subtractParts,
	tokenTotal,
	totalOf,
	ZERO_PARTS,
} from "./shared";

/** cordis のプラグイン名 */
export const name = "cost-meter";

/**
 * このプラグインが待つサービス
 *
 * 投影レジストリが無い構成では登録する先が無いため 起動を待たせる
 */
export const inject = ["sessionProjections"];

/**
 * 1つの route の単価 省略したフィールドは0として扱う
 */
const RatesSchema = z.object({
	input: z.number().min(0).default(0),
	output: z.number().min(0).default(0),
	cacheRead: z.number().min(0).default(0),
	cacheWrite: z.number().min(0).default(0),
});

/**
 * 一致する route が無いときに使う単価
 *
 * 素の `RatesSchema` を置くと schemastery が省略時にも0埋めの単価を生やすため
 * 未設定トークンが黙って0円になる 省略時は `undefined` のまま残し
 * `resolveRates` が未設定として数えられるようにする
 */
const FallbackSchema = z.union([RatesSchema, z.const(undefined)]);

/**
 * 行の `config` が取る形
 */
export const Config = z.object({
	symbol: z.string().default("$"),
	rates: z.dict(RatesSchema).default({}),
	fallback: FallbackSchema,
});

/**
 * 検証済みの設定
 */
export type CostConfig = {
	symbol: string;
	rates: Record<string, Rates>;
	fallback?: Rates | undefined;
};

/**
 * 直近のリクエストが使った route
 */
interface Route {
	readonly provider: string;
	readonly model: string;
}

/**
 * 1つのステップが報告した標本
 *
 * `cost` は値付けできなかったとき0 未設定ぶんは `unpriced` が持つ
 */
interface Sample {
	readonly turn: number;
	readonly step: number;
	readonly buckets: Buckets;
	readonly cost: CostParts;
	readonly unpriced: number;
}

/**
 * 折り畳みの状態
 *
 * 耐久キャッシュに載るため plain JSON に保つ `wire` は配る値そのもので
 * 見た目が変わらない遷移では同じ参照を持ち回り 変更フィードを静かに保つ
 */
export interface CostMeterState {
	/** 値付けできた金額の累計 */
	readonly parts: CostParts;
	/** 値付けしたトークン数の累計 */
	readonly tokens: number;
	/** 単価が見つからなかったトークン数の累計 */
	readonly unpricedTokens: number;
	/** 直近のリクエストの route */
	readonly route: Route | null;
	/** 同じステップの再報告で差し替えるための直前の標本 */
	readonly last: Sample | null;
	/** クライアントへ配る値 */
	readonly wire: CostMeterView;
}

declare module "@deepseek-ai/dsh-session-projection/types" {
	interface SessionProjectionStateMap {
		/** `costMeter` の折り畳み状態 */
		costMeter: CostMeterState;
	}
}

/**
 * 金額の内訳のスキーマ
 */
const partsSchema = zod.strictObject({
	input: zod.number(),
	output: zod.number(),
	cacheRead: zod.number(),
	cacheWrite: zod.number(),
});

/**
 * バケットのスキーマ
 */
const bucketsSchema = zod.strictObject({
	uncachedInput: zod.number(),
	output: zod.number(),
	cacheRead: zod.number(),
	cacheWrite: zod.number(),
});

/**
 * 配る値のスキーマ クライアントが読む形そのもの
 */
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

/**
 * 耐久キャッシュの行を受理するスキーマ
 */
const stateSchema: zod.ZodType<CostMeterState> = zod.strictObject({
	parts: partsSchema,
	tokens: zod.number(),
	unpricedTokens: zod.number(),
	route: zod
		.strictObject({ provider: zod.string(), model: zod.string() })
		.nullable(),
	last: zod
		.strictObject({
			turn: zod.number(),
			step: zod.number(),
			buckets: bucketsSchema,
			cost: partsSchema,
			unpriced: zod.number(),
		})
		.nullable(),
	wire: viewSchema,
});

/**
 * 耐久イベントから usage を取り出す
 *
 * `assistant/message` は組み立て済みの usage を持ち 持たない場合は同じ
 * イベントの stream に残る最後の usage チャンクを見る `assistant/attempt` は
 * 表面に何も残さなかった試行だが 課金はされているため同じ経路で拾う
 * @param event - 畳む耐久イベント
 * @returns 報告された usage 無ければ undefined
 */
function usageOf(event: SessionEvent): unknown {
	if (event.type === "assistant/message" && event.data.usage !== undefined)
		return event.data.usage;
	if (event.type !== "assistant/message" && event.type !== "assistant/attempt")
		return undefined;
	return lastStreamUsage(event.data.stream);
}

/**
 * stream に残る最後の usage チャンクを探す
 * @param stream - 耐久ログの compact 済み stream 記録
 * @returns 最後の usage チャンクが持つ usage 無ければ undefined
 */
function lastStreamUsage(stream: unknown): unknown {
	if (!Array.isArray(stream)) return undefined;
	for (let index = stream.length - 1; index >= 0; index -= 1) {
		const record = stream[index] as
			| { type?: unknown; chunk?: { type?: unknown; usage?: unknown } }
			| undefined;
		if (record?.type === "chunk" && record.chunk?.type === "usage")
			return record.chunk.usage;
	}
	return undefined;
}

/**
 * 配る値を組み立てる
 * @param parts - 金額の内訳
 * @param tokens - 値付けしたトークン数
 * @param unpricedTokens - 値付けできなかったトークン数
 * @param route - 直近の route
 * @param symbol - 金額の前に付ける記号
 * @returns クライアントへ配る値
 */
function buildView(
	parts: CostParts,
	tokens: number,
	unpricedTokens: number,
	route: Route | null,
	symbol: string,
): CostMeterView {
	return {
		symbol,
		total: totalOf(parts),
		input: parts.input,
		output: parts.output,
		cacheRead: parts.cacheRead,
		cacheWrite: parts.cacheWrite,
		tokens,
		unpricedTokens,
		provider: route?.provider ?? null,
		model: route?.model ?? null,
	};
}

/**
 * 残高を差し替えながら1つの標本を足す
 *
 * 取り消す相手は同じステップの直前の標本だけ 別のステップの標本はそのまま
 * 積み上げる 呼び出し側が同じステップかを判定して渡す
 * @param state - 直前の状態
 * @param previous - 同じステップの直前の標本 無ければ null
 * @param sample - 足す標本
 * @param route - 標本の時点で有効な route
 * @param symbol - 金額の前に付ける記号
 * @returns 次の状態
 */
function withSample(
	state: CostMeterState,
	previous: Sample | null,
	sample: Sample,
	route: Route | null,
	symbol: string,
): CostMeterState {
	const tokens =
		state.tokens -
		(previous === null ? 0 : tokenTotal(previous.buckets)) +
		tokenTotal(sample.buckets);
	const unpricedTokens =
		state.unpricedTokens - (previous?.unpriced ?? 0) + sample.unpriced;
	const parts = addParts(
		subtractParts(state.parts, previous?.cost ?? ZERO_PARTS),
		sample.cost,
	);
	return {
		...state,
		parts,
		tokens,
		unpricedTokens,
		last: sample,
		wire: buildView(parts, tokens, unpricedTokens, route, symbol),
	};
}

/**
 * route を差し替える
 *
 * 標本を値付けした route が変わったときだけ 配る値を作り直す
 * @param state - 直前の状態
 * @param config - リクエストの provider と model
 * @param settings - 単価と表示記号を持つ設定
 * @returns 次の状態
 */
function withRoute(
	state: CostMeterState,
	config: Route,
	settings: CostSettings,
): CostMeterState {
	if (
		state.route?.provider === config.provider &&
		state.route.model === config.model
	)
		return state;
	const route: Route = { provider: config.provider, model: config.model };
	return {
		...state,
		route,
		wire: buildView(
			state.parts,
			state.tokens,
			state.unpricedTokens,
			route,
			settings.symbol,
		),
	};
}

/**
 * 再試行が始まったステップの標本枠を閉じる
 *
 * 閉じることで再試行の標本が前の試行を差し替えず 足し込まれる
 * @param state - 直前の状態
 * @param turn - 再試行するターン
 * @param step - 再試行するステップ
 * @returns 次の状態
 */
function withoutRetriedSample(
	state: CostMeterState,
	turn: number,
	step: number,
): CostMeterState {
	return state.last !== null &&
		state.last.turn === turn &&
		state.last.step === step
		? { ...state, last: null }
		: state;
}

/**
 * 耐久イベントから1つの標本を読む
 *
 * 同じステップの直前の標本も一緒に返す 呼び出し側は再報告かどうかをそれで見る
 * @param state - 直前の状態
 * @param event - 畳む耐久イベント
 * @param settings - 単価と表示記号を持つ設定
 * @returns 直前の標本と読んだ標本 標本を持たないイベントでは null
 */
function readSample(
	state: CostMeterState,
	event: SessionEvent,
	settings: CostSettings,
): { previous: Sample | null; sample: Sample } | null {
	if (event.type !== "assistant/message" && event.type !== "assistant/attempt")
		return null;
	const usage = usageOf(event);
	if (usage === undefined) return null;
	const buckets = bucketsFromUsage(usage);
	if (buckets === undefined) return null;
	const turn = event.data.turn;
	const step = event.data.step;
	const previous =
		state.last !== null && state.last.turn === turn && state.last.step === step
			? state.last
			: null;
	const rates = resolveRates(
		settings,
		state.route?.provider ?? null,
		state.route?.model ?? null,
	);
	const parts = priceBuckets(buckets, rates) ?? ZERO_PARTS;
	return {
		previous,
		sample: {
			turn,
			step,
			buckets,
			cost: parts,
			unpriced: rates === undefined ? tokenTotal(buckets) : 0,
		},
	};
}

/**
 * クライアントへ配る値を持つ投影定義
 *
 * 登録面は `wire` を持つ定義だけをクライアント可視として受け取るため
 * 省略可能な元の型のままでは渡せない
 */
type CostMeterDefinition = Omit<
	ProjectionDefinition<"costMeter", CostMeterState>,
	"wire"
> & {
	readonly wire: {
		readonly viewSchema: zod.ZodType<CostMeterView>;
		readonly view: (state: CostMeterState) => CostMeterView;
	};
};

/**
 * 耐久ログを畳む投影ユニットを作る
 * @param settings - 単価と表示記号を持つ設定
 * @returns `costMeter` の投影定義
 */
export function costMeterProjection(
	settings: CostSettings,
): CostMeterDefinition {
	return {
		key: PROJECTION_KEY,
		stateVersion: 1,
		stateSchema,
		init: () => ({
			parts: ZERO_PARTS,
			tokens: 0,
			unpricedTokens: 0,
			route: null,
			last: null,
			wire: buildView(ZERO_PARTS, 0, 0, null, settings.symbol),
		}),
		apply: (state, event) => {
			if (event.type === "request/header") {
				return withRoute(state, event.data.header.config, settings);
			}
			if (event.type === "llm/retry-started") {
				return withoutRetriedSample(state, event.data.turn, event.data.step);
			}
			const read = readSample(state, event, settings);
			if (read === null) return state;
			// 同じ試行の再報告は集計を動かさない
			if (
				read.previous !== null &&
				bucketsEqual(read.previous.buckets, read.sample.buckets)
			) {
				return state;
			}
			return withSample(
				state,
				read.previous,
				read.sample,
				state.route,
				settings.symbol,
			);
		},
		wire: {
			viewSchema,
			view: (state) => state.wire,
		},
	};
}

/**
 * `costMeter` 投影を登録する
 * @param ctx - 投影レジストリを持つコンテキスト
 * @param config - 行の `config` 検証済みの設定
 */
export function apply(ctx: Context, config: CostConfig): void {
	const settings: CostSettings = {
		symbol: config?.symbol ?? "$",
		rates: config?.rates ?? {},
		...(config?.fallback === undefined ? {} : { fallback: config.fallback }),
	};
	ctx.sessionProjections.register(costMeterProjection(settings));
}
