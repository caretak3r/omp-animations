/**
 * Tok/s bucket classification and the cool-to-hot theme palette Cadence
 * Equalizer keys its bands off. Originally shared with Token Tide ("reused
 * verbatim so the two cousins share one palette") — Token Tide is not part of
 * this package's animation keep-set, so this is Cadence Equalizer's own copy
 * rather than a cross-feature import. `restingPulse`/`WAVE_GLYPHS`, which only
 * Token Tide's own widget used, are dropped; everything below is load-bearing
 * for `render.ts` or for the Audit Box, which normalizes its live tok/s
 * samples through {@link normalizeAmplitude} before stepping the bands.
 */
import type { ThemeColor } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";

/** Coarse throughput bucket the bead's cool-to-hot palette keys off. */
export type RateBucket = "idle" | "low" | "medium" | "high" | "burst";

/** Ascending tok/s ceilings for the non-idle buckets. Any rate above the last ceiling is `burst`. */
const BUCKET_CEILINGS: ReadonlyArray<{ bucket: Exclude<RateBucket, "idle">; max: number }> = [
	{ bucket: "low", max: 20 },
	{ bucket: "medium", max: 60 },
	{ bucket: "high", max: 120 },
];

/** Classify a tok/s rate into a {@link RateBucket}. Pure, monotonic in `tokensPerSecond`. */
export function rateBucket(tokensPerSecond: number): RateBucket {
	if (!Number.isFinite(tokensPerSecond) || tokensPerSecond <= 0) return "idle";
	for (const { bucket, max } of BUCKET_CEILINGS) {
		if (tokensPerSecond <= max) return bucket;
	}
	return "burst";
}

/**
 * Bucket -> theme color, warming from resting dim through cool teal/cyan to
 * hot amber as throughput climbs. Chosen from the existing {@link ThemeColor}
 * set rather than inventing raw ANSI colors, matching the audit-trail
 * precedent.
 */
export const BUCKET_THEME_COLOR: Readonly<Record<RateBucket, ThemeColor>> = {
	idle: "dim",
	low: "syntaxType", // cool teal
	medium: "syntaxVariable", // cyan
	high: "syntaxFunction", // amber
	burst: "warning", // hot amber/red
};

/** Reference ceiling for amplitude normalization; rates at or above this clamp to `1`. */
export const MAX_REFERENCE_RATE = 160;

/** Normalize a tok/s rate to a `[0, 1]` amplitude. Pure, monotonic non-decreasing in `tokensPerSecond`. */
export function normalizeAmplitude(tokensPerSecond: number): number {
	if (!Number.isFinite(tokensPerSecond) || tokensPerSecond <= 0) return 0;
	return Math.min(1, tokensPerSecond / MAX_REFERENCE_RATE);
}

/** Vertical block ramp from empty to full, dimmest to loudest. */
const WAVE_GLYPHS = [" ", "▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"] as const;

/** Map an amplitude (`0..1`) to a glyph on the {@link WAVE_GLYPHS} ramp. Monotonic in `amplitude`. */
export function waveGlyph(amplitude: number): string {
	const clamped = amplitude <= 0 ? 0 : amplitude >= 1 ? 1 : amplitude;
	const index = Math.min(WAVE_GLYPHS.length - 1, Math.floor(clamped * WAVE_GLYPHS.length));
	return WAVE_GLYPHS[index] ?? WAVE_GLYPHS[0];
}
