/**
 * Rate-Limit Tidepool's pure renderers — the palette, the glyph set, and the
 * proportional pool bar the Audit Box's `limits` status line draws.
 *
 * `src/animations-box/segments.ts` calls {@link renderTidepoolRow} once per
 * width variant at the fixed `subtle` motion tier, so the `full`-tier shimmer
 * ({@link shimmerBeat}) never fires there; it stays because the tier is a
 * parameter of the renderer, not of any one caller. Everything here is
 * deterministic given its numeric inputs — no wall-clock reads, no state.
 */
import type { SymbolPreset, Theme, ThemeColor } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { type AccentColor, accentToThemeColor } from "../appearance";
import { resolveGlyph } from "../glyph-presets";
import { type PoolTier, poolFilledCells, poolTier } from "./tidepool";

/** The slice of {@link Theme} the renderers need — just foreground coloring. */
export type TidepoolTheme = Pick<Theme, "fg">;

/**
 * Named color map. `water` is the primary accent slot — the only token an
 * accent override replaces; `sand` stays a fixed alarm color (same reasoning
 * as Drift Buoy's `strained`), since a near-empty pool is the one state worth
 * a distinct, non-configurable visual cue.
 */
export interface TidepoolColors {
	water: ThemeColor;
	pebble: ThemeColor;
	sand: ThemeColor;
	label: ThemeColor;
}

/** Built-in palette. */
export const TIDEPOOL_COLORS: TidepoolColors = {
	water: "accent",
	pebble: "dim",
	sand: "warning",
	label: "dim",
};

/** The palette with the accent slot applied. `undefined` keeps the built-in water color. */
export function tidepoolColors(accentColor?: AccentColor): TidepoolColors {
	return accentColor === undefined ? TIDEPOOL_COLORS : { ...TIDEPOOL_COLORS, water: accentToThemeColor(accentColor) };
}

/** Filled-water glyph, resolved for `preset` via `../glyph-presets.ts`. Defaults to `"unicode"` — the original hardcoded value. */
export function waterGlyph(preset: SymbolPreset = "unicode"): string {
	return resolveGlyph("rateLimitTidepool.water", preset);
}
/** The filled edge cell's alternate glyph on the `full` motion tier's shimmer beat, resolved for `preset`. */
export function waterShimmerGlyph(preset: SymbolPreset = "unicode"): string {
	return resolveGlyph("rateLimitTidepool.waterShimmer", preset);
}
/** Exposed-pool glyph while draining but not yet near-empty, resolved for `preset`. */
export function pebbleGlyph(preset: SymbolPreset = "unicode"): string {
	return resolveGlyph("rateLimitTidepool.pebble", preset);
}
/** Exposed-pool glyph once the pool reads as near-empty wet sand, resolved for `preset`. */
export function sandGlyph(preset: SymbolPreset = "unicode"): string {
	return resolveGlyph("rateLimitTidepool.sand", preset);
}

/** Widest the pool bar ever draws, in cells, regardless of available row width — the row-width budget caps it further. */
export const MAX_POOL_CELLS = 10;

/** Full period of the `full`-tier shimmer's two-frame flicker, in ms. */
export const SHIMMER_PERIOD_MS = 900;

/** Whether the shimmer glyph is showing at `elapsedMs` — a slow two-frame flicker, mirroring Drift Buoy's `bobbingBeat`. */
export function shimmerBeat(elapsedMs: number): boolean {
	const phase = ((elapsedMs % SHIMMER_PERIOD_MS) + SHIMMER_PERIOD_MS) % SHIMMER_PERIOD_MS;
	return phase < SHIMMER_PERIOD_MS / 2;
}

/** A single tier's resting glyph — used for the very narrow width degradation. */
function bareGlyph(tier: PoolTier, preset: SymbolPreset): string {
	return tier === "sand" ? sandGlyph(preset) : tier === "pebbles" ? pebbleGlyph(preset) : waterGlyph(preset);
}

/**
 * Render the proportional fill bar alone: filled cells read left-to-right as
 * water, one glyph per cell; the exposed (undrawn) remainder reads as pebbles
 * or sand depending on `tier`. `shimmerOn` only ever touches the single
 * rightmost filled (edge) cell — a shimmer, not a wave — and never applies to
 * the `sand` tier (a near-empty pool has nothing left to shimmer).
 */
export function renderTidepoolBar(
	level: number,
	cells: number,
	tier: PoolTier,
	shimmerOn: boolean,
	theme: TidepoolTheme,
	colors: TidepoolColors = TIDEPOOL_COLORS,
	preset: SymbolPreset = "unicode",
): string {
	if (cells <= 0) return "";
	const filled = poolFilledCells(level, cells);
	const exposedGlyph = tier === "sand" ? sandGlyph(preset) : pebbleGlyph(preset);
	const exposedColor = tier === "sand" ? colors.sand : colors.pebble;
	const parts: string[] = [];
	for (let i = 0; i < cells; i++) {
		if (i < filled) {
			const atEdge = i === filled - 1;
			const glyph = atEdge && shimmerOn && tier !== "sand" ? waterShimmerGlyph(preset) : waterGlyph(preset);
			parts.push(theme.fg(colors.water, glyph));
		} else {
			parts.push(theme.fg(exposedColor, exposedGlyph));
		}
	}
	return parts.join("");
}

/**
 * Pure renderer for one Tidepool row at `level` (already refill-adjusted by
 * the caller — see `refillLevel`). Degrades widest first: `full` (the bar
 * plus `NN% provider`) -> `plain` (drop the bar, keep the honest `NN%
 * provider` label) -> `bare` (just the percentage) -> a single tier glyph for
 * the narrowest widths. Deterministic given its numeric inputs — no
 * wall-clock reads.
 */
export function renderTidepoolRow(
	level: number,
	provider: string,
	elapsedMs: number,
	width: number,
	theme: TidepoolTheme,
	motionTier: "full" | "subtle",
	colors: TidepoolColors = TIDEPOOL_COLORS,
	preset: SymbolPreset = "unicode",
): string {
	if (width <= 0) return "";
	const tier = poolTier(level);
	const pct = Math.round((level <= 0 ? 0 : level >= 1 ? 1 : level) * 100);
	const pctLabel = `${pct}%`;
	const labelFull = `${pctLabel} ${provider}`;

	const shimmerOn = motionTier === "full" && shimmerBeat(elapsedMs);
	const bar = renderTidepoolBar(level, MAX_POOL_CELLS, tier, shimmerOn, theme, colors, preset);
	const fullWidth = MAX_POOL_CELLS + 1 + labelFull.length;
	if (fullWidth <= width) return `${bar} ${theme.fg(colors.label, labelFull)}`;

	if (labelFull.length <= width) return theme.fg(colors.label, labelFull);
	if (pctLabel.length <= width) return theme.fg(colors.label, pctLabel);

	const glyphColor = tier === "sand" ? colors.sand : tier === "pebbles" ? colors.pebble : colors.water;
	return theme.fg(glyphColor, bareGlyph(tier, preset));
}
