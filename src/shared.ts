/**
 * ホスト側とブラウザ側で共有する定義
 *
 * ここには値と純粋関数だけを置く ブラウザ側のバンドルはプラットフォーム
 * モジュールしか実行時に解決できないため 共有できるのは型と定数と副作用の
 * 無い変換に限られる
 */

/**
 * セッション投影のキー
 *
 * クライアントはこの名前で `useProjection` を引く
 */
export const PROJECTION_KEY = "costMeter";

/**
 * 100万トークンあたりの単価
 *
 * 通貨は `CostSettings.symbol` が示すものに揃える
 */
export interface Rates {
	readonly input: number;
	readonly output: number;
	readonly cacheRead: number;
	readonly cacheWrite: number;
}

/**
 * 1回のモデル呼び出しの課金対象トークン数
 *
 * 入力側の3つは互いに素で 合計が課金対象の入力になる
 */
export interface Buckets {
	readonly uncachedInput: number;
	readonly output: number;
	readonly cacheRead: number;
	readonly cacheWrite: number;
}

/**
 * 単価で値付けした金額の内訳
 */
export interface CostParts {
	readonly input: number;
	readonly output: number;
	readonly cacheRead: number;
	readonly cacheWrite: number;
}

/**
 * プラグインの設定
 *
 * 行の `config` に書く 単価はすべて100万トークンあたり
 */
export interface CostSettings {
	/** 金額の前に付ける記号 */
	readonly symbol: string;
	/** `"<provider>/<model>"` か `"<model>"` を key にした単価表 */
	readonly rates: Readonly<Record<string, Rates>>;
	/**
	 * どの key にも一致しない route に使う単価 省略時は値付けしない
	 *
	 * 解決済みの設定は key ごと欠けるため 明示的な `undefined` も省略と同じに扱う
	 */
	readonly fallback?: Rates | undefined;
}

/**
 * 値付けの結果 クライアントが読む唯一の形
 *
 * すべて耐久ログ全体の集計で ページングや圧縮の影響を受けない
 */
export interface CostMeterView {
	/** 金額の前に付ける記号 */
	readonly symbol: string;
	/** 金額の合計 */
	readonly total: number;
	/** 入力トークンの金額 */
	readonly input: number;
	/** 出力トークンの金額 */
	readonly output: number;
	/** キャッシュ読みの金額 */
	readonly cacheRead: number;
	/** キャッシュ書きの金額 */
	readonly cacheWrite: number;
	/** 値付けしたトークン数 入力側3つと出力の合計 */
	readonly tokens: number;
	/** 単価が見つからず金額に入らなかったトークン数 */
	readonly unpricedTokens: number;
	/** 直近のリクエストが使った provider route */
	readonly provider: string | null;
	/** 直近のリクエストが使った model id */
	readonly model: string | null;
}

declare module "@deepseek-ai/dsh-session-projection/types" {
	interface SessionProjectionMap {
		/** 耐久ログ全体の累計金額 設定の単価で値付けしたもの */
		costMeter: CostMeterView;
	}
}

/**
 * すべての内訳が0の値
 */
export const ZERO_PARTS: CostParts = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
};

/**
 * 数値として使えるかを確かめて取り出す
 * @param value - 確かめる値
 * @returns 有限の非負数ならその値 そうでなければ undefined
 */
function readCount(value: unknown): number | undefined {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0)
		return undefined;
	return value;
}

/**
 * オブジェクトから名前で1つの値を読む
 *
 * 総称的な辞書として断定せず 名前を照合して取り出す
 * @param value - 読む元の値
 * @param key - 読む名前
 * @returns 入っていればその値 無ければ undefined
 */
function readField(value: object, key: string): unknown {
	for (const [name, field] of Object.entries(value)) {
		if (name === key) return field;
	}
	return undefined;
}

/**
 * 耐久イベントの usage をバケットへ写す
 *
 * 入力と出力が揃っているときだけ成立する キャッシュの2つは未報告を0として扱う
 * @param usage - `assistant/message` か `assistant/attempt` が持つ usage
 * @returns 写したバケット 形が違えば undefined
 */
export function bucketsFromUsage(usage: unknown): Buckets | undefined {
	if (typeof usage !== "object" || usage === null) return undefined;
	const uncachedInput = readCount(readField(usage, "inputTokens"));
	const output = readCount(readField(usage, "outputTokens"));
	if (uncachedInput === undefined || output === undefined) return undefined;
	return {
		uncachedInput,
		output,
		cacheRead: readCount(readField(usage, "cacheReadTokens")) ?? 0,
		cacheWrite: readCount(readField(usage, "cacheWriteTokens")) ?? 0,
	};
}

/**
 * 2つのバケットが同じかを確かめる
 *
 * 同じ標本の再報告で集計を動かさないための門になる
 * @param left - 比べる側
 * @param right - 比べられる側
 * @returns 4つすべてが一致すれば true
 */
export function bucketsEqual(left: Buckets, right: Buckets): boolean {
	return (
		left.uncachedInput === right.uncachedInput &&
		left.output === right.output &&
		left.cacheRead === right.cacheRead &&
		left.cacheWrite === right.cacheWrite
	);
}

/**
 * 課金対象のトークン数を合計する
 * @param buckets - 合計するバケット
 * @returns 入力側3つと出力の合計
 */
export function tokenTotal(buckets: Buckets): number {
	return (
		buckets.uncachedInput +
		buckets.output +
		buckets.cacheRead +
		buckets.cacheWrite
	);
}

/**
 * route の単価を料金表から引く
 *
 * `"<provider>/<model>"` が最も強く 次に `"<model>"` 最後に `fallback` を見る
 * @param settings - 単価表を持つ設定
 * @param provider - リクエストの provider route
 * @param model - リクエストの model id
 * @returns 見つかった単価 無ければ undefined
 */
export function resolveRates(
	settings: CostSettings,
	provider: string | null,
	model: string | null,
): Rates | undefined {
	const rates = settings.rates;
	if (model !== null) {
		if (provider !== null) {
			const routed = rates[`${provider}/${model}`];
			if (routed !== undefined) return routed;
		}
		const bare = rates[model];
		if (bare !== undefined) return bare;
	}
	return settings.fallback;
}

/**
 * バケットを単価で値付けする
 * @param buckets - 値付けするトークン数
 * @param rates - 適用する単価 未設定なら undefined
 * @returns 金額の内訳 単価が無ければ undefined
 */
export function priceBuckets(
	buckets: Buckets,
	rates: Rates | undefined,
): CostParts | undefined {
	if (rates === undefined) return undefined;
	return {
		input: perMillion(buckets.uncachedInput, rates.input),
		output: perMillion(buckets.output, rates.output),
		cacheRead: perMillion(buckets.cacheRead, rates.cacheRead),
		cacheWrite: perMillion(buckets.cacheWrite, rates.cacheWrite),
	};
}

/**
 * 単価とトークン数から金額を出す
 * @param tokens - トークン数
 * @param rate - 100万トークンあたりの単価
 * @returns 金額
 */
function perMillion(tokens: number, rate: number): number {
	return (tokens / 1_000_000) * rate;
}

/**
 * 内訳を足す
 * @param left - 足す側
 * @param right - 足される側
 * @returns 足した内訳
 */
export function addParts(left: CostParts, right: CostParts): CostParts {
	return {
		input: left.input + right.input,
		output: left.output + right.output,
		cacheRead: left.cacheRead + right.cacheRead,
		cacheWrite: left.cacheWrite + right.cacheWrite,
	};
}

/**
 * 内訳を引く
 *
 * 同じステップの標本が差し替わるとき 前に足した金額をそのまま取り消すために使う
 * @param left - 引かれる側
 * @param right - 引く側
 * @returns 引いた内訳
 */
export function subtractParts(left: CostParts, right: CostParts): CostParts {
	return {
		input: left.input - right.input,
		output: left.output - right.output,
		cacheRead: left.cacheRead - right.cacheRead,
		cacheWrite: left.cacheWrite - right.cacheWrite,
	};
}

/**
 * 内訳の合計を出す
 * @param parts - 合計する内訳
 * @returns 金額の合計
 */
export function totalOf(parts: CostParts): number {
	return parts.input + parts.output + parts.cacheRead + parts.cacheWrite;
}

/**
 * 金額を出す小数点以下の桁を選ぶ
 *
 * 桁は金額の大きさで決める 1を超えるものは銭まで 1未満は意味のある桁が残るまで
 * 細かく見る
 * @param value - 桁を決める金額
 * @returns 小数点以下の桁数
 */
export function amountDecimals(value: number): number {
	const safe = Number.isFinite(value) && value > 0 ? value : 0;
	if (safe >= 1) return 2;
	if (safe >= 0.01) return 3;
	return 4;
}

/**
 * 金額を表示用の桁へ丸める
 * @param value - 表示する金額
 * @returns 丸めた数字だけの文字列
 */
export function formatAmount(value: number): string {
	const safe = Number.isFinite(value) && value > 0 ? value : 0;
	return safe.toFixed(amountDecimals(safe));
}

/**
 * トークン数を表示用の短い形へ丸める
 * @param value - 表示するトークン数
 * @returns 1.2M のような短い文字列
 */
export function formatTokens(value: number): string {
	if (!Number.isFinite(value) || value <= 0) return "0";
	if (value >= 1_000_000) return `${trimZero(value / 1_000_000)}M`;
	if (value >= 1_000) return `${trimZero(value / 1_000)}k`;
	return String(Math.round(value));
}

/**
 * 小数第1位が0なら整数へ詰める
 * @param value - 詰める数
 * @returns 表示する文字列
 */
function trimZero(value: number): string {
	const fixed = value >= 100 ? value.toFixed(0) : value.toFixed(1);
	return fixed.endsWith(".0") ? fixed.slice(0, -2) : fixed;
}

/**
 * 内訳パネルに並べる1行
 */
export interface BreakdownRow {
	/** 左に出す見出し */
	readonly label: string;
	/** 右に出す値 */
	readonly value: string;
	/** route 名のように長く 折り返してよい値かどうか */
	readonly route?: boolean;
}

/**
 * 内訳パネルに並べる行を作る
 *
 * 見出しはシェルのトークン内訳と同じ語を使い 値は金額にする 列に並ぶため桁は
 * 合計の桁へ揃える 0のキャッシュ書きはシェルと同じく省き 未設定トークンと
 * route は分かるときだけ足す
 * @param view - 今の金額
 * @returns 上から並べる行
 */
export function breakdownRows(view: CostMeterView): BreakdownRow[] {
	const decimals = amountDecimals(view.total);
	const money = (value: number): string =>
		`${view.symbol}${(Number.isFinite(value) && value > 0 ? value : 0).toFixed(decimals)}`;
	const rows: BreakdownRow[] = [
		{ label: "Uncached input", value: money(view.input) },
		{ label: "Cached input", value: money(view.cacheRead) },
	];
	if (view.cacheWrite > 0)
		rows.push({ label: "Cache write", value: money(view.cacheWrite) });
	rows.push({ label: "Output", value: money(view.output) });
	if (view.unpricedTokens > 0)
		rows.push({
			label: "Unpriced",
			value: `${formatTokens(view.unpricedTokens)} tok`,
		});
	const route =
		view.provider === null ? view.model : `${view.provider}/${view.model}`;
	if (route !== null)
		rows.push({ label: "Provider / model", value: route, route: true });
	return rows;
}
