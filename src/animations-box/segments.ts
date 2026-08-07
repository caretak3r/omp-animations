/**
 * Animations Box — segment sources.
 *
 * One pure builder per box-owned animation, each producing a {@link
 * SegmentSample}: the simple-mode `variants` ladder (fed straight into the
 * kit's `composeSegments`) plus the detailed-mode column fields, both derived
 * from that animation's own exported pure renderers/state — never reinvented
 * text. Only Cache Meter is wired in this bead (`oh-my-pi-dxi.2`); the
 * remaining six keepers land in `dxi.3`/`dxi.4`/`dxi.5`.
 *
 * `active` mirrors the animation's own real mount policy (quiet until the
 * first usable event, mirroring `CacheMeterController`'s lazy mount), but
 * unlike the standalone widget's absence, an inactive segment here still
 * produces a `detail` — a dim resting row (`glyph · label · "—"`) — so
 * detailed-mode height is a pure function of the ENABLED set, never of
 * runtime activity (Plan 017 Decision 5).
 *
 * `now` is always a wall-clock reading from the box's own `FrameScheduler`,
 * never the host `AnimatedWidget`'s mount-relative `elapsedMs` (Decision 4).
 */
import type { Theme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { formatNumber } from "@oh-my-pi/pi-utils";
import {
	BADGE_GLYPH,
	CACHE_METER_COLORS,
	type CacheMeterColors,
	type CacheMeterState,
	renderCacheMeterRow,
} from "../cache-meter";
import { BOX_SEGMENT_IDS, type BoxSegmentId } from "./settings";

/** The slice of {@link Theme} every segment builder needs — just foreground coloring. */
export type BoxTheme = Pick<Theme, "fg">;

/** One column's worth of detailed-mode text — always plain, colored last by the segment builder itself (the widget does no coloring of its own). */
export interface SegmentDetail {
	readonly glyph: string;
	readonly label: string;
	readonly primary: string;
	readonly secondary: string;
	readonly trailing: string;
}

/** What one segment contributes this frame, in both box detail levels. */
export interface SegmentSample {
	readonly id: BoxSegmentId;
	readonly priority: number;
	/** Whether this segment currently has real content to show. Gates `composeSegments` participation (simple mode) only — `variants` is empty when `false`, so an idle segment contributes nothing to that one composed row. */
	readonly active: boolean;
	/** Widest-first, for `composeSegments`. Empty when `!active`. */
	readonly variants: readonly string[];
	/** Column fields for detailed mode — always populated, even when `!active` (a resting row, not an absence; see the module doc). */
	readonly detail: SegmentDetail;
}

const INACTIVE = { active: false as const, variants: [] as const };

/** Priority order derives from `BOX_SEGMENT_IDS` so it can never drift from the settings module's own list. */
function priorityOf(id: BoxSegmentId): number {
	return BOX_SEGMENT_IDS.indexOf(id) + 1;
}

function dedupe(variants: readonly string[]): readonly string[] {
	const out: string[] = [];
	for (const v of variants) if (out.at(-1) !== v) out.push(v);
	return out;
}

/** `<$0.01`/`$1.24`-style USD formatting — a local copy of `cache-meter/widget.ts`'s module-private `formatCost` (not exported from that module's barrel). */
function formatCost(amountUsd: number): string {
	const safe = Number.isFinite(amountUsd) && amountUsd > 0 ? amountUsd : 0;
	if (safe === 0) return "$0.00";
	return safe < 0.01 ? "<$0.01" : `$${safe.toFixed(2)}`;
}

/**
 * Cache Meter segment. A dim resting row until `message_end` has delivered at
 * least one usable prompt-cache sample — mirrors `CacheMeterController`'s own
 * lazy mount ("nothing to show before the first metered request lands").
 * Unlike the standalone `CacheMeterWidget`, this segment never eases the
 * displayed percentage or blinks the invalidation badge — both live inside
 * that widget's own per-frame state, which this box does not reuse (see
 * `controller.ts`'s module doc) — so it always draws the snapshot's true
 * current `warmth`, unalerted.
 */
export function buildCacheMeterSegment(
	state: CacheMeterState,
	now: number,
	theme: BoxTheme,
	colors: CacheMeterColors = CACHE_METER_COLORS,
): SegmentSample {
	const priority = priorityOf("cacheMeter");
	const snapshot = state.snapshot();
	if (snapshot.promptTokens === 0) {
		return {
			id: "cacheMeter",
			priority,
			...INACTIVE,
			detail: { glyph: theme.fg("dim", BADGE_GLYPH), label: "cache", primary: "—", secondary: "", trailing: "" },
		};
	}

	const variants = dedupe(
		[999, 40, 18, 3].map(width =>
			renderCacheMeterRow(snapshot, width, now, theme, "subtle", snapshot.warmth, false, colors),
		),
	);
	const pct = `${(snapshot.warmth * 100).toFixed(1)}%`;
	return {
		id: "cacheMeter",
		priority,
		active: true,
		variants,
		detail: {
			glyph: theme.fg(colors.badge, BADGE_GLYPH),
			label: "cache",
			primary: pct,
			secondary:
				snapshot.savedCost !== undefined
					? `saved ${formatCost(snapshot.savedCost)}`
					: `${snapshot.hitCount}/${snapshot.requestCount}`,
			trailing: `r ${formatNumber(snapshot.cacheReadTokens)} · w ${formatNumber(snapshot.cacheWriteTokens)}`,
		},
	};
}
