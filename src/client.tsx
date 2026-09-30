/**
 * ブラウザ側の本体
 *
 * シェルの統計ピルと同じ行へピルを1つ足す 金額はホスト側のセッション投影
 * `costMeter` が持つ値だけで 単価はここでは扱わない 見た目と操作もシェルの
 * 統計ピルに合わせ 押すと内訳のパネルが開く
 */

import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-client-ui-conversation/client";
import {
	useAnchoredPosition,
	useDismissOnOutsidePointer,
} from "@deepseek-ai/dsh-client-ui-primitives";
import type {} from "@deepseek-ai/dsh-client-ui-renderer/client";
import type {} from "@deepseek-ai/dsh-client-ui-session/client";
import type { PropsRuntime } from "@deepseek-ai/dsh-client-ui-slots";
import {
	type CSSProperties,
	Fragment,
	useEffect,
	useRef,
	useState,
} from "react";
import { createPortal } from "react-dom";
import {
	breakdownRows,
	type CostMeterView,
	formatAmount,
	PROJECTION_KEY,
} from "./shared";

/**
 * ピルを置くドック
 *
 * シェルの統計ピルが並ぶ行と同じ場所 リスト枠なので追加できる
 */
const DOCK = "conversation.composer.dock";

/**
 * 統計ピルが並ぶ行の目印
 *
 * シェルが統計ピルの行に付ける属性 同じ行へ並ぶための描画先に使う
 */
const STATS_ROW_SELECTOR = "[data-composer-stats]";

/**
 * ピルの登録 id
 */
const PILL_ID = "cost";

/**
 * 内訳パネルの見出し
 *
 * シェルの統計ピルは i18n の席を通るが このプラグインは席を持たない
 */
const PANEL_TITLE = "Cost";

/**
 * パネルと引き金の間隔
 *
 * シェルの統計ピルのダイアログと同じ値に揃える
 */
const PANEL_GAP = 8;

/**
 * パネルと画面端の間隔
 */
const PANEL_MARGIN = 12;

/**
 * 位置が決まる前のパネル
 *
 * 見えないまま寸法だけ測らせ 計測が終わると座標へ差し替わる
 */
const MEASURE_STYLE: CSSProperties = {
	visibility: "hidden",
	left: 0,
	top: 0,
};

/**
 * ピルとパネルの見た目
 *
 * シェルの統計ピルと内訳ダイアログの CSS Modules は外から読めないため 同じ
 * トークンと同じ宣言を自前の class で持つ 統計ピルの行が無いときだけ 行の
 * 組み方も同じ値で自前に行を描く
 *
 * `--dsw-specific-menu` は不透明ではなく `#303136f0` のような薄い面なので
 * `--dsw-menu-backdrop-filter` と必ず組で使う これが無いと背後がぼけず
 * 透けた本文がそのまま読めてしまう 角丸も組み込みの面と同じ `--dsw-radius-lg` を使う
 */
const STYLE = `
.dsh-ui-cost-meter{max-width:var(--dsh-chat-content-width);box-sizing:border-box;width:100%;padding:4px calc(var(--dsh-composer-side-clearance) + 16px) 0px;font-size:var(--dsh-content-font-size-secondary,13px);line-height:calc(20px + var(--dsh-content-font-delta-secondary,0px));justify-content:center;gap:12px;margin:0 auto;display:flex}
.dsh-ui-cost-meter-anchor{min-width:0;display:inline-flex}
.dsh-ui-cost-meter-pill{box-sizing:border-box;max-width:100%;color:var(--dsw-alias-label-tertiary);font:inherit;font-variant-numeric:tabular-nums;line-height:inherit;white-space:nowrap;background:0 0;border:none;border-radius:24px;align-items:center;gap:6px;padding:1px 8px;display:inline-flex}
.dsh-ui-cost-meter-symbol{flex:none;width:14px;height:14px;display:inline-flex;align-items:center;justify-content:center;font-size:12px;font-weight:600}
button.dsh-ui-cost-meter-pill{cursor:pointer}
button.dsh-ui-cost-meter-pill:hover,button.dsh-ui-cost-meter-pill[aria-expanded=true]{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}
.dsh-ui-cost-meter-label{text-overflow:ellipsis;min-width:0;overflow:hidden}
.dsh-ui-cost-meter-unpriced{margin-left:1px;font-size:11px}
.dsh-ui-cost-meter-panel{z-index:1100;box-sizing:border-box;background:var(--dsw-specific-menu);backdrop-filter:var(--dsw-menu-backdrop-filter);--dsw-elevation-stroke-color:var(--dsw-alias-border-l1);width:max-content;min-width:min(300px,100vw - 24px);max-width:min(440px,100vw - 24px);box-shadow:var(--dsw-elevation-prominent);color:var(--dsw-alias-label-secondary);cursor:default;border:0;border-radius:var(--dsw-radius-lg);padding:16px;font-size:12px;line-height:18px;position:fixed}
.dsh-ui-cost-meter-title{color:var(--dsw-alias-label-primary);justify-content:space-between;gap:16px;margin-bottom:8px;font-weight:500;display:flex}
.dsh-ui-cost-meter-titleRule{border-top:.5px solid var(--dsw-alias-border-l2);margin-bottom:10px}
.dsh-ui-cost-meter-titleValue{font-variant-numeric:tabular-nums}
.dsh-ui-cost-meter-titleLabel{align-items:center;gap:6px;min-width:0;display:inline-flex}
.dsh-ui-cost-meter-details{color:var(--dsw-alias-label-tertiary);grid-template-columns:minmax(76px,auto) minmax(0,1fr);gap:6px 16px;margin:0;display:grid}
.dsh-ui-cost-meter-details dt,.dsh-ui-cost-meter-details dd{min-width:0;margin:0}
.dsh-ui-cost-meter-details dd{color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;text-align:right}
.dsh-ui-cost-meter-route{overflow-wrap:anywhere}
`;

/**
 * スタイルタグの識別子
 */
const STYLE_TAG_ID = "dsh-ui-cost-meter/style.css";

/**
 * ピルが受け取る props
 *
 * セッション枠の標準 props から投影の読み口だけを使う
 */
type CostPillProps = PropsRuntime<typeof DOCK>;

/**
 * このプラグインが待つサービス
 *
 * 枠組みへの登録口そのものなので 無い構成では起動しない
 */
export const inject = ["slots"];

/**
 * 統計ピルの行を探して追う
 *
 * ドック内に置く目印から親をたどり その中に現れる行を描画先にする 行は
 * セッションの切り替えで作り直されるため 出入りを監視して追随する
 * @returns 目印の ref と 見つかった行 まだ無ければ null
 */
function useStatsRow(): {
	anchorRef: React.RefObject<HTMLSpanElement | null>;
	row: HTMLElement | null;
} {
	const anchorRef = useRef<HTMLSpanElement | null>(null);
	const [row, setRow] = useState<HTMLElement | null>(null);
	useEffect(() => {
		const container = anchorRef.current?.parentElement;
		if (container === undefined || container === null) return;
		const sync = () => {
			setRow((current) => {
				const next = container.querySelector<HTMLElement>(STATS_ROW_SELECTOR);
				return current === next ? current : next;
			});
		};
		sync();
		const observer = new MutationObserver(sync);
		observer.observe(container, { childList: true, subtree: true });
		return () => {
			observer.disconnect();
		};
	}, []);
	return { anchorRef, row };
}

/**
 * 内訳パネルの開閉と位置
 *
 * シェルの統計ピルと同じく引き金の上へ出し 外側への押下と Escape で閉じる
 * @returns 開閉の状態 引き金とパネルの ref と パネルの位置
 */
function useCostDialog() {
	const [open, setOpen] = useState(false);
	const rootRef = useRef<HTMLSpanElement | null>(null);
	const panelRef = useRef<HTMLDivElement | null>(null);
	const pos = useAnchoredPosition({
		open,
		anchorRef: rootRef,
		panelRef,
		side: "top",
		gap: PANEL_GAP,
		margin: PANEL_MARGIN,
	});
	useDismissOnOutsidePointer(rootRef, open, setOpen, panelRef);
	useEffect(() => {
		if (!open) return;
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape") setOpen(false);
		};
		document.addEventListener("keydown", onKeyDown);
		return () => {
			document.removeEventListener("keydown", onKeyDown);
		};
	}, [open]);
	return { open, setOpen, rootRef, panelRef, pos };
}

/**
 * 金額そのものを出すピル
 *
 * 押すと内訳のパネルが開く パネルの骨組みはシェルの統計ピルと同じで 見出しと
 * 罫線の下に 見出しと値の組みを並べる
 * @param props - 表示する金額
 * @returns 引き金と 開いているときのパネル
 */
function CostPillBody({ view }: { view: CostMeterView }) {
	const { open, setOpen, rootRef, panelRef, pos } = useCostDialog();
	const amount = `${view.symbol}${formatAmount(view.total)}`;
	return (
		<span ref={rootRef} className="dsh-ui-cost-meter-anchor">
			<button
				type="button"
				className="dsh-ui-cost-meter-pill"
				aria-haspopup="dialog"
				aria-expanded={open}
				aria-label={`${PANEL_TITLE} ${amount}${view.unpricedTokens > 0 ? "+" : ""}`}
				onClick={() => {
					setOpen(!open);
				}}
			>
				<span className="dsh-ui-cost-meter-symbol" aria-hidden>
					{view.symbol}
				</span>
				<span className="dsh-ui-cost-meter-label">
					{formatAmount(view.total)}
				</span>
				{view.unpricedTokens > 0 && (
					<span className="dsh-ui-cost-meter-unpriced" aria-hidden>
						+
					</span>
				)}
			</button>
			{open &&
				createPortal(
					<div
						ref={panelRef}
						className="dsh-ui-cost-meter-panel"
						role="dialog"
						aria-label={PANEL_TITLE}
						style={pos ?? MEASURE_STYLE}
					>
						<div className="dsh-ui-cost-meter-title">
							<span className="dsh-ui-cost-meter-titleLabel">
								<span className="dsh-ui-cost-meter-symbol" aria-hidden>
									{view.symbol}
								</span>
								{PANEL_TITLE}
							</span>
							<span className="dsh-ui-cost-meter-titleValue">{amount}</span>
						</div>
						<div className="dsh-ui-cost-meter-titleRule" aria-hidden />
						<dl className="dsh-ui-cost-meter-details" data-cost-meter-details>
							{breakdownRows(view).map((row) => (
								<Fragment key={row.label}>
									<dt>{row.label}</dt>
									<dd
										className={
											row.route === true ? "dsh-ui-cost-meter-route" : undefined
										}
									>
										{row.value}
									</dd>
								</Fragment>
							))}
						</dl>
					</div>,
					document.body,
				)}
		</span>
	);
}

/**
 * 今のセッションの累計金額を出すピル
 *
 * 統計ピルの行があればその中へ並べ 無ければ自前の行として描く
 * @param props - ドックが配る標準 props
 * @returns ピル 表示する金額が無ければ何も描かない
 */
function CostPill({ useProjection }: CostPillProps) {
	const view = useProjection(PROJECTION_KEY);
	const { anchorRef, row } = useStatsRow();
	const body =
		view === undefined || view.tokens === 0 ? null : (
			<CostPillBody view={view} />
		);
	return (
		<>
			<span ref={anchorRef} hidden />
			{body !== null &&
				(row === null ? (
					<div className="dsh-ui-cost-meter">{body}</div>
				) : (
					createPortal(body, row)
				))}
		</>
	);
}

/**
 * 見た目のスタイルタグを document へ入れる
 * @returns 取り除く関数
 */
function installStyle(): () => void {
	const existing = document.getElementById(STYLE_TAG_ID);
	if (existing !== null) return () => undefined;
	const style = document.createElement("style");
	style.id = STYLE_TAG_ID;
	style.textContent = STYLE;
	document.head.append(style);
	return () => {
		style.remove();
	};
}

/**
 * 統計ドックへピルを登録する
 * @param ctx - クライアント側 cordis コンテキスト
 */
export function apply(ctx: Context): void {
	ctx.effect(installStyle, "cost-meter: pill style");
	// ドックが生まれるたびに登録し ドックが畳まれると一緒に消える
	ctx.slots.inject(DOCK, () =>
		ctx.slots.register(
			{
				name: DOCK,
				id: PILL_ID,
				// 統計ピル(order 0)の後ろへ並べる
				order: 10,
			},
			CostPill,
		),
	);
}
