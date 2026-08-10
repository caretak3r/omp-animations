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
 *
 * The border chrome itself breathes (Decision 2): every glyph of the top
 * row, bottom row, and side pipes is colored uniformly, per frame, via
 * `#resolveBorderColor` — the live envelope from `getBorderBrightness`
 * bucketed through the breathing-border keeper's own `brightnessToken`
 * classification and this widget's accent-aware palette. `undefined` (motion
 * tier `off`, checked directly against this widget's own `policy`, or
 * `breathingBorder` disabled in config, reported by `getBorderBrightness`
 * itself) falls back to the plain, uncolored chrome — the widget's
 * pre-dxi.5 behavior, unchanged.
 */

import type { ThemeColor } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { truncateToWidth, visibleWidth } from "@oh-my-pi/pi-tui";
import {
	type BorderBrightnessToken,
	type BreathingBorderColors,
	breathingBorderColors,
	brightnessToken,
} from "../breathing-border";
import type { AnimatedWidgetOptions, FrameScheduler, MotionPolicy } from "../kit";
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

/** `color === undefined` is the plain, uncolored fallback — never wraps `theme.fg` at all. */
function colorize(theme: BoxTheme, color: ThemeColor | undefined, text: string): string {
	return color === undefined ? text : theme.fg(color, text);
}

/** Resolve a raw {@link brightnessToken} classification through the configured palette — a local copy of `../breathing-border/widget.ts`'s own private `resolveBorderColor`, not exported from that module's barrel (same "not exported from that barrel" precedent `segments.ts` documents for `formatCost`/`compareVisibleRows`). */
function colorForToken(token: BorderBrightnessToken, colors: BreathingBorderColors): ThemeColor {
	if (token === "borderMuted") return colors.muted;
	if (token === "border") return colors.base;
	return colors.peak;
}

function borderTop(width: number, theme: BoxTheme, color: ThemeColor | undefined): string {
	if (width <= 2) return colorize(theme, color, "─".repeat(Math.max(0, width)));
	return colorize(theme, color, `╭${"─".repeat(width - 2)}╮`);
}

function borderBottom(width: number, theme: BoxTheme, color: ThemeColor | undefined): string {
	if (width <= 2) return colorize(theme, color, "─".repeat(Math.max(0, width)));
	return colorize(theme, color, `╰${"─".repeat(width - 2)}╯`);
}

/** Wrap one content line in the box's side borders, padded to exactly `width`. Only the pipes take the border color — the inner content is colored (or not) by whatever built `text`. */
function contentLine(
	text: string,
	inner: number,
	width: number,
	theme: BoxTheme,
	color: ThemeColor | undefined,
): string {
	if (width < BORDER_COLS) return cell(text, width);
	const pipe = colorize(theme, color, "│");
	return `${pipe} ${cell(text, inner)} ${pipe}`;
}

/**
 * Fixed-column detail row: glyph · label · bar · primary · secondary ·
 * trailing, sized to `inner`. `bar` is a pre-rendered `[##########]` shape
 * (`""` when the segment has no bounded metric — see `SegmentDetail`'s doc)
 * and needs no further coloring here, same as every other column. Degrades
 * by truncating the trailing (history) column first, then hard-truncates the
 * whole row as a final safety net so it never overflows `inner` even when
 * the fixed columns alone would.
 */
function detailRowText(detail: SegmentDetail, inner: number): string {
	const cGlyph = 6;
	const cLabel = 8;
	const cBar = 12;
	const cPri = 8;
	const cSec = 12;
	const gutters = 5;
	const cTrail = Math.max(0, inner - (cGlyph + cLabel + cBar + cPri + cSec + gutters));
	const body = [
		cell(detail.glyph, cGlyph),
		cell(detail.label, cLabel),
		cell(detail.bar, cBar),
		cell(detail.primary, cPri),
		cell(detail.secondary, cSec),
		cell(detail.trailing, cTrail),
	].join(" ");
	return cell(body, inner);
}

export interface AnimationsBoxWidgetOptions extends AnimatedWidgetOptions {
	/** Foreground coloring, for both segment content and the border chrome (Decision 2). */
	theme: BoxTheme;
	/** Same wall clock the controller stamps its own state's timestamps with — NOT the host's mount-relative `elapsedMs` (Decision 4). */
	clock: Pick<FrameScheduler, "now">;
	/** Per-frame state mutation, called once per tick before the next render. No-op until a wired segment needs one (e.g. a settle/ripple timer). */
	onTick: (nowMs: number) => void;
	/** Build this frame's segment samples — one per ENABLED segment, active or resting. Pure given `nowMs`. */
	buildSamples: (nowMs: number) => readonly SegmentSample[];
	/** Live detail level. Re-read every call — the controller updates its backing value on settings changes, not just at construction. */
	getDetail: () => BoxDetail;
	/**
	 * Live border brightness for this frame (Decision 2): the breathing-border
	 * keeper's own `0..1` envelope, re-read every call same as `getDetail`.
	 * `undefined` means `breathingBorder` is disabled in config — this
	 * widget's cue to fall back to the plain, uncolored chrome. Motion tier
	 * `off` is a separate, harder override this widget checks itself against
	 * its own `policy` (mirroring the standalone `BreathingBorderWidget`'s own
	 * tier check), so the seam never needs to encode that case.
	 */
	getBorderBrightness: (nowMs: number) => number | undefined;
	/** Accent override for the border's peak brightness — the existing `breathingBorderAccentColor` setting; `undefined` keeps the breathing-border keeper's built-in palette. */
	accentColor?: ThemeColor;
}

export class AnimationsBoxWidget extends AnimatedWidget {
	#theme: BoxTheme;
	#clock: Pick<FrameScheduler, "now">;
	#onTick: (nowMs: number) => void;
	#buildSamples: (nowMs: number) => readonly SegmentSample[];
	#getDetail: () => BoxDetail;
	#policy: MotionPolicy;
	#getBorderBrightness: (nowMs: number) => number | undefined;
	#colors: BreathingBorderColors;

	constructor(options: AnimationsBoxWidgetOptions) {
		super(options);
		this.#theme = options.theme;
		this.#clock = options.clock;
		this.#onTick = options.onTick;
		this.#buildSamples = options.buildSamples;
		this.#getDetail = options.getDetail;
		this.#policy = options.policy;
		this.#getBorderBrightness = options.getBorderBrightness;
		this.#colors = breathingBorderColors(options.accentColor);
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
		const theme = this.#theme;
		const borderColor = this.#resolveBorderColor(now);

		if (this.#getDetail() === "detailed") {
			const rows = samples.map(s => contentLine(detailRowText(s.detail, inner), inner, width, theme, borderColor));
			return [borderTop(width, theme, borderColor), ...rows, borderBottom(width, theme, borderColor)];
		}

		// Simple mode: exactly one composed row, always drawn (even empty) — height
		// stays fixed at 3 regardless of how many of the enabled segments are
		// currently active.
		const activeSegments = samples.filter(s => s.active).map(s => toKitSegment(s.id, s.priority, s.variants));
		const { row } = composeSegments(activeSegments, inner);
		return [
			borderTop(width, theme, borderColor),
			contentLine(row, inner, width, theme, borderColor),
			borderBottom(width, theme, borderColor),
		];
	}

	/**
	 * Border color for this frame. `undefined` (the plain, pre-dxi.5 chrome)
	 * when the motion tier is `off` — a hard override, exactly mirroring the
	 * standalone `BreathingBorderWidget`'s own tier check — or when
	 * `getBorderBrightness` reports `breathingBorder` is disabled. Otherwise
	 * the live envelope buckets through the SAME `brightnessToken`
	 * classification the standalone widget uses, resolved through this
	 * widget's own accent-aware palette.
	 */
	#resolveBorderColor(now: number): ThemeColor | undefined {
		if (this.#policy.tier === "off") return undefined;
		const brightness = this.#getBorderBrightness(now);
		if (brightness === undefined) return undefined;
		return colorForToken(brightnessToken(brightness), this.#colors);
	}
}

/** Documented row-cost accounting for tests: border rows + one content row (simple) or one per enabled segment (detailed). */
export const BOX_BORDER_ROWS = BORDER_ROWS;
export const BOX_BORDER_COLS = BORDER_COLS;
