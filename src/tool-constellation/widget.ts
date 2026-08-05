import type { Theme, ThemeColor } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { AnimatedWidgetOptions, FrameScheduler, MotionPolicy } from "../kit";
import { AnimatedWidget } from "../kit";
import { CATEGORY_ICON, CATEGORY_ORDER, CATEGORY_THEME_COLOR, type ToolCategory } from "./categories";
import {
	COMET_GLYPH,
	COMET_WINDOW_MS,
	EMPTY_GLYPH,
	GRID_COLS,
	GRID_ROWS,
	isTwinkling,
	starBrightness,
	starGlyph,
	starGlyphIndex,
} from "./sky";
import type { ConstellationSnapshot, ConstellationState, StarRecord } from "./state";

/** The slice of {@link Theme} the renderer needs — just foreground coloring. */
export type ConstellationTheme = Pick<Theme, "fg">;

function cellRowCol(cell: number): { row: number; col: number } {
	return { row: Math.floor(cell / GRID_COLS), col: cell % GRID_COLS };
}

/** Binary bright/dim dot for the `subtle` tier — no glyph ramp, no twinkle. */
function subtleGlyph(brightness: number): string {
	return brightness > 0.5 ? "•" : EMPTY_GLYPH;
}

/**
 * Pure renderer: the night-field grid for one frame. `full` tier adds a
 * ley-line between the last two distinct fired stars (only drawn when they
 * share a grid row — a deliberate simplification of arbitrary line-drawing in
 * a character grid) and a per-cell idle twinkle blip; `subtle` renders plain
 * brighten-on-fire dots with neither. Deterministic given `snapshot` and
 * `elapsedMs` — no wall-clock reads.
 */
export function renderConstellationGrid(
	snapshot: ConstellationSnapshot,
	elapsedMs: number,
	theme: ConstellationTheme,
	tier: "full" | "subtle",
): readonly string[] {
	const starAt = new Map<number, { glyph: string; color: ThemeColor }>();
	// Track the previous/last-fired stars while we're already walking every star for `starAt`,
	// instead of a second `.find()` scan below — the ley-line only ever needs these two.
	let prevStar: StarRecord | undefined;
	let lastStar: StarRecord | undefined;
	for (const star of snapshot.stars) {
		const msSinceFire = elapsedMs - star.lastFireAt;
		const isComet =
			tier === "full" && star.toolName === snapshot.lastFired && msSinceFire >= 0 && msSinceFire <= COMET_WINDOW_MS;
		let brightness = starBrightness(msSinceFire);
		if (tier === "full" && !isComet && isTwinkling(star.cell, elapsedMs)) {
			brightness = Math.max(brightness, starBrightness(0));
		}
		const glyph = isComet ? COMET_GLYPH : tier === "full" ? starGlyph(brightness) : subtleGlyph(brightness);
		starAt.set(star.cell, { glyph, color: CATEGORY_THEME_COLOR[star.category] });
		if (star.toolName === snapshot.previousFired) prevStar = star;
		if (star.toolName === snapshot.lastFired) lastStar = star;
	}

	const lineCells = new Set<number>();
	if (
		tier === "full" &&
		snapshot.previousFired &&
		snapshot.lastFired &&
		snapshot.previousFired !== snapshot.lastFired
	) {
		if (prevStar && lastStar) {
			const prevRC = cellRowCol(prevStar.cell);
			const lastRC = cellRowCol(lastStar.cell);
			if (prevRC.row === lastRC.row) {
				const lo = Math.min(prevRC.col, lastRC.col);
				const hi = Math.max(prevRC.col, lastRC.col);
				for (let col = lo + 1; col < hi; col++) {
					const idx = prevRC.row * GRID_COLS + col;
					if (!starAt.has(idx)) lineCells.add(idx);
				}
			}
		}
	}

	const rows: string[] = [];
	for (let row = 0; row < GRID_ROWS; row++) {
		const parts: string[] = [];
		for (let col = 0; col < GRID_COLS; col++) {
			const idx = row * GRID_COLS + col;
			const star = starAt.get(idx);
			if (star) {
				parts.push(theme.fg(star.color, star.glyph));
			} else if (lineCells.has(idx)) {
				parts.push(theme.fg("dim", "─"));
			} else {
				parts.push(theme.fg("dim", EMPTY_GLYPH));
			}
		}
		rows.push(parts.join(" "));
	}
	return rows;
}

/** Static one-line fallback for the motion-`off` tier: a per-category fire tally. */
export function renderConstellationTally(counts: ReadonlyMap<ToolCategory, number>, theme: ConstellationTheme): string {
	const segments = CATEGORY_ORDER.filter(category => (counts.get(category) ?? 0) > 0).map(category =>
		theme.fg(CATEGORY_THEME_COLOR[category], `${CATEGORY_ICON[category]} ${counts.get(category)}`),
	);
	if (segments.length === 0) return theme.fg("dim", "no tool activity yet");
	return segments.join(" · ");
}

/** Reserved {@link starVisualCode} value for the comet-head glyph — outside the `starGlyphIndex`/subtle-dot range. */
const COMET_CODE = -1;

/**
 * Cheap per-star discrete "what would this star look like" code — the same comet/twinkle/decay
 * inputs `renderConstellationGrid` uses, collapsed to one integer per star instead of a themed
 * glyph string. Two frames with identical codes (and identical `lastFired`/`previousFired`, checked
 * by the caller) are guaranteed to render byte-identical rows, because a star's rendered glyph/color
 * is a pure function of exactly these inputs. Always computed from the real `elapsedMs` — the
 * twinkle blip (`isTwinkling`, ~1800ms period) and the decay curve stay live every frame; only the
 * expensive string-building (the `Map`/`Set`/`theme.fg`/`join` in `renderConstellationGrid`) is
 * skipped on a code match. Dropping `elapsedMs` from this computation would freeze twinkles.
 */
function starVisualCode(
	star: StarRecord,
	elapsedMs: number,
	tier: "full" | "subtle",
	lastFired: string | undefined,
): number {
	const msSinceFire = elapsedMs - star.lastFireAt;
	const isComet = tier === "full" && star.toolName === lastFired && msSinceFire >= 0 && msSinceFire <= COMET_WINDOW_MS;
	if (isComet) return COMET_CODE;
	let brightness = starBrightness(msSinceFire);
	if (tier === "full" && isTwinkling(star.cell, elapsedMs)) {
		brightness = Math.max(brightness, starBrightness(0));
	}
	return tier === "full" ? starGlyphIndex(brightness) : brightness > 0.5 ? 1 : 0;
}

function starVisualCodes(snapshot: ConstellationSnapshot, elapsedMs: number, tier: "full" | "subtle"): number[] {
	return snapshot.stars.map(star => starVisualCode(star, elapsedMs, tier, snapshot.lastFired));
}

function codesEqual(a: readonly number[] | undefined, b: readonly number[]): boolean {
	if (!a || a.length !== b.length) return false;
	for (let i = 0; i < b.length; i++) {
		if (a[i] !== b[i]) return false;
	}
	return true;
}

/** Minimal clock seam the widget needs — shared with the controller so fire timestamps and render reads agree. */
export type ConstellationClock = Pick<FrameScheduler, "now">;

export interface ToolConstellationWidgetOptions extends AnimatedWidgetOptions {
	state: ConstellationState;
	theme: ConstellationTheme;
	/** Same clock the controller stamps fires with — NOT the host's internal relative elapsed-ms. */
	clock: ConstellationClock;
}

/**
 * Ambient `belowEditor` widget for the tool-activity star map. A thin
 * renderer over the shared {@link ConstellationState}: each frame it takes a
 * snapshot and draws the grid at the current clock reading and live
 * {@link MotionPolicy} tier. Deliberately reads {@link ConstellationClock}
 * rather than `this.elapsedMs` — the host's frame ticks only drive repaint
 * cadence here, not the decay phase, so mounting later than the controller's
 * first fire doesn't skew star ages. The {@link AnimatedWidget} base owns the
 * subscribe-on-mount / unsubscribe-on-dispose lifecycle.
 */
export class ToolConstellationWidget extends AnimatedWidget {
	#state: ConstellationState;
	#theme: ConstellationTheme;
	#policy: MotionPolicy;
	#clock: ConstellationClock;
	#memoCodes: number[] | undefined;
	#memoLastFired: string | undefined;
	#memoPreviousFired: string | undefined;
	#memoRows: readonly string[] | undefined;

	constructor(options: ToolConstellationWidgetOptions) {
		super(options);
		this.#state = options.state;
		this.#theme = options.theme;
		this.#policy = options.policy;
		this.#clock = options.clock;
	}

	renderFrame(_width: number): readonly string[] {
		const tier = this.#policy.tier === "full" ? "full" : "subtle";
		const snapshot = this.#state.snapshot();
		const elapsedMs = this.#clock.now();
		const codes = starVisualCodes(snapshot, elapsedMs, tier);
		if (
			this.#memoRows &&
			snapshot.lastFired === this.#memoLastFired &&
			snapshot.previousFired === this.#memoPreviousFired &&
			codesEqual(this.#memoCodes, codes)
		) {
			return this.#memoRows;
		}
		const rows = renderConstellationGrid(snapshot, elapsedMs, this.#theme, tier);
		this.#memoCodes = codes;
		this.#memoLastFired = snapshot.lastFired;
		this.#memoPreviousFired = snapshot.previousFired;
		this.#memoRows = rows;
		return rows;
	}
}
