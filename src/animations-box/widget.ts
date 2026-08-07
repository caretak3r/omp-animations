/**
 * Animations Box — the bordered widget itself.
 *
 * ONE widget hosting the enabled keeper segments as composed content instead
 * of one ambient row per animation. The border costs 2 rows (top/bottom) and
 * 4 columns of inner width (`"│ "` + `" │"`), so every content line is built
 * to `width - 4` and then padded/truncated back out to exactly `width` (Plan
 * 017 Decision 5).
 *
 * `simple` draws one composed row via the kit's `composeSegments`, built only
 * from the segments that are currently `active`; an idle segment simply
 * contributes nothing to that row (its `variants` are empty). `detailed`
 * draws one fixed-column row per ENABLED segment regardless of `active` — an
 * idle segment renders its own dim resting row (`glyph · label · "—"`, built
 * by the segment source, not this widget) instead of being absent, so height
 * in detailed mode is a pure function of the enabled set and never jitters
 * with runtime activity. This is the one behavior this class does NOT inherit
 * unchanged from the `/tmp/anim-livebox` Phase-1 prototype, whose
 * `renderFrame` dropped every inactive segment (and returned nothing at all
 * when none were active) — Decision 5 supersedes that. Both modes remain pure
 * functions of `buildSamples(now)`'s output; this class holds no
 * segment-specific business logic of its own.
 */
import { truncateToWidth, visibleWidth } from "@oh-my-pi/pi-tui";
import type { AnimatedWidgetOptions, FrameScheduler } from "../kit";
import { AnimatedWidget, composeSegments, segment as toKitSegment } from "../kit";
import type { BoxTheme, SegmentDetail, SegmentSample } from "./segments";
import type { BoxDetail } from "./settings";

const BORDER_COLS = 4;
const BORDER_ROWS = 2;

/** Pad/truncate `text` to exactly `width` visible columns — never over, never under. */
function cell(text: string, width: number): string {
	if (width <= 0) return "";
	const truncated = truncateToWidth(text, width);
	const pad = Math.max(0, width - visibleWidth(truncated));
	return truncated + " ".repeat(pad);
}

function borderTop(width: number): string {
	if (width <= 2) return "─".repeat(Math.max(0, width));
	return `╭${"─".repeat(width - 2)}╮`;
}

function borderBottom(width: number): string {
	if (width <= 2) return "─".repeat(Math.max(0, width));
	return `╰${"─".repeat(width - 2)}╯`;
}

/** Wrap one content line in the box's side borders, padded to exactly `width`. */
function contentLine(text: string, inner: number, width: number): string {
	if (width < BORDER_COLS) return cell(text, width);
	return `│ ${cell(text, inner)} │`;
}

/**
 * Fixed-column detail row: glyph · label · primary · secondary · trailing,
 * sized to `inner`. Degrades by truncating the trailing (history) column
 * first, then hard-truncates the whole row as a final safety net so it never
 * overflows `inner` even when the fixed columns alone would.
 */
function detailRowText(detail: SegmentDetail, inner: number): string {
	const cGlyph = 6;
	const cLabel = 8;
	const cPri = 8;
	const cSec = 12;
	const gutters = 4;
	const cTrail = Math.max(0, inner - (cGlyph + cLabel + cPri + cSec + gutters));
	const body = [
		cell(detail.glyph, cGlyph),
		cell(detail.label, cLabel),
		cell(detail.primary, cPri),
		cell(detail.secondary, cSec),
		cell(detail.trailing, cTrail),
	].join(" ");
	return cell(body, inner);
}

export interface AnimationsBoxWidgetOptions extends AnimatedWidgetOptions {
	/** Reserved for the border-breathing accent color (Decision 2, landing in `oh-my-pi-dxi.5`) — the border itself is static/plain until then. */
	theme: BoxTheme;
	/** Same wall clock the controller stamps its own state's timestamps with — NOT the host's mount-relative `elapsedMs` (Decision 4). */
	clock: Pick<FrameScheduler, "now">;
	/** Per-frame state mutation, called once per tick before the next render. No-op until a wired segment needs one (e.g. a settle/ripple timer). */
	onTick: (nowMs: number) => void;
	/** Build this frame's segment samples — one per ENABLED segment, active or resting. Pure given `nowMs`. */
	buildSamples: (nowMs: number) => readonly SegmentSample[];
	/** Live detail level. Re-read every call — the controller updates its backing value on settings changes, not just at construction. */
	getDetail: () => BoxDetail;
}

export class AnimationsBoxWidget extends AnimatedWidget {
	#clock: Pick<FrameScheduler, "now">;
	#onTick: (nowMs: number) => void;
	#buildSamples: (nowMs: number) => readonly SegmentSample[];
	#getDetail: () => BoxDetail;

	constructor(options: AnimationsBoxWidgetOptions) {
		super(options);
		this.#clock = options.clock;
		this.#onTick = options.onTick;
		this.#buildSamples = options.buildSamples;
		this.#getDetail = options.getDetail;
	}

	onFrame(_elapsedMs: number): void {
		this.#onTick(this.#clock.now());
	}

	renderFrame(width: number): readonly string[] {
		if (width <= 0) return [];

		const now = this.#clock.now();
		const samples = this.#buildSamples(now);
		if (samples.length === 0) return [];
		const inner = Math.max(0, width - BORDER_COLS);

		if (this.#getDetail() === "detailed") {
			const rows = samples.map(s => contentLine(detailRowText(s.detail, inner), inner, width));
			return [borderTop(width), ...rows, borderBottom(width)];
		}

		// Simple mode: exactly one composed row, always drawn (even empty) — height
		// stays fixed at 3 regardless of how many of the enabled segments are
		// currently active.
		const activeSegments = samples.filter(s => s.active).map(s => toKitSegment(s.id, s.priority, s.variants));
		const { row } = composeSegments(activeSegments, inner);
		return [borderTop(width), contentLine(row, inner, width), borderBottom(width)];
	}
}

/** Documented row-cost accounting for tests: border rows + one content row (simple) or one per enabled segment (detailed). */
export const BOX_BORDER_ROWS = BORDER_ROWS;
export const BOX_BORDER_COLS = BORDER_COLS;
