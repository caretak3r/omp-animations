/**
 * Pure math for the breathing border: an inhale/exhale luminance envelope, an
 * exhale decay curve for the post-`agent_end` wind-down, cadence modulation
 * from turn duration, and brightness->token bucketing for the Audit Box's
 * border chrome. Every function is a deterministic function of its numeric
 * inputs — no wall-clock reads — so frames are byte-stable given an injected
 * clock.
 */

/** Default full inhale+exhale cycle while the agent is actively working. */
export const BASE_BREATH_PERIOD_MS = 8000;
/** Fastest cadence a quick turn can pull the breath period down to. */
export const MIN_BREATH_PERIOD_MS = 4000;
/** Slowest cadence a long turn relaxes the breath period back out to. */
export const MAX_BREATH_PERIOD_MS = 12_000;
/** Duration of the single wind-down exhale fired on `agent_end`. */
export const EXHALE_DURATION_MS = 2000;

/**
 * Map a recent turn's wall-clock duration to a breath period: quicker turns
 * pull the cadence faster (down to {@link MIN_BREATH_PERIOD_MS}), slower or
 * unknown turns relax back toward {@link MAX_BREATH_PERIOD_MS}. `undefined`
 * (no turn observed yet) resolves to the {@link BASE_BREATH_PERIOD_MS}.
 */
export function breathPeriodMsForTurnDuration(turnDurationMs: number | undefined): number {
	if (turnDurationMs === undefined || !Number.isFinite(turnDurationMs) || turnDurationMs <= 0) {
		return BASE_BREATH_PERIOD_MS;
	}
	const scaled = turnDurationMs * 2;
	return Math.min(MAX_BREATH_PERIOD_MS, Math.max(MIN_BREATH_PERIOD_MS, scaled));
}

/**
 * Inhale/exhale luminance envelope: 0 at the start of a cycle, 1 at the
 * midpoint (peak inhale), back to 0 at the cycle boundary (full exhale) —
 * then repeats. A smooth cosine curve, not a sawtooth, so it reads as breath
 * rather than a strobe.
 */
export function breathEnvelope(elapsedMs: number, periodMs: number): number {
	if (periodMs <= 0) return 0;
	const phase = (((elapsedMs % periodMs) + periodMs) % periodMs) / periodMs;
	return (1 - Math.cos(2 * Math.PI * phase)) / 2;
}

/**
 * Post-`agent_end` wind-down: eases from peak brightness (1) down to 0 over
 * `durationMs`, then stays at 0. Deliberately independent of the breath phase
 * at the moment `agent_end` fired — "one slow exhale" reads as a fixed,
 * predictable wind-down rather than a phase-continuous fade.
 */
export function exhaleEnvelope(elapsedSinceEndMs: number, durationMs: number): number {
	if (durationMs <= 0 || elapsedSinceEndMs >= durationMs) return 0;
	if (elapsedSinceEndMs <= 0) return 1;
	return (1 + Math.cos(Math.PI * (elapsedSinceEndMs / durationMs))) / 2;
}

export type BorderBrightnessToken = "borderMuted" | "border" | "borderAccent";

/** Bucket a 0..1 brightness into one of the theme's dedicated border tokens. */
export function brightnessToken(brightness: number): BorderBrightnessToken {
	if (brightness < 0.15) return "borderMuted";
	if (brightness < 0.6) return "border";
	return "borderAccent";
}
