import type { Theme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { AnimatedWidgetOptions, MotionPolicy } from "../kit";
import { AnimatedWidget } from "../kit";
import {
	BUCKET_THEME_COLOR,
	MAX_REFERENCE_RATE,
	normalizeAmplitude,
	type RateBucket,
	rateBucket,
	waveGlyph,
} from "./scale";
import type { CadenceEqualizerState } from "./state";

/** The slice of {@link Theme} the renderer needs — just foreground coloring. */
export type CadenceEqualizerTheme = Pick<Theme, "fg">;

/** How far a band's peak must sit above its current amplitude before the peak cap renders as "held" rather than "just hit". */
const PEAK_VISIBLE_GAP = 0.03;

/** Color a normalized `[0, 1]` band amplitude by projecting it back onto Token Tide's tok/s buckets — reused verbatim so the two cousins share one palette. */
function bandColor(amplitude: number): RateBucket {
	return rateBucket(amplitude * MAX_REFERENCE_RATE);
}

/**
 * Pure renderer: the `full`-tier equalizer row. Each band renders as two
 * columns — a peak-hold cap (`‾`, dim until the band is still coasting down
 * from a recent high) followed by the live amplitude glyph — separated by a
 * blank spacer column. Deterministic given `bands`/`peaks` alone (no
 * wall-clock reads): a snapshot of state, not phase.
 */
export function renderEqualizerRow(
	bands: readonly number[],
	peaks: readonly number[],
	theme: CadenceEqualizerTheme,
): string {
	const parts: string[] = [];
	for (let i = 0; i < bands.length; i++) {
		if (i > 0) parts.push(" ");
		const amplitude = bands[i] ?? 0;
		const peak = peaks[i] ?? 0;
		const color = BUCKET_THEME_COLOR[bandColor(amplitude)];
		const showPeakCap = peak - amplitude >= PEAK_VISIBLE_GAP;
		parts.push(showPeakCap ? theme.fg(BUCKET_THEME_COLOR.burst, "‾") : theme.fg("dim", " "));
		parts.push(theme.fg(color, waveGlyph(amplitude)));
	}
	return parts.join("");
}

/**
 * Pure renderer: the `subtle`-tier equalizer — the same per-band amplitude
 * glyphs with no peak caps or spacing, a compact strip that fits a
 * status-line-sized slot. Deterministic given `bands` alone.
 */
export function renderCompactEqualizer(bands: readonly number[], theme: CadenceEqualizerTheme): string {
	return bands.map(amplitude => theme.fg(BUCKET_THEME_COLOR[bandColor(amplitude)], waveGlyph(amplitude))).join("");
}

/** Static one-line fallback for the motion-`off` tier: the numeric tok/s reading, or a dash when idle/unknown. */
export function renderEqualizerText(tokensPerSecond: number | null): string {
	if (tokensPerSecond === null || !Number.isFinite(tokensPerSecond) || tokensPerSecond <= 0) return "eq --";
	return `eq ${Math.round(tokensPerSecond)} tok/s`;
}

export interface CadenceEqualizerWidgetOptions extends AnimatedWidgetOptions {
	state: CadenceEqualizerState;
	theme: CadenceEqualizerTheme;
	/** Sample the live tok/s rate at a given wall-clock (epoch ms) reading. `null` when nothing is streaming. */
	sampleRate(wallNowMs: number): number | null;
	/** Wall clock (epoch ms) — distinct from the shared `AnimationHost`'s relative elapsed-ms, mirroring Token Tide. Injectable for tests. */
	wallClock: { now(): number };
}

/**
 * Ambient widget for the multi-band token-throughput equalizer. Each frame
 * it samples the live tok/s rate (via {@link CadenceEqualizerWidgetOptions.sampleRate},
 * reusing the existing `token-rate.ts` provider — never recomputed here)
 * into the shared {@link CadenceEqualizerState}, then renders a pure
 * function of that state. The {@link AnimatedWidget} base owns the
 * subscribe-on-mount / unsubscribe-on-dispose lifecycle.
 */
export class CadenceEqualizerWidget extends AnimatedWidget {
	#state: CadenceEqualizerState;
	#theme: CadenceEqualizerTheme;
	#policy: MotionPolicy;
	#sampleRate: (wallNowMs: number) => number | null;
	#wallClock: { now(): number };

	constructor(options: CadenceEqualizerWidgetOptions) {
		super(options);
		this.#state = options.state;
		this.#theme = options.theme;
		this.#policy = options.policy;
		this.#sampleRate = options.sampleRate;
		this.#wallClock = options.wallClock;
	}

	override onFrame(_elapsedMs: number): void {
		const rate = this.#sampleRate(this.#wallClock.now());
		this.#state.pushSample(normalizeAmplitude(rate ?? 0));
	}

	renderFrame(_width: number): readonly string[] {
		if (this.#policy.tier === "full") {
			return [renderEqualizerRow(this.#state.snapshotBands(), this.#state.snapshotPeaks(), this.#theme)];
		}
		return [renderCompactEqualizer(this.#state.snapshotBands(), this.#theme)];
	}
}
