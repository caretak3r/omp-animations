/**
 * Generic, glyph-preset-aware horizontal fill bar — shared infra for any
 * segment with a real `[0, 1]`-bounded metric (the Animations Box's cache
 * hit-rate and rate-limit level rows; see `animations-box/segments.ts`).
 *
 * Deliberately separate from `rate-limit-tidepool/render.ts`'s own
 * `renderTidepoolBar`, which stays specific to that row: it owns the
 * water/pebble/sand glyph set, the tier thresholds, and the shimmer beat.
 * This module is the plain, un-themed `[#####-----]` shape used when a
 * segment just needs an honest proportional bar, owned by no single animation
 * — hence `box.bar.*` in `glyph-presets.ts` rather than a
 * `rateLimitTidepool.*`/`cacheMeter.*` key.
 */
import type { SymbolPreset, Theme, ThemeColor } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { GlyphKey } from "./glyph-presets";
import { resolveGlyph } from "./glyph-presets";
import type { RenderTier } from "./terminal-capabilities";

/** The slice of {@link Theme} the renderer needs — foreground coloring, optionally color hex extraction for gradients. */
export type ProgressBarTheme = Pick<Theme, "fg"> & Partial<Pick<Theme, "getColorHex">>;

/** Fixed cell count every bar renders at — same width regardless of caller, so rows stay column-aligned. */
export const PROGRESS_BAR_CELLS = 10;

/** Clamp to `[0, 1]`, non-finite treated as empty. */
function clamp01(ratio: number): number {
	if (!Number.isFinite(ratio)) return 0;
	return ratio <= 0 ? 0 : ratio >= 1 ? 1 : ratio;
}

/** Gradient direction for threshold-based color interpolation. */
export type GradientDirection = "up-good" | "down-good";

/**
 * Parse hex color to RGB components.
 * @param hex - Color string like "#00ff00"
 * @returns RGB tuple [r, g, b] in 0-255 range
 */
export function parseHex(hex: string): [number, number, number] {
	const cleaned = hex.replace("#", "");
	const r = Number.parseInt(cleaned.slice(0, 2), 16);
	const g = Number.parseInt(cleaned.slice(2, 4), 16);
	const b = Number.parseInt(cleaned.slice(4, 6), 16);
	return [r, g, b];
}

/**
 * Convert RGB components to hex color string.
 * @param r - Red component (0-255)
 * @param g - Green component (0-255)
 * @param b - Blue component (0-255)
 * @returns Hex color string like "#00ff00"
 */
function rgbToHex(r: number, g: number, b: number): string {
	const rr = Math.round(r).toString(16).padStart(2, "0");
	const gg = Math.round(g).toString(16).padStart(2, "0");
	const bb = Math.round(b).toString(16).padStart(2, "0");
	return `#${rr}${gg}${bb}`;
}

/**
 * Interpolate between two RGB colors.
 * @param start - Starting RGB color
 * @param end - Ending RGB color
 * @param t - Interpolation factor [0, 1]
 * @returns Interpolated RGB color
 */
function interpolateRgb(
	start: [number, number, number],
	end: [number, number, number],
	t: number,
): [number, number, number] {
	const r = start[0] + (end[0] - start[0]) * t;
	const g = start[1] + (end[1] - start[1]) * t;
	const b = start[2] + (end[2] - start[2]) * t;
	return [r, g, b];
}

/**
 * Compute gradient color for a cell at given ratio.
 * Routes through warning (yellow) midpoint for better visual read.
 * @param ratio - Fill ratio [0, 1]
 * @param direction - "up-good" (low→red, high→green) or "down-good" (inverse)
 * @param theme - Theme for color resolution
 * @returns Hex color string
 */
export function gradientColorAt(
	ratio: number,
	direction: GradientDirection,
	theme: Required<ProgressBarTheme>,
): string {
	// Resolve theme colors to hex
	const errorHex = theme.getColorHex("error");
	const warningHex = theme.getColorHex("warning");
	const successHex = theme.getColorHex("success");

	const errorRgb = parseHex(errorHex);
	const warningRgb = parseHex(warningHex);
	const successRgb = parseHex(successHex);

	// Map ratio to color based on direction
	// up-good: 0→red, 0.5→yellow, 1→green
	// down-good: 0→green, 0.5→yellow, 1→red
	let t: number;
	let startRgb: [number, number, number];
	let midRgb: [number, number, number];
	let endRgb: [number, number, number];

	if (direction === "up-good") {
		// Low is bad (red), high is good (green)
		startRgb = errorRgb;
		midRgb = warningRgb;
		endRgb = successRgb;
		t = ratio;
	} else {
		// Low is good (green), high is bad (red)
		startRgb = successRgb;
		midRgb = warningRgb;
		endRgb = errorRgb;
		t = ratio;
	}

	// Interpolate through midpoint at 0.5
	let rgb: [number, number, number];
	if (t <= 0.5) {
		// First half: start → mid
		rgb = interpolateRgb(startRgb, midRgb, t * 2);
	} else {
		// Second half: mid → end
		rgb = interpolateRgb(midRgb, endRgb, (t - 0.5) * 2);
	}

	return rgbToHex(rgb[0], rgb[1], rgb[2]);
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
 *
 * Rounding rule:
 * - ASCII and Unicode presets round to the nearest whole cell.
 * - The Nerd preset opts into eighth-cell resolution:
 *   `scaled = ratio * cells`; full cells use `Math.floor(scaled)`, and the
 *   fractional remainder selects one of seven eighth-block boundary glyphs.
 * - At exact whole-cell ratios all presets remain byte-identical.
 */
export function renderProgressBar(
	ratio: number,
	theme: ProgressBarTheme,
	filledColor: ThemeColor,
	emptyColor: ThemeColor = "dim",
	preset: SymbolPreset = "unicode",
	cells: number = PROGRESS_BAR_CELLS,
	renderTier?: RenderTier,
	gradientDirection?: GradientDirection,
): string {
	const clamped = clamp01(ratio);

	// Eighth-block glyphs are opt-in: ASCII and Unicode use whole-cell round-nearest.
	if (preset !== "nerd") {
		const filled = progressBarFilledCells(ratio, cells);
		const filledGlyph = resolveGlyph("box.bar.filled", preset);
		const emptyGlyph = resolveGlyph("box.bar.empty", preset);
		const bar: string[] = [];
		for (let i = 0; i < cells; i++) {
			if (i < filled) {
				if (renderTier?.colorMode === "truecolor" && gradientDirection && theme.getColorHex) {
					const cellColor = gradientColorAt(ratio, gradientDirection, theme as Required<ProgressBarTheme>);
					bar.push(`\x1b[38;2;${parseHex(cellColor).join(";")}m${filledGlyph}\x1b[0m`);
				} else {
					bar.push(theme.fg(filledColor, filledGlyph));
				}
			} else {
				bar.push(theme.fg(emptyColor, emptyGlyph));
			}
		}
		return `[${bar.join("")}]`;
	}

	// Nerd preset: eighth-block sub-cell resolution.
	const scaled = clamped * cells;
	let full = Math.floor(scaled);
	let eighths = Math.round((scaled - full) * 8);

	// Carry: 8/8 becomes next full cell
	if (eighths === 8) {
		full += 1;
		eighths = 0;
	}

	const filledGlyph = resolveGlyph("box.bar.filled", preset);
	const emptyGlyph = resolveGlyph("box.bar.empty", preset);
	const bar: string[] = [];

	for (let i = 0; i < cells; i++) {
		if (i < full) {
			// Full cell
			if (renderTier?.colorMode === "truecolor" && gradientDirection && theme.getColorHex) {
				const cellColor = gradientColorAt(ratio, gradientDirection, theme as Required<ProgressBarTheme>);
				bar.push(`\x1b[38;2;${parseHex(cellColor).join(";")}m${filledGlyph}\x1b[0m`);
			} else {
				bar.push(theme.fg(filledColor, filledGlyph));
			}
		} else if (i === full && eighths > 0) {
			// Boundary cell with partial fill
			const partialGlyph = resolveGlyph(`box.bar.eighths.${eighths}` as GlyphKey, preset);
			if (renderTier?.colorMode === "truecolor" && gradientDirection && theme.getColorHex) {
				const cellColor = gradientColorAt(ratio, gradientDirection, theme as Required<ProgressBarTheme>);
				bar.push(`\x1b[38;2;${parseHex(cellColor).join(";")}m${partialGlyph}\x1b[0m`);
			} else {
				bar.push(theme.fg(filledColor, partialGlyph));
			}
		} else {
			// Empty cell
			bar.push(theme.fg(emptyColor, emptyGlyph));
		}
	}
	return `[${bar.join("")}]`;
}
