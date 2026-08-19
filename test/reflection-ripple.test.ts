import { describe, expect, it } from "bun:test";
import { type ReflectionRippleTheme, renderReflectionRippleRow } from "../src/reflection-ripple/render";
import {
	DIM_DURATION_MS,
	dimMultiplier,
	RIPPLE_DURATION_MS,
	reflectDimAmount,
	ringGlyph,
	rippleBrightness,
	rippleProgress,
	rippleRadius,
} from "../src/reflection-ripple/ripple";
import { ReflectionRippleState } from "../src/reflection-ripple/state";

// Identity theme so assertions see plain text instead of ANSI escapes.
const idTheme: ReflectionRippleTheme = { fg: (_color, text) => text };
// Color-tagging theme for tests that need to assert which token the renderer chose.
const taggedTheme: ReflectionRippleTheme = { fg: (color, text) => `${color}:${text}` };

describe("reflection ripple pure math", () => {
	it("rippleProgress is 0 at the start, 1 at the boundary, and clamps beyond", () => {
		expect(rippleProgress(0, 1000)).toBe(0);
		expect(rippleProgress(500, 1000)).toBe(0.5);
		expect(rippleProgress(1000, 1000)).toBe(1);
		expect(rippleProgress(5000, 1000)).toBe(1);
		expect(rippleProgress(-100, 1000)).toBe(0);
	});

	it("rippleRadius is 0 at progress 0, maxRadius at progress 1, and monotonic non-decreasing between", () => {
		expect(rippleRadius(0, 10)).toBe(0);
		expect(rippleRadius(1, 10)).toBeCloseTo(10, 5);
		const samples = Array.from({ length: 11 }, (_, i) => rippleRadius(i / 10, 10));
		for (let i = 1; i < samples.length; i++) {
			expect(samples[i]).toBeGreaterThanOrEqual(samples[i - 1] - 1e-9);
		}
	});

	it("rippleRadius decelerates: the first half of progress covers more distance than the second half", () => {
		const firstHalf = rippleRadius(0.5, 10) - rippleRadius(0, 10);
		const secondHalf = rippleRadius(1, 10) - rippleRadius(0.5, 10);
		expect(firstHalf).toBeGreaterThan(secondHalf);
	});

	it("rippleBrightness is 1 at birth, 0 at full expansion, and monotonically non-increasing", () => {
		expect(rippleBrightness(0)).toBe(1);
		expect(rippleBrightness(1)).toBe(0);
		const samples = Array.from({ length: 11 }, (_, i) => rippleBrightness(i / 10));
		for (let i = 1; i < samples.length; i++) {
			expect(samples[i]).toBeLessThanOrEqual(samples[i - 1] + 1e-9);
		}
	});

	it("ringGlyph maps low brightness to a fainter glyph than high brightness", () => {
		expect(ringGlyph(0)).toBe(" ");
		expect(ringGlyph(1)).toBe("◉");
		expect(ringGlyph(0.1)).not.toBe(ringGlyph(0.9));
	});

	it("ringGlyph defaults to unicode; ascii substitutes are exact one-column values distinct across the ramp", () => {
		expect(ringGlyph(0, "unicode")).toBe(ringGlyph(0));
		expect(ringGlyph(0, "ascii")).toBe(" ");
		expect(ringGlyph(1, "ascii")).toBe("@");
		const ramp = [0, 0.25, 0.5, 0.75, 1].map(b => ringGlyph(b, "ascii"));
		expect(new Set(ramp).size).toBe(ramp.length);
		for (const glyph of ramp) {
			expect(glyph).toHaveLength(1);
			expect(glyph.charCodeAt(0)).toBeLessThan(128);
		}
	});

	it("ringGlyph's nerd preset aliases unicode exactly", () => {
		for (const b of [0, 0.25, 0.5, 0.75, 1]) {
			expect(ringGlyph(b, "nerd")).toBe(ringGlyph(b, "unicode"));
		}
	});

	it("reflectDimAmount peaks immediately at the trigger and eases back to 0 by the duration, monotonically", () => {
		expect(reflectDimAmount(0, DIM_DURATION_MS)).toBeCloseTo(1, 5);
		expect(reflectDimAmount(DIM_DURATION_MS, DIM_DURATION_MS)).toBe(0);
		expect(reflectDimAmount(DIM_DURATION_MS + 500, DIM_DURATION_MS)).toBe(0);
		const samples = Array.from({ length: 10 }, (_, i) =>
			reflectDimAmount((i * DIM_DURATION_MS) / 10, DIM_DURATION_MS),
		);
		for (let i = 1; i < samples.length; i++) {
			expect(samples[i]).toBeLessThanOrEqual(samples[i - 1] + 1e-9);
		}
	});

	it("dimMultiplier pulls brightness down at dimAmount 1 and leaves it untouched at 0, monotonically", () => {
		expect(dimMultiplier(0)).toBe(1);
		expect(dimMultiplier(1)).toBeCloseTo(0.35, 5);
		const samples = Array.from({ length: 6 }, (_, i) => dimMultiplier(i / 5));
		for (let i = 1; i < samples.length; i++) {
			expect(samples[i]).toBeLessThanOrEqual(samples[i - 1] + 1e-9);
		}
	});
});

describe("reflection ripple pure math edge cases", () => {
	it("rippleProgress guards non-finite inputs: NaN durationMs/elapsedMs don't crash", () => {
		expect(rippleProgress(500, Number.NaN)).toBeNaN();
		expect(rippleProgress(Number.NaN, 1000)).toBeNaN();
		expect(rippleProgress(Number.POSITIVE_INFINITY, 1000)).toBe(1);
		expect(rippleProgress(500, -100)).toBe(1); // durationMs <= 0 short-circuits to fully-faded
	});

	it("rippleRadius clamps a negative maxRadius to 0 rather than a negative distance", () => {
		expect(rippleRadius(0.5, -10)).toBe(0);
		expect(rippleRadius(0.5, 0)).toBe(0);
	});

	it("rippleRadius(NaN, ...) and rippleBrightness(NaN) propagate NaN rather than throwing", () => {
		expect(rippleRadius(Number.NaN, 10)).toBeNaN();
		expect(rippleBrightness(Number.NaN)).toBeNaN();
		expect(rippleBrightness(Number.POSITIVE_INFINITY)).toBe(0); // clamped to progress=1, fully faded
	});

	it("ringGlyph(NaN) falls back to the faintest glyph instead of returning undefined (regression)", () => {
		expect(ringGlyph(Number.NaN)).toBe(" ");
		expect(ringGlyph(Number.POSITIVE_INFINITY)).toBe("◉"); // clamps to brightness 1
		expect(ringGlyph(Number.NEGATIVE_INFINITY)).toBe(" "); // clamps to brightness 0
	});

	it("reflectDimAmount(NaN, ...) propagates NaN rather than throwing; negative durationMs reads as settled", () => {
		expect(reflectDimAmount(Number.NaN, DIM_DURATION_MS)).toBeNaN();
		expect(reflectDimAmount(500, -1)).toBe(0);
	});

	it("dimMultiplier(NaN) propagates NaN rather than clamping to a safe multiplier", () => {
		expect(dimMultiplier(Number.NaN)).toBeNaN();
		expect(dimMultiplier(-5)).toBe(1); // clamped to dimAmount 0, untouched brightness
		expect(dimMultiplier(Number.POSITIVE_INFINITY)).toBeCloseTo(0.35, 5); // clamped to dimAmount 1
	});
});

describe("reflection ripple pure rendering", () => {
	it("at birth (elapsedMs 0), full tier draws a single centered glyph — the wave hasn't expanded yet", () => {
		const row = renderReflectionRippleRow(0, 11, taggedTheme, "full");
		const brightness = rippleBrightness(0) * dimMultiplier(1);
		const glyph = ringGlyph(brightness);
		const expected = `${"dim: ".repeat(5)}accent:${glyph}${"dim: ".repeat(5)}`;
		expect(row).toBe(expected);
	});

	it("full tier: the wavefront's two positions move outward from center as elapsedMs advances", () => {
		const width = 21;
		const early = renderReflectionRippleRow(50, width, taggedTheme, "full");
		const later = renderReflectionRippleRow(RIPPLE_DURATION_MS / 2, width, taggedTheme, "full");
		expect(early).not.toBe(later);
		// The glyph should not still be dead-center once the wave has traveled.
		const center = Math.floor(width / 2);
		const radius = Math.round(rippleRadius(rippleProgress(RIPPLE_DURATION_MS / 2, RIPPLE_DURATION_MS), center));
		expect(radius).toBeGreaterThan(0);
	});

	it("subtle tier: a single centered pulse over calm water, position fixed regardless of elapsedMs", () => {
		const width = 11;
		const t1 = renderReflectionRippleRow(0, width, taggedTheme, "subtle");
		const t2 = renderReflectionRippleRow(RIPPLE_DURATION_MS / 2, width, taggedTheme, "subtle");
		const centerToken = "accent:";
		expect(t1.includes(centerToken)).toBe(true);
		expect(t2.includes(centerToken)).toBe(true);
		// Exactly one glyph carries the accent token, always at the same offset in the string.
		expect(t1.indexOf(centerToken)).toBe(t2.indexOf(centerToken));
	});

	it("subtle tier at width 1 renders a single glyph with no background", () => {
		const row = renderReflectionRippleRow(0, 1, taggedTheme, "subtle");
		expect(row.startsWith("accent:")).toBe(true);
	});

	it("threads a live preset into the ring glyph — not just the default", () => {
		const brightness = rippleBrightness(0) * dimMultiplier(1);
		const row = renderReflectionRippleRow(0, 1, idTheme, "subtle", undefined, "ascii");
		expect(row).toBe(ringGlyph(brightness, "ascii"));
		expect(row).not.toBe(ringGlyph(brightness, "unicode"));
	});

	it("width <= 0 renders an empty row", () => {
		expect(renderReflectionRippleRow(500, 0, taggedTheme, "full")).toBe("");
	});

	it("a NaN elapsedMs (e.g. a poisoned clock read) never renders the literal string 'undefined'", () => {
		const full = renderReflectionRippleRow(Number.NaN, 21, taggedTheme, "full");
		const subtle = renderReflectionRippleRow(Number.NaN, 21, taggedTheme, "subtle");
		expect(full).not.toContain("undefined");
		expect(subtle).not.toContain("undefined");
	});

	it("negative width renders an empty row, matching the width <= 0 guard", () => {
		expect(renderReflectionRippleRow(500, -5, taggedTheme, "full")).toBe("");
	});
});

describe("ReflectionRippleState", () => {
	it("starts idle and a trigger moves it to rippling, tracking rule names and a running trigger count", () => {
		const state = new ReflectionRippleState();
		expect(state.phase).toBe("idle");
		expect(state.snapshot()).toEqual({ phase: "idle", ruleNames: [], triggerCount: 0 });

		state.applyTrigger(["no-console-log"], 1000);
		expect(state.phase).toBe("rippling");
		expect(state.snapshot()).toEqual({ phase: "rippling", ruleNames: ["no-console-log"], triggerCount: 1 });
		expect(state.rippleElapsedMs(1500)).toBe(500);
	});

	it("settleIfDone flips to idle exactly at the settle boundary and only fires once", () => {
		const state = new ReflectionRippleState();
		state.applyTrigger(["r"], 0);
		const settleMs = Math.max(RIPPLE_DURATION_MS, DIM_DURATION_MS);

		expect(state.settleIfDone(settleMs - 1)).toBe(false);
		expect(state.phase).toBe("rippling");

		expect(state.settleIfDone(settleMs)).toBe(true);
		expect(state.phase).toBe("idle");
		expect(state.settleIfDone(settleMs + 500)).toBe(false);
	});

	it("a fresh trigger while still rippling restarts the wave and updates the rule names", () => {
		const state = new ReflectionRippleState();
		state.applyTrigger(["first"], 0);
		state.applyTrigger(["second"], 400);
		expect(state.phase).toBe("rippling");
		expect(state.snapshot().ruleNames).toEqual(["second"]);
		expect(state.snapshot().triggerCount).toBe(2);
		expect(state.rippleElapsedMs(500)).toBe(100);
	});

	it("settleIfDone on an already-idle state is a no-op", () => {
		const state = new ReflectionRippleState();
		expect(state.settleIfDone(10_000)).toBe(false);
	});

	it("rippleElapsedMs clamps backward clock skew (now before triggeredAt) to 0, not a negative value", () => {
		const state = new ReflectionRippleState();
		state.applyTrigger(["r"], 1000);
		expect(state.rippleElapsedMs(400)).toBe(0);
	});

	it("a NaN clock read at trigger time poisons rippleElapsedMs, causing settleIfDone to fire on the very next check (NaN < SETTLE_MS is false, so the early-return guard never catches it)", () => {
		const state = new ReflectionRippleState();
		state.applyTrigger(["r"], Number.NaN);
		expect(state.rippleElapsedMs(10_000)).toBeNaN();
		expect(state.settleIfDone(10_000)).toBe(true);
		expect(state.phase).toBe("idle");
	});

	it("applyTrigger accepts an empty rule-names array without throwing", () => {
		const state = new ReflectionRippleState();
		state.applyTrigger([], 0);
		expect(state.snapshot().ruleNames).toEqual([]);
		expect(state.phase).toBe("rippling");
	});
});
