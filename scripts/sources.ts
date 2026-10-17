/**
 * 上流のカタログから単価を読む
 *
 * 生成スクリプトだけが使う 単価表は provider が実際に配る id にだけ載せる
 * 配らない id の単価を持っても値付けには使われない
 */

import type { Rates } from "../src/shared";

/** OpenCode 自身が配るカタログ 単価と id がここに揃っている */
const MODELS_DEV = "https://models.dev/api.json";

/** models.dev の provider id をそのまま単価表の key に使う */
const OPENCODE_PROVIDERS = ["opencode-go", "opencode"] as const;

/** provider が実際に配る id の一覧 カタログに載っていても配らない id は落とす */
const OPENCODE_MODEL_LISTS: Readonly<Record<OpenCodeProvider, string>> = {
	"opencode-go": "https://opencode.ai/zen/go/v1/models",
	opencode: "https://opencode.ai/zen/v1/models",
};

/** Command Code の API が配る id の一覧 */
const COMMAND_CODE_MODEL_LIST = "https://api.commandcode.ai/provider/v1/models";

/** Command Code のモデルページの索引 */
const COMMAND_CODE_INDEX = "https://commandcode.ai/models";

/** Command Code の provider 名 */
const COMMAND_CODE_PROVIDER = "command-code";

type OpenCodeProvider = (typeof OPENCODE_PROVIDERS)[number];

/** 単価の分かった1つの route */
export interface RateEntry {
	/** DSH の route 名になる provider */
	readonly provider: string;
	/** provider が配る model id */
	readonly id: string;
	/** 100万トークンあたりの単価 */
	readonly rates: Rates;
}

/**
 * URL を取得して本文を返す
 * @param url - 取得する URL
 * @returns 本文
 */
async function getText(url: string): Promise<string> {
	const response = await fetch(url, {
		headers: { "user-agent": "dsh-ui-cost-meter-rates/1.0" },
	});
	if (!response.ok) {
		throw new Error(`${url} が ${response.status} を返した`);
	}
	return await response.text();
}

/**
 * URL を取得して JSON として読む
 * @param url - 取得する URL
 * @returns 読み取った値
 */
async function getJson(url: string): Promise<unknown> {
	return JSON.parse(await getText(url));
}

/**
 * OpenAI 互換の id 一覧を読む
 * @param value - `{ data: [{ id }] }` の形の値
 * @returns 並んでいる id
 */
function idsOf(value: unknown): string[] {
	const data = (value as { data?: readonly { id?: unknown }[] }).data;
	if (!Array.isArray(data)) {
		throw new Error("id 一覧の形が違う");
	}
	return data.map((entry) => {
		if (typeof entry?.id !== "string") {
			throw new Error("id が文字列でない");
		}
		return entry.id;
	});
}

/**
 * 単価を検証して取り出す
 * @param cost - models.dev の cost
 * @returns 100万トークンあたりの単価
 */
function ratesOf(cost: unknown): Rates {
	const read = (name: string): number => {
		const value = (cost as Record<string, unknown> | undefined)?.[name];
		return typeof value === "number" && Number.isFinite(value) ? value : 0;
	};
	return {
		input: read("input"),
		output: read("output"),
		cacheRead: read("cache_read"),
		cacheWrite: read("cache_write"),
	};
}

/**
 * モデルページから単価を読む
 *
 * ページは Input と Output と Cache read を1Mトークンあたりの金額で刷る
 * キャッシュ書きの欄は無い
 * @param html - ページの HTML
 * @returns 読めた単価 欄が無ければ undefined
 */
function parseModelPage(html: string): Rates | undefined {
	const tile = (label: string): number | undefined => {
		const pattern = new RegExp(
			`aria-label="${label} — Price per 1M[^"]*"[\\s\\S]{0,1200}?tabular-nums">\\$([\\d.,]+)`,
		);
		const value = html.match(pattern)?.[1];
		if (value === undefined) {
			return undefined;
		}
		const parsed = Number(value.replace(/,/g, ""));
		return Number.isFinite(parsed) ? parsed : undefined;
	};
	const input = tile("Input");
	const output = tile("Output");
	if (input === undefined || output === undefined) {
		return undefined;
	}
	return {
		input,
		output,
		cacheRead: tile("Cache read") ?? 0,
		cacheWrite: tile("Cache write") ?? 0,
	};
}

/**
 * モデルページが名乗る id を API が配る id へ寄せる
 *
 * ページは日付の付かない短い id を名乗ることがある その場合は前方一致で
 * 一意に決まるときだけ寄せる 決まらないものは推測せず落とす
 * @param served - API が配る id
 * @param canonical - 小文字にした id から API の表記への対応
 * @param pageId - ページが名乗る id
 * @returns API の表記の id 決まらなければ undefined
 */
function serveId(
	served: readonly string[],
	canonical: ReadonlyMap<string, string>,
	pageId: string,
): string | undefined {
	const exact = canonical.get(pageId.toLowerCase());
	if (exact !== undefined) {
		return exact;
	}
	const prefixed = served.filter((id) =>
		id.toLowerCase().startsWith(pageId.toLowerCase()),
	);
	return prefixed.length === 1 ? prefixed[0] : undefined;
}

/**
 * 並列数を限って順に処理する
 * @param items - 処理する値
 * @param limit - 同時に走らせる数
 * @param run - 1つ分の処理
 * @returns 入力と同じ順の結果
 */
async function mapLimit<T, R>(
	items: readonly T[],
	limit: number,
	run: (item: T) => Promise<R>,
): Promise<R[]> {
	const results = new Array<R>(items.length);
	let next = 0;
	await Promise.all(
		Array.from({ length: Math.min(limit, items.length) }, async () => {
			for (;;) {
				const index = next;
				next += 1;
				if (index >= items.length) {
					return;
				}
				results[index] = await run(items[index] as T);
			}
		}),
	);
	return results;
}

/**
 * OpenCode Go と OpenCode Zen の単価を読む
 * @returns 単価の分かった route
 */
async function openCodeRates(): Promise<RateEntry[]> {
	const catalog = (await getJson(MODELS_DEV)) as Record<
		string,
		{ models?: Record<string, { cost?: unknown }> } | undefined
	>;
	const entries: RateEntry[] = [];
	for (const provider of OPENCODE_PROVIDERS) {
		const served = idsOf(await getJson(OPENCODE_MODEL_LISTS[provider]));
		const models = catalog[provider]?.models ?? {};
		const unpriced: string[] = [];
		for (const id of served) {
			const cost = models[id]?.cost;
			if (cost === undefined) {
				unpriced.push(id);
				continue;
			}
			entries.push({ provider, id, rates: ratesOf(cost) });
		}
		if (unpriced.length > 0) {
			console.warn(
				`${provider}: 単価を公表していない id を飛ばした: ${unpriced.join(", ")}`,
			);
		}
	}
	return entries;
}

/**
 * Command Code の単価を読む
 *
 * 単価はモデルページにしか無い 索引に並ぶページを1つずつ読み ページが
 * 名乗る id を API が配る id へ寄せる
 * @returns 単価の分かった route
 */
async function commandCodeRates(): Promise<RateEntry[]> {
	const served = idsOf(await getJson(COMMAND_CODE_MODEL_LIST));
	const canonical = new Map(served.map((id) => [id.toLowerCase(), id]));
	const index = await getText(COMMAND_CODE_INDEX);
	const slugs = [
		...new Set(
			[...index.matchAll(/href="\/models\/([a-z0-9.-]+)"/g)].map(
				(match) => match[1] as string,
			),
		),
	];
	const pages = await mapLimit(slugs, 6, async (slug) => {
		const html = await getText(`https://commandcode.ai/models/${slug}`);
		const rates = parseModelPage(html);
		const found = html.match(/cmd --model ([\w.\-/:]+)/);
		return rates === undefined || found?.[1] === undefined
			? undefined
			: { id: found[1], rates };
	});
	const entries = new Map<string, RateEntry>();
	const unknown: string[] = [];
	for (const page of pages) {
		if (page === undefined) {
			continue;
		}
		const id = serveId(served, canonical, page.id);
		if (id === undefined) {
			unknown.push(page.id);
			continue;
		}
		entries.set(id, { provider: COMMAND_CODE_PROVIDER, id, rates: page.rates });
	}
	const missing = served.filter((id) => !entries.has(id));
	if (missing.length > 0) {
		console.warn(
			`${COMMAND_CODE_PROVIDER}: 単価を公表していない id を飛ばした: ${missing.join(", ")}`,
		);
	}
	if (unknown.length > 0) {
		console.warn(
			`${COMMAND_CODE_PROVIDER}: API が配らない id を飛ばした: ${unknown.join(", ")}`,
		);
	}
	return [...entries.values()];
}

/**
 * 3つの provider の単価をまとめて読む
 * @returns 単価の分かった route
 */
export async function rateEntries(): Promise<RateEntry[]> {
	const [openCode, commandCode] = await Promise.all([
		openCodeRates(),
		commandCodeRates(),
	]);
	return [...openCode, ...commandCode];
}
