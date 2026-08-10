/**
 * Generic, glyph-preset-aware horizontal fill bar — shared infra for any
 * segment with a real `[0, 1]`-bounded metric (the Animations Box's cache
 * hit-rate and rate-limit level rows; see `animations-box/segments.ts`).
 *
 * Deliberately separate from `rate-limit-tidepool/widget.ts`'s own
 * `renderTidepoolBar`: that renderer is Tidepool-specific (its own
 * water/pebble/sand glyph set, tiers, and shimmer animation) and stays that
 * way for the standalone Tidepool widget. This module is the plain,
 * un-themed `[#####-----]` shape used when a segment just needs an honest
 * proportional bar, not owned by any one keeper — hence `box.bar.*` in
 * `glyph-presets.ts` rather than a `rateLimitTidepool.*`/`cacheMeter.*` key.
 */
import type { SymbolPreset, Theme, ThemeColor } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { resolveGlyph } from "./glyph-presets";

/** The slice of {@link Theme} the renderer needs — just foreground coloring. */
export type ProgressBarTheme = Pick<Theme, "fg">;

/** Fixed cell count every bar renders at — same width regardless of caller, so rows stay column-aligned. */
export const PROGRESS_BAR_CELLS = 10;

/** Clamp to `[0, 1]`, non-finite treated as empty. */
function clamp01(ratio: number): number {
	if (!Number.isFinite(ratio)) return 0;
	return ratio <= 0 ? 0 : ratio >= 1 ? 1 : ratio;
}

/** How many of {@link PROGRESS_BAR_CELLS} read as filled at `ratio` — rounds to the nearest cell. */
export function progressBarFilledCells(ratio: number, cells: number = PROGRESS_BAR_CELLS): number {
	return Math.round(clamp01(ratio) * cells);
}

/**
 * Render a bracketed, colored `[##########]`-shape bar at `ratio`. Pure and
 * deterministic — no animation phase, unlike Tidepool's shimmering edge cell
 * (this bar has no motion tier to key off; the caller re-renders it fresh
 * every frame from the live ratio, same as every other detail-row field in
 * `animations-box/segments.ts`).
 */
export function renderProgressBar(
	ratio: number,
	theme: ProgressBarTheme,
	filledColor: ThemeColor,
	emptyColor: ThemeColor = "dim",
	preset: SymbolPreset = "unicode",
	cells: number = PROGRESS_BAR_CELLS,
): string {
	const filled = progressBarFilledCells(ratio, cells);
	const filledGlyph = resolveGlyph("box.bar.filled", preset);
	const emptyGlyph = resolveGlyph("box.bar.empty", preset);
	const bar: string[] = [];
	for (let i = 0; i < cells; i++) {
		bar.push(i < filled ? theme.fg(filledColor, filledGlyph) : theme.fg(emptyColor, emptyGlyph));
	}
	return `[${bar.join("")}]`;
}
