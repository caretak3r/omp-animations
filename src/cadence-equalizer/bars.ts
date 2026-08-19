/**
 * How many bands the equalizer renders. Unlike a real audio EQ there is only
 * one input signal (tokensPerSecond) — the bands don't split it into
 * frequency ranges. Instead each band tracks the *same* signal through a
 * differently-tuned exponential moving average, so a burst hits the fast
 * band first (tall, jittery) while the slow band lags behind and smooths
 * it out — the "dancing bars" look a multi-band meter is chosen for.
 */
export const BAND_COUNT = 5;

/** Per-band EMA smoothing factors, fastest-reacting band first. Fixed-step (per animation frame), not time-scaled — same convention as Token Tide's per-frame `pushSample`. */
export const BAND_ALPHAS: readonly number[] = [0.55, 0.35, 0.2, 0.1, 0.05];

/** Per-frame linear peak decay, in normalized `[0, 1]` amplitude units. */
export const PEAK_DECAY_PER_FRAME = 0.02;

function clamp01(value: number): number {
	if (!Number.isFinite(value)) return 0;
	return value <= 0 ? 0 : value >= 1 ? 1 : value;
}

/** Step one band's EMA amplitude toward `target` by `alpha`. Pure; clamps to `[0, 1]`. */
export function stepBand(prevAmplitude: number, target: number, alpha: number): number {
	const prev = clamp01(prevAmplitude);
	const clampedTarget = clamp01(target);
	return clamp01(prev + (clampedTarget - prev) * alpha);
}

/**
 * Step one band's peak-hold marker: snaps up instantly to `currentAmplitude`
 * when the band is louder than the held peak, otherwise decays linearly by
 * `decayPerFrame`. Pure; clamps to `[0, 1]`.
 */
export function stepPeak(prevPeak: number, currentAmplitude: number, decayPerFrame: number): number {
	const current = clamp01(currentAmplitude);
	const decayed = clamp01(prevPeak) - decayPerFrame;
	return clamp01(Math.max(current, decayed));
}
