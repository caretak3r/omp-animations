import { BAND_ALPHAS, BAND_COUNT, PEAK_DECAY_PER_FRAME, stepBand, stepPeak } from "./bars";

/**
 * Mutable, session-scoped model of the equalizer's bands and their
 * peak-hold markers. Fixed length ({@link BAND_COUNT}) for the state's
 * lifetime, zero-initialized. Mutation happens only in {@link pushSample},
 * driven by the widget's per-frame sampling; rendering reads immutable
 * snapshots.
 */
export class CadenceEqualizerState {
	#bands: number[];
	#peaks: number[];
	#alphas: readonly number[];
	#peakDecayPerFrame: number;

	constructor(options: { alphas?: readonly number[]; peakDecayPerFrame?: number } = {}) {
		this.#alphas = options.alphas ?? BAND_ALPHAS;
		this.#peakDecayPerFrame = options.peakDecayPerFrame ?? PEAK_DECAY_PER_FRAME;
		this.#bands = new Array(this.#alphas.length).fill(0);
		this.#peaks = new Array(this.#alphas.length).fill(0);
	}

	/** Number of bands (fixed for the state's lifetime). */
	get bandCount(): number {
		return this.#alphas.length;
	}

	/**
	 * Step every band/peak one frame toward a normalized `[0, 1]` amplitude reading. Non-finite/negative
	 * coerces to `0` (idle). Steps `#bands`/`#peaks` in place via the same pure per-band {@link stepBand}/
	 * {@link stepPeak} math {@link stepBands} uses, instead of calling `stepBands` (which allocates two
	 * fresh arrays via `.map()` every call) — this runs once per animation frame, so avoiding that pair of
	 * throwaway allocations here is the actual hot-path win; `stepBands` itself stays untouched (and pure/
	 * non-mutating, per its own tests) as the array-level convenience API.
	 */
	pushSample(targetAmplitude: number): void {
		const target = Number.isFinite(targetAmplitude) && targetAmplitude > 0 ? targetAmplitude : 0;
		for (let i = 0; i < this.#bands.length; i++) {
			const band = stepBand(this.#bands[i] ?? 0, target, this.#alphas[i] ?? 0);
			this.#bands[i] = band;
			this.#peaks[i] = stepPeak(this.#peaks[i] ?? 0, band, this.#peakDecayPerFrame);
		}
	}

	/** Immutable snapshot of current band amplitudes, `[0, 1]` each — a defensive copy so mutating it never corrupts state. */
	snapshotBands(): readonly number[] {
		return [...this.#bands];
	}

	/** Immutable snapshot of current peak-hold markers, `[0, 1]` each — a defensive copy so mutating it never corrupts state. */
	snapshotPeaks(): readonly number[] {
		return [...this.#peaks];
	}
}
