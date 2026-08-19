import { describe, expect, it } from "bun:test";
import { BAND_ALPHAS, BAND_COUNT, stepBand, stepPeak } from "../src/cadence-equalizer/bars";
import {
	type CadenceEqualizerTheme,
	renderCompactEqualizer,
	renderEqualizerRow,
	renderEqualizerText,
} from "../src/cadence-equalizer/render";
import {
	BUCKET_THEME_COLOR,
	MAX_REFERENCE_RATE,
	normalizeAmplitude,
	rateBucket,
	waveGlyph,
} from "../src/cadence-equalizer/scale";
import { CadenceEqualizerState } from "../src/cadence-equalizer/state";

// Identity theme so assertions see plain text instead of ANSI escapes.
const idTheme: CadenceEqualizerTheme = { fg: (_color, text) => text };
// Color-tagging theme for tests that need to assert which bucket colored a glyph.
const taggedTheme: CadenceEqualizerTheme = { fg: (color, text) => `${color}:${text}` };

describe("cadence equalizer band math (pure)", () => {
	it("stepBand eases toward the target and never overshoots", () => {
		let value = 0;
		for (let i = 0; i < 200; i++) value = stepBand(value, 1, 0.1);
		expect(value).toBeCloseTo(1, 5);
		expect(value).toBeLessThanOrEqual(1);
	});

	it("stepBand clamps out-of-range inputs to [0, 1]", () => {
		expect(stepBand(-5, 1, 0.5)).toBeGreaterThanOrEqual(0);
		expect(stepBand(2, 1, 0.5)).toBeLessThanOrEqual(1);
		expect(stepBand(0.5, Number.NaN, 0.5)).toBe(0.25); // NaN target clamps to 0
	});

	it("a higher alpha reacts to a step target strictly faster than a lower alpha", () => {
		const fast = stepBand(0, 1, 0.55);
		const slow = stepBand(0, 1, 0.05);
		expect(fast).toBeGreaterThan(slow);
	});

	it("stepPeak snaps up instantly to a new high and decays linearly otherwise", () => {
		expect(stepPeak(0, 0.6, 0.02)).toBe(0.6);
		expect(stepPeak(0.6, 0.1, 0.02)).toBeCloseTo(0.58, 10);
		expect(stepPeak(0.6, 0.9, 0.02)).toBe(0.9); // new high overrides decay
	});

	it("stepPeak never decays below the current amplitude (it's a hold, not a free fall)", () => {
		let peak = 1;
		const current = 0.5;
		for (let i = 0; i < 50; i++) peak = stepPeak(peak, current, 0.02);
		expect(peak).toBeGreaterThanOrEqual(current);
	});

	it("BAND_ALPHAS is fastest-first, matching BAND_COUNT in length", () => {
		expect(BAND_ALPHAS).toHaveLength(BAND_COUNT);
		const sorted = [...BAND_ALPHAS].sort((a, b) => b - a);
		expect(BAND_ALPHAS).toEqual(sorted);
	});
});

describe("cadence equalizer scale (pure)", () => {
	it("normalizeAmplitude clamps to [0, 1] and saturates at MAX_REFERENCE_RATE", () => {
		expect(normalizeAmplitude(0)).toBe(0);
		expect(normalizeAmplitude(-5)).toBe(0);
		expect(normalizeAmplitude(Number.NaN)).toBe(0);
		expect(normalizeAmplitude(Infinity)).toBe(0);
		expect(normalizeAmplitude(MAX_REFERENCE_RATE / 2)).toBeCloseTo(0.5, 10);
		expect(normalizeAmplitude(MAX_REFERENCE_RATE)).toBe(1);
		expect(normalizeAmplitude(MAX_REFERENCE_RATE * 4)).toBe(1);
	});

	it("normalizeAmplitude is monotonic non-decreasing in the rate", () => {
		let previous = -1;
		for (const rate of [0, 1, 20, 60, 120, MAX_REFERENCE_RATE, MAX_REFERENCE_RATE + 100]) {
			const amplitude = normalizeAmplitude(rate);
			expect(amplitude).toBeGreaterThanOrEqual(previous);
			previous = amplitude;
		}
	});

	it("rateBucket walks the cool-to-hot ramp at its documented ceilings", () => {
		expect(rateBucket(0)).toBe("idle");
		expect(rateBucket(-1)).toBe("idle");
		expect(rateBucket(Number.NaN)).toBe("idle");
		expect(rateBucket(20)).toBe("low");
		expect(rateBucket(20.5)).toBe("medium");
		expect(rateBucket(60)).toBe("medium");
		expect(rateBucket(61)).toBe("high");
		expect(rateBucket(120)).toBe("high");
		expect(rateBucket(121)).toBe("burst");
	});

	it("BUCKET_THEME_COLOR carries one distinct theme color per bucket the box can render", () => {
		const buckets = [0, 10, 40, 100, 200].map(rateBucket);
		expect(new Set(buckets).size).toBe(5);
		for (const bucket of buckets) expect(typeof BUCKET_THEME_COLOR[bucket]).toBe("string");
	});

	it("waveGlyph spans the whole block ramp and clamps out-of-range amplitudes", () => {
		expect(waveGlyph(0)).toBe(" ");
		expect(waveGlyph(-1)).toBe(" ");
		expect(waveGlyph(1)).toBe("█");
		expect(waveGlyph(2)).toBe("█");
	});
});

describe("cadence equalizer state", () => {
	it("starts all bands and peaks at zero", () => {
		const state = new CadenceEqualizerState();
		expect(state.bandCount).toBe(BAND_COUNT);
		expect(state.snapshotBands()).toEqual(new Array(BAND_COUNT).fill(0));
		expect(state.snapshotPeaks()).toEqual(new Array(BAND_COUNT).fill(0));
	});

	it("pushSample coerces non-finite or negative targets to idle (0)", () => {
		const state = new CadenceEqualizerState();
		state.pushSample(1);
		const afterOne = state.snapshotBands();
		state.pushSample(Number.NaN);
		state.pushSample(-5);
		// Idle pushes should only ever ease bands down, never up or to something invalid.
		const after = state.snapshotBands();
		for (let i = 0; i < after.length; i++) {
			expect(after[i]).toBeLessThanOrEqual(afterOne[i]);
			expect(Number.isFinite(after[i])).toBe(true);
		}
	});

	it("snapshots are immutable copies — mutating one does not affect the next read", () => {
		const state = new CadenceEqualizerState();
		state.pushSample(1);
		const snap = state.snapshotBands() as number[];
		snap[0] = 999;
		expect(state.snapshotBands()[0]).not.toBe(999);
	});

	it("a sustained loud signal saturates every band toward 1, fast bands first", () => {
		const state = new CadenceEqualizerState();
		for (let i = 0; i < 5; i++) state.pushSample(1);
		const early = state.snapshotBands();
		for (let i = 0; i < 200; i++) state.pushSample(1);
		const saturated = state.snapshotBands();
		for (const v of saturated) expect(v).toBeCloseTo(1, 3);
		// Early on, the fast band should already be further along than the slow band.
		expect(early[0]).toBeGreaterThan(early[early.length - 1]);
	});
});

describe("cadence equalizer rendering (pure)", () => {
	it("renderEqualizerRow is byte-stable across repeated calls with the same snapshot", () => {
		const bands = [0.9, 0.6, 0.3, 0.1, 0];
		const peaks = [0.9, 0.6, 0.3, 0.1, 0];
		const first = renderEqualizerRow(bands, peaks, idTheme);
		const second = renderEqualizerRow(bands, peaks, idTheme);
		expect(first).toEqual(second);
	});

	it("renders one amplitude glyph plus a peak-cap column per band", () => {
		const bands = [1, 0, 0, 0, 0];
		const peaks = [1, 0, 0, 0, 0];
		const row = renderEqualizerRow(bands, peaks, idTheme, undefined, "ascii");
		expect(row).toContain(waveGlyph(1));
	});

	it("shows a peak cap only once the band has decayed meaningfully below its held peak", () => {
		// The peak cap is colored with BUCKET_THEME_COLOR.burst ("warning"), so absence/presence
		// of "warning:‾" tracks whether the cap glyph itself rendered.
		const noCap = renderEqualizerRow([0.5], [0.5], taggedTheme, undefined, "ascii");
		expect(noCap).not.toContain("warning:‾");
		const withCap = renderEqualizerRow([0.3], [0.9], taggedTheme, undefined, "ascii");
		expect(withCap).toContain("warning:‾");
	});

	it("colors each band by its amplitude bucket, matching the projected tok/s palette", () => {
		const row = renderEqualizerRow([1], [1], taggedTheme, undefined, "ascii");
		// amplitude 1 * MAX_REFERENCE_RATE sits in the burst bucket, themed "warning".
		expect(row).toContain(`${waveGlyph(1)}`);
		expect(row).toMatch(/warning:.$/);
	});

	it("renderCompactEqualizer concatenates one glyph per band with no separators or peak caps", () => {
		const bands = [1, 1, 1, 1, 1];
		const compact = renderCompactEqualizer(bands, idTheme);
		expect(compact).toBe(waveGlyph(1).repeat(5));
	});

	it("renderEqualizerText formats a positive rate and falls back to idle text otherwise", () => {
		expect(renderEqualizerText(142)).toBe("eq 142 tok/s");
		expect(renderEqualizerText(141.6)).toBe("eq 142 tok/s");
		expect(renderEqualizerText(0)).toBe("eq --");
		expect(renderEqualizerText(null)).toBe("eq --");
		expect(renderEqualizerText(-5)).toBe("eq --");
	});
});

describe("cadence equalizer hardening: adversarial pure math", () => {
	it("stepPeak clamps to [0, 1] even when decayPerFrame is non-finite (real bug: Math.max propagated NaN/Infinity unclamped)", () => {
		// Math.max(x, NaN) is NaN regardless of argument order, and Math.max(x, Infinity) is Infinity --
		// stepPeak's final line used to return that raw Math.max result with no clamp, violating its own
		// "Pure; clamps to [0, 1]" contract whenever a caller (or an adversarial constructor option) fed it
		// a non-finite decayPerFrame. clamp01 treats every non-finite value (NaN *and* +-Infinity) as
		// invalid and maps it to 0 (not a sign-aware clamp to the boundary), so both a NaN and a
		// -Infinity decayPerFrame now resolve to a safe 0 instead of escaping unclamped.
		expect(stepPeak(0.5, 0.3, Number.NaN)).toBe(0);
		expect(stepPeak(0.5, 0.3, -Infinity)).toBe(0);
		expect(stepPeak(0.5, 0.3, Infinity)).toBe(0.3); // decays instantly to current -- already correct pre-fix
		expect(Number.isFinite(stepPeak(0.5, 0.3, Number.NaN))).toBe(true);
		expect(Number.isFinite(stepPeak(0.5, 0.3, -Infinity))).toBe(true);
	});

	it("stepPeak clamps a non-finite prevPeak or currentAmplitude to [0, 1]", () => {
		// clamp01 maps any non-finite prevPeak (NaN or +-Infinity alike) to 0, so it never out-holds
		// currentAmplitude -- the peak-hold marker degrades to "no held peak" rather than a bogus extreme.
		expect(stepPeak(Number.NaN, 0.4, 0.02)).toBe(0.4);
		expect(stepPeak(Infinity, 0.4, 0.02)).toBe(0.4);
		expect(stepPeak(-Infinity, 0.4, 0.02)).toBe(0.4);
		expect(stepPeak(0.4, Number.NaN, 0.02)).toBeGreaterThanOrEqual(0); // NaN current clamps to 0, decay from 0.4 wins
	});

	it("stepBand degrades a non-finite alpha to a safe [0, 1] result rather than propagating it", () => {
		// prev + (target - prev) * alpha: a non-finite alpha turns the whole sum non-finite, which
		// stepBand's own clamp01 catches -- and since clamp01 maps every non-finite value (including
		// +Infinity) to 0, an infinite-alpha step bottoms out at 0 regardless of step direction.
		expect(stepBand(0.5, 0.3, Number.NaN)).toBe(0);
		expect(stepBand(0.5, 0.9, Infinity)).toBe(0);
		expect(stepBand(0.5, 0.1, Infinity)).toBe(0);
		for (const alpha of [Number.NaN, Infinity, -Infinity]) {
			const result = stepBand(0.5, 0.3, alpha);
			expect(Number.isFinite(result)).toBe(true);
			expect(result).toBeGreaterThanOrEqual(0);
			expect(result).toBeLessThanOrEqual(1);
		}
	});
});

describe("cadence equalizer hardening: state edge cases", () => {
	it("pushSample(Infinity) coerces to idle, not saturation (Infinity is not finite)", () => {
		const state = new CadenceEqualizerState();
		state.pushSample(Infinity);
		for (const v of state.snapshotBands()) expect(v).toBe(0);
	});

	it("an adversarial NaN peakDecayPerFrame injected at construction stays clamped in [0, 1] band after band (post-fix regression guard)", () => {
		const state = new CadenceEqualizerState({ peakDecayPerFrame: Number.NaN });
		for (let i = 0; i < 10; i++) state.pushSample(1);
		for (const p of state.snapshotPeaks()) {
			expect(Number.isFinite(p)).toBe(true);
			expect(p).toBeGreaterThanOrEqual(0);
			expect(p).toBeLessThanOrEqual(1);
		}
	});

	it("bandCount reflects a custom alphas array length, not the BAND_COUNT constant", () => {
		const state = new CadenceEqualizerState({ alphas: [0.5, 0.5, 0.5] });
		expect(state.bandCount).toBe(3);
		expect(state.snapshotBands()).toHaveLength(3);
		expect(state.snapshotPeaks()).toHaveLength(3);
	});

	it("an empty alphas array degrades to zero bands with no crash", () => {
		const state = new CadenceEqualizerState({ alphas: [] });
		expect(state.bandCount).toBe(0);
		state.pushSample(1);
		expect(state.snapshotBands()).toEqual([]);
		expect(state.snapshotPeaks()).toEqual([]);
	});
});

describe("cadence equalizer hardening: rendering edge cases", () => {
	it('never renders the literal string "undefined" for adversarial NaN/Infinity band or peak values', () => {
		const bands = [Number.NaN, Infinity, -Infinity, 0.5, Number.NaN];
		const peaks = [Number.NaN, Infinity, -Infinity, 0.5, Number.NaN];
		const row = renderEqualizerRow(bands, peaks, idTheme);
		const compact = renderCompactEqualizer(bands, idTheme);
		expect(row).not.toContain("undefined");
		expect(row).not.toContain("NaN");
		expect(compact).not.toContain("undefined");
		expect(compact).not.toContain("NaN");
	});

	it("renderEqualizerRow tolerates a peaks array shorter than bands (missing entries fall back to 0)", () => {
		const bands = [0.5, 0.5, 0.5];
		const row = renderEqualizerRow(bands, [0.5], idTheme);
		expect(row).not.toContain("undefined");
		// Bands beyond the peaks array read a 0 peak, so their gap (0 - amplitude) never clears the cap threshold.
		expect(row.match(/‾/g)?.length ?? 0).toBe(0);
	});

	it("renderEqualizerText treats NaN and -Infinity the same as idle", () => {
		expect(renderEqualizerText(Number.NaN)).toBe("eq --");
		expect(renderEqualizerText(-Infinity)).toBe("eq --");
		expect(renderEqualizerText(Infinity)).toBe("eq --");
	});
});
