import type { SymbolPreset, Theme, ThemeColor } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { AnimatedWidgetOptions, MotionPolicy } from "../kit";
import { AnimatedWidget } from "../kit";
import { renderSparkline } from "../render-sparkline";
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

/** Bucket -> color lookup, one slot per {@link RateBucket}. */
export type CadenceEqualizerColors = Readonly<Record<RateBucket, ThemeColor>>;

/**
 * The palette with the accent slot applied: `burst` — the hottest bucket and
 * the peak-hold cap's color — is the only overridable token, mirroring
 * Palimpsest's ember-only override; every other bucket keeps its fixed
 * cool-to-warm ramp position. `undefined` keeps the built-in burst color.
 */
export function cadenceEqualizerColors(accentColor?: ThemeColor): CadenceEqualizerColors {
	return accentColor === undefined ? BUCKET_THEME_COLOR : { ...BUCKET_THEME_COLOR, burst: accentColor };
}

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
 *
 * For `unicode`/`nerd` presets, the trailing trend uses braille sparklines
 * (2 samples per character, 5 height levels). For `ascii`, the trend uses
 * the original vertical block ramp (1 sample per character, 9 height levels).
 */
export function renderEqualizerRow(
	bands: readonly number[],
	peaks: readonly number[],
	theme: CadenceEqualizerTheme,
	colors: CadenceEqualizerColors = BUCKET_THEME_COLOR,
	preset: SymbolPreset = "unicode",
): string {
	// The trailing trend column uses either braille sparklines (unicode/nerd)
	// or the original block glyphs (ascii).
	if (preset === "ascii") {
		// ASCII preset: original block-glyph equalizer (1 glyph per band).
		const parts: string[] = [];
		for (let i = 0; i < bands.length; i++) {
			if (i > 0) parts.push(" ");
			const amplitude = bands[i] ?? 0;
			const peak = peaks[i] ?? 0;
			const color = colors[bandColor(amplitude)];
			const showPeakCap = peak - amplitude >= PEAK_VISIBLE_GAP;
			parts.push(showPeakCap ? theme.fg(colors.burst, "‾") : theme.fg("dim", " "));
			parts.push(theme.fg(color, waveGlyph(amplitude)));
		}
		return parts.join("");
	}

	// Unicode/nerd preset: braille sparkline (2 samples per character, no peak caps).
	// The sparkline width is roughly half the band count (each braille char encodes 2 samples).
	const sparkline = renderSparkline(bands, Math.ceil(bands.length / 2) + 2, 1.0);
	// Color the sparkline uniformly by the current dominant color (the hottest active band).
	let dominantColor: ThemeColor = colors.idle;
	for (const amplitude of bands) {
		const color = colors[bandColor(amplitude)];
		// Warming priority: idle < low < medium < high < burst.
		if (color === colors.burst) {
			dominantColor = colors.burst;
			break;
		}
		if (color === colors.high && dominantColor !== colors.burst) {
			dominantColor = colors.high;
		} else if (color === colors.medium && dominantColor !== colors.burst && dominantColor !== colors.high) {
			dominantColor = colors.medium;
		} else if (color === colors.low && dominantColor === colors.idle) {
			dominantColor = colors.low;
		}
	}
	return theme.fg(dominantColor, sparkline);
}

/**
 * Pure renderer: the `subtle`-tier equalizer — the same per-band amplitude
 * glyphs with no peak caps or spacing, a compact strip that fits a
 * status-line-sized slot. Deterministic given `bands` alone.
 */
export function renderCompactEqualizer(
	bands: readonly number[],
	theme: CadenceEqualizerTheme,
	colors: CadenceEqualizerColors = BUCKET_THEME_COLOR,
): string {
	return bands.map(amplitude => theme.fg(colors[bandColor(amplitude)], waveGlyph(amplitude))).join("");
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
	/** Accent override for the primary accent slot (the burst bucket); `undefined` keeps the built-in palette. */
	accentColor?: ThemeColor;
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
	#colors: CadenceEqualizerColors;

	constructor(options: CadenceEqualizerWidgetOptions) {
		super(options);
		this.#state = options.state;
		this.#theme = options.theme;
		this.#policy = options.policy;
		this.#sampleRate = options.sampleRate;
		this.#wallClock = options.wallClock;
		this.#colors = cadenceEqualizerColors(options.accentColor);
	}

	override onFrame(_elapsedMs: number): void {
		const rate = this.#sampleRate(this.#wallClock.now());
		this.#state.pushSample(normalizeAmplitude(rate ?? 0));
	}

	renderFrame(_width: number): readonly string[] {
		if (this.#policy.tier === "full") {
			return [
				renderEqualizerRow(this.#state.snapshotBands(), this.#state.snapshotPeaks(), this.#theme, this.#colors),
			];
		}
		return [renderCompactEqualizer(this.#state.snapshotBands(), this.#theme, this.#colors)];
	}
}
