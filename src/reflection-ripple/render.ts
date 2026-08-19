/**
 * Pure row renderer and palette for the reflection ripple, as it appears
 * inside the Audit Box. `src/animations-box/segments.ts` calls
 * {@link renderReflectionRippleRow} with the elapsed-ms the box's controller
 * derives from `ReflectionRippleState`, so every frame is a deterministic
 * function of its numeric inputs — no wall-clock reads here.
 */
import type { SymbolPreset, Theme, ThemeColor } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { type AccentColor, accentToThemeColor } from "../appearance";
import {
	DIM_DURATION_MS,
	dimMultiplier,
	RIPPLE_DURATION_MS,
	reflectDimAmount,
	ringGlyph,
	rippleBrightness,
	rippleProgress,
	rippleRadius,
} from "./ripple";

/** The slice of {@link Theme} the renderer needs — just foreground coloring. */
export type ReflectionRippleTheme = Pick<Theme, "fg">;

const RESTING_GLYPH = "·";
const DARK_GLYPH = " ";

/**
 * Named color map. `ring` is the primary accent slot — the only token an
 * accent override replaces; `calm` (the resting water) stays fixed dim.
 */
export interface ReflectionRippleColors {
	ring: ThemeColor;
	calm: ThemeColor;
}

/** Built-in palette — the exact tokens the renderer used before colors were configurable. */
export const REFLECTION_RIPPLE_COLORS: ReflectionRippleColors = { ring: "accent", calm: "dim" };

/** The palette with the accent slot applied, or the built-in palette when none is given. */
export function reflectionRippleColors(accentColor: AccentColor | undefined): ReflectionRippleColors {
	return accentColor === undefined
		? REFLECTION_RIPPLE_COLORS
		: { ...REFLECTION_RIPPLE_COLORS, ring: accentToThemeColor(accentColor) };
}

/** Calm-water background glyph: goes fully dark while the breath dim is more than half applied, resting dots otherwise. Pure. */
function calmGlyph(dimAmount: number): string {
	const clamped = dimAmount <= 0 ? 0 : dimAmount >= 1 ? 1 : dimAmount;
	return clamped > 0.5 ? DARK_GLYPH : RESTING_GLYPH;
}

/**
 * Pure renderer for one reflection-ripple row at `elapsedMs` since the
 * triggering `ttsr_triggered` event. In the `full` tier, two wavefronts
 * expand symmetrically outward from center over calm water; the `subtle`
 * tier collapses that to a single centered pulse (no travel). Deterministic
 * given its numeric inputs — no wall-clock reads.
 */
export function renderReflectionRippleRow(
	elapsedMs: number,
	width: number,
	theme: ReflectionRippleTheme,
	tier: "full" | "subtle",
	colors: ReflectionRippleColors = REFLECTION_RIPPLE_COLORS,
	preset: SymbolPreset = "unicode",
): string {
	if (width <= 0) return "";
	const progress = rippleProgress(elapsedMs, RIPPLE_DURATION_MS);
	const dimAmount = reflectDimAmount(elapsedMs, DIM_DURATION_MS);
	const brightness = rippleBrightness(progress) * dimMultiplier(dimAmount);
	const glyph = ringGlyph(brightness, preset);
	const bg = calmGlyph(dimAmount);

	if (tier === "subtle") {
		if (width === 1) return theme.fg(colors.ring, glyph);
		const center = Math.floor((width - 1) / 2);
		const before = bg.repeat(center);
		const after = bg.repeat(width - center - 1);
		return theme.fg(colors.calm, before) + theme.fg(colors.ring, glyph) + theme.fg(colors.calm, after);
	}

	const center = Math.floor(width / 2);
	const radius = Math.round(rippleRadius(progress, center));
	const leftPos = center - radius;
	const rightPos = center + radius;
	const cells: string[] = [];
	for (let i = 0; i < width; i++) {
		if (i === leftPos || i === rightPos) {
			cells.push(theme.fg(colors.ring, glyph));
		} else {
			cells.push(theme.fg(colors.calm, bg));
		}
	}
	return cells.join("");
}
