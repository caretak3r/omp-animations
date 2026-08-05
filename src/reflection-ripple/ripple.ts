/**
 * Pure math for the reflection ripple: a single expanding-and-fading wave
 * spawned each time TTSR interrupts generation to inject a rule, plus the
 * "taking a breath" dim envelope that darkens the whole row for the same
 * window. Every function is a deterministic function of its numeric inputs —
 * no wall-clock reads — so frames are byte-stable given an injected clock.
 */

/** Total lifetime of one ripple: born bright at the center, fully faded by the time it reaches the edge. */
export const RIPPLE_DURATION_MS = 1600;

/** How long the "breath" dim settles back to full brightness after a trigger. */
export const DIM_DURATION_MS = 1200;

/** `elapsedMs` since the ripple was spawned, as a `[0, 1]` fraction of `durationMs`. Clamped. Pure. */
export function rippleProgress(elapsedMs: number, durationMs: number): number {
	if (durationMs <= 0) return 1;
	if (elapsedMs <= 0) return 0;
	if (elapsedMs >= durationMs) return 1;
	return elapsedMs / durationMs;
}

/**
 * Distance (in columns) the ripple's wavefront has traveled from center at
 * `progress`, up to `maxRadius`. Decelerating (`sqrt` easing) — a ripple
 * spreads fast at first and slows as it widens, unlike a linear sweep.
 * Monotonic non-decreasing in `progress`. Pure.
 */
export function rippleRadius(progress: number, maxRadius: number): number {
	const clamped = progress <= 0 ? 0 : progress >= 1 ? 1 : progress;
	if (maxRadius <= 0) return 0;
	return Math.sqrt(clamped) * maxRadius;
}

/**
 * Brightness (`[0, 1]`) of the ripple's wavefront at `progress`: born at full
 * intensity, linearly dissipating to `0` as it reaches the edge — a ripple's
 * energy spreads thinner the further it travels. Monotonic non-increasing in
 * `progress`. Pure.
 */
export function rippleBrightness(progress: number): number {
	const clamped = progress <= 0 ? 0 : progress >= 1 ? 1 : progress;
	return 1 - clamped;
}

/** Ordered ring glyph ramp, faintest/most-dissipated to brightest/newest. */
const RING_GLYPHS = [" ", "·", "∘", "○", "◉"] as const;

/** Map a `[0, 1]` brightness to a glyph on the {@link RING_GLYPHS} ramp. Monotonic. Pure. */
export function ringGlyph(brightness: number): string {
	const clamped = brightness <= 0 ? 0 : brightness >= 1 ? 1 : brightness;
	const index = Math.min(RING_GLYPHS.length - 1, Math.floor(clamped * RING_GLYPHS.length));
	return RING_GLYPHS[index] ?? RING_GLYPHS[0];
}

/**
 * The "breath" dim amount (`[0, 1]`, `0` = no dim, `1` = maximally dim) at
 * `elapsedMs` since a trigger: peaks immediately (the agent visibly pausing
 * to reflect) then eases back down to `0` by `durationMs` (breath released,
 * back to normal). Deliberately mirrors an exhale wind-down shape rather than
 * a symmetric bump — the dim lands instantly and recovers gradually. Pure.
 */
export function reflectDimAmount(elapsedMs: number, durationMs: number): number {
	if (durationMs <= 0 || elapsedMs >= durationMs) return 0;
	if (elapsedMs <= 0) return 1;
	return (1 + Math.cos(Math.PI * (elapsedMs / durationMs))) / 2;
}

/** Maximum fraction a fully dimmed row's brightness is pulled down by. */
const MAX_DIM_PULL = 0.65;

/** Brightness multiplier (`[1 - MAX_DIM_PULL, 1]`) for a given `dimAmount` (`[0, 1]`). Monotonic non-increasing in `dimAmount`. Pure. */
export function dimMultiplier(dimAmount: number): number {
	const clamped = dimAmount <= 0 ? 0 : dimAmount >= 1 ? 1 : dimAmount;
	return 1 - clamped * MAX_DIM_PULL;
}
