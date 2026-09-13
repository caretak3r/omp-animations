import { describe, expect, it } from "bun:test";
import {
	BASE_BREATH_PERIOD_MS,
	BreathingBorderState,
	borderGlossIntensity,
	breathEnvelope,
	breathPeriodMsForTurnDuration,
	brightnessToken,
	EXHALE_DURATION_MS,
	exhaleEnvelope,
	GLOSS_LAP_DURATION_MS,
	GLOSS_TRAIL_FRACTION,
	GLOSS_TRAIL_FRACTION_SUBTLE,
	glossLapProgress,
	MAX_BREATH_PERIOD_MS,
	MIN_BREATH_PERIOD_MS,
} from "../src/breathing-border";

describe("breathing border pure math", () => {
	it("breathEnvelope starts at 0, peaks mid-cycle, and returns to 0 at the boundary", () => {
		expect(breathEnvelope(0, BASE_BREATH_PERIOD_MS)).toBeCloseTo(0, 5);
		expect(breathEnvelope(BASE_BREATH_PERIOD_MS / 2, BASE_BREATH_PERIOD_MS)).toBeCloseTo(1, 5);
		expect(breathEnvelope(BASE_BREATH_PERIOD_MS, BASE_BREATH_PERIOD_MS)).toBeCloseTo(0, 5);
	});

	it("breathEnvelope wraps past one full period", () => {
		expect(breathEnvelope(BASE_BREATH_PERIOD_MS + 1, BASE_BREATH_PERIOD_MS)).toBeCloseTo(
			breathEnvelope(1, BASE_BREATH_PERIOD_MS),
			5,
		);
	});

	it("breathEnvelope is a smooth curve, not a strobe: never jumps straight from 0 to 1", () => {
		const samples = Array.from({ length: 20 }, (_, i) =>
			breathEnvelope((i * BASE_BREATH_PERIOD_MS) / 20, BASE_BREATH_PERIOD_MS),
		);
		for (let i = 1; i < samples.length; i++) {
			expect(Math.abs(samples[i] - samples[i - 1])).toBeLessThan(0.3);
		}
	});

	it("exhaleEnvelope decays from 1 to 0 over the fixed duration and clamps after", () => {
		expect(exhaleEnvelope(0, EXHALE_DURATION_MS)).toBeCloseTo(1, 5);
		expect(exhaleEnvelope(EXHALE_DURATION_MS / 2, EXHALE_DURATION_MS)).toBeCloseTo(0.5, 5);
		expect(exhaleEnvelope(EXHALE_DURATION_MS, EXHALE_DURATION_MS)).toBe(0);
		expect(exhaleEnvelope(EXHALE_DURATION_MS + 500, EXHALE_DURATION_MS)).toBe(0);
	});

	it("exhaleEnvelope is monotonically non-increasing", () => {
		const samples = Array.from({ length: 10 }, (_, i) =>
			exhaleEnvelope((i * EXHALE_DURATION_MS) / 10, EXHALE_DURATION_MS),
		);
		for (let i = 1; i < samples.length; i++) {
			expect(samples[i]).toBeLessThanOrEqual(samples[i - 1] + 1e-9);
		}
	});

	it("breathPeriodMsForTurnDuration resolves to the base period when no turn is known", () => {
		expect(breathPeriodMsForTurnDuration(undefined)).toBe(BASE_BREATH_PERIOD_MS);
		expect(breathPeriodMsForTurnDuration(0)).toBe(BASE_BREATH_PERIOD_MS);
		expect(breathPeriodMsForTurnDuration(-100)).toBe(BASE_BREATH_PERIOD_MS);
	});

	it("breathPeriodMsForTurnDuration clamps to the min/max cadence", () => {
		expect(breathPeriodMsForTurnDuration(1)).toBe(MIN_BREATH_PERIOD_MS);
		expect(breathPeriodMsForTurnDuration(100_000)).toBe(MAX_BREATH_PERIOD_MS);
	});

	it("glossLapProgress starts at top-left, reaches each corner, and loops at one fixed lap", () => {
		expect(glossLapProgress(0)).toBe(0);
		expect(glossLapProgress(GLOSS_LAP_DURATION_MS / 4)).toBe(0.25);
		expect(glossLapProgress(GLOSS_LAP_DURATION_MS / 2)).toBe(0.5);
		expect(glossLapProgress((GLOSS_LAP_DURATION_MS * 3) / 4)).toBe(0.75);
		expect(glossLapProgress(GLOSS_LAP_DURATION_MS)).toBe(0);
		expect(glossLapProgress(GLOSS_LAP_DURATION_MS * 1.25)).toBe(0.25);
	});

	it("glossLapProgress keeps fixed speed when turn duration changes the breath cadence", () => {
		expect(breathPeriodMsForTurnDuration(1)).not.toBe(breathPeriodMsForTurnDuration(100_000));
		expect(glossLapProgress(GLOSS_LAP_DURATION_MS / 3)).toBeCloseTo(1 / 3, 12);
	});

	it("borderGlossIntensity keeps a bright head, a short wrapped trail, and a resting majority", () => {
		const perimeterLength = 40;
		const intensities = Array.from({ length: perimeterLength }, (_, cellIndex) =>
			borderGlossIntensity(cellIndex, perimeterLength, 0, 0.8),
		);

		expect(intensities[0]).toBe(0.8);
		expect(intensities[39]).toBeGreaterThan(0);
		expect(intensities[39]).toBeLessThan(intensities[0]!);
		expect(intensities[38]).toBeGreaterThan(0);
		expect(intensities[1]).toBe(0);
		expect(intensities.filter(intensity => intensity === 0).length).toBeGreaterThan(32);
	});

	it("borderGlossIntensity clamps strength and malformed numeric inputs to finite output", () => {
		expect(borderGlossIntensity(0, 40, 0, 2)).toBe(1);
		expect(borderGlossIntensity(0, 40, 0, -1)).toBe(0);

		const malformed = [
			borderGlossIntensity(Number.NaN, 40, 0, 1),
			borderGlossIntensity(0, 0, 0, 1),
			borderGlossIntensity(0, Number.POSITIVE_INFINITY, 0, 1),
			borderGlossIntensity(0, 40, Number.NaN, 1),
			borderGlossIntensity(0, 40, 0, Number.NaN),
		];
		for (const intensity of malformed) {
			expect(Number.isFinite(intensity)).toBe(true);
			expect(intensity).toBeGreaterThanOrEqual(0);
			expect(intensity).toBeLessThanOrEqual(1);
		}
	});

	it("a wider trailFraction (subtle tier) lights more trailing cells than the default (full tier)", () => {
		const perimeterLength = 40;
		const countLit = (trailFraction: number) =>
			Array.from({ length: perimeterLength }, (_, cellIndex) =>
				borderGlossIntensity(cellIndex, perimeterLength, 0, 0.8, trailFraction),
			).filter(intensity => intensity > 0).length;

		const fullCount = countLit(GLOSS_TRAIL_FRACTION);
		const subtleCount = countLit(GLOSS_TRAIL_FRACTION_SUBTLE);

		expect(subtleCount).toBeGreaterThan(fullCount);
	});

	it("borderGlossIntensity falls back to the default trail width for a malformed trailFraction", () => {
		const perimeterLength = 40;
		const withDefault = borderGlossIntensity(38, perimeterLength, 0, 0.8);
		expect(borderGlossIntensity(38, perimeterLength, 0, 0.8, Number.NaN)).toBe(withDefault);
		expect(borderGlossIntensity(38, perimeterLength, 0, 0.8, 0)).toBe(withDefault);
		expect(borderGlossIntensity(38, perimeterLength, 0, 0.8, -1)).toBe(withDefault);
	});
});

describe("BreathingBorderState", () => {
	it("starts idle and agent_start moves it to active", () => {
		const state = new BreathingBorderState();
		expect(state.phase).toBe("idle");
		state.applyAgentStart(1000);
		expect(state.phase).toBe("active");
		expect(state.breathElapsedMs(1500)).toBe(500);
	});

	it("agent_start begins a fixed-speed gloss lap at top-left regardless of breath cadence", () => {
		const state = new BreathingBorderState();
		state.applyAgentStart(1000);

		expect(state.glossProgress(1000)).toBe(0);
		expect(state.glossProgress(1000 + GLOSS_LAP_DURATION_MS / 4)).toBe(0.25);

		state.applyTurnStart(1, 1000);
		state.applyTurnEnd(1, 1001);
		expect(state.breathPeriodMs()).toBe(MIN_BREATH_PERIOD_MS);
		expect(state.glossProgress(1000 + GLOSS_LAP_DURATION_MS / 2)).toBe(0.5);
	});

	it("agent_end from idle is a no-op (nothing to wind down)", () => {
		const state = new BreathingBorderState();
		state.applyAgentEnd(1000);
		expect(state.phase).toBe("idle");
	});

	it("agent_end from active begins exhaling, and settleIfDone flips to idle exactly at the exhale boundary", () => {
		const state = new BreathingBorderState();
		state.applyAgentStart(0);
		state.applyAgentEnd(1000);
		expect(state.phase).toBe("exhaling");

		expect(state.settleIfDone(1000 + EXHALE_DURATION_MS - 1)).toBe(false);
		expect(state.phase).toBe("exhaling");

		expect(state.settleIfDone(1000 + EXHALE_DURATION_MS)).toBe(true);
		expect(state.phase).toBe("idle");
		// Only fires once on the transition, not on every subsequent call.
		expect(state.settleIfDone(1000 + EXHALE_DURATION_MS + 500)).toBe(false);
	});

	it("a fresh agent_start interrupts an in-progress exhale and resumes active breathing", () => {
		const state = new BreathingBorderState();
		state.applyAgentStart(0);
		state.applyAgentEnd(1000);
		expect(state.phase).toBe("exhaling");
		state.applyAgentStart(1200);
		expect(state.phase).toBe("active");
		expect(state.breathElapsedMs(1300)).toBe(100);
	});

	it("agent_end freezes gloss progress through repeated ends and settled idle", () => {
		const state = new BreathingBorderState();
		state.applyAgentStart(0);
		state.applyAgentEnd(GLOSS_LAP_DURATION_MS / 4);

		expect(state.glossProgress(GLOSS_LAP_DURATION_MS / 2)).toBe(0.25);
		state.applyAgentEnd(GLOSS_LAP_DURATION_MS / 2);
		expect(state.glossProgress(GLOSS_LAP_DURATION_MS * 2)).toBe(0.25);

		state.settleIfDone(GLOSS_LAP_DURATION_MS / 2 + EXHALE_DURATION_MS);
		expect(state.phase).toBe("idle");
		expect(state.glossProgress(Number.POSITIVE_INFINITY)).toBe(0.25);
	});

	it("agent_start interrupts exhale and restarts gloss at top-left", () => {
		const state = new BreathingBorderState();
		state.applyAgentStart(0);
		state.applyAgentEnd(GLOSS_LAP_DURATION_MS / 4);
		state.applyAgentStart(GLOSS_LAP_DURATION_MS / 2);

		expect(state.glossProgress(GLOSS_LAP_DURATION_MS / 2)).toBe(0);
		expect(state.glossProgress((GLOSS_LAP_DURATION_MS * 3) / 4)).toBe(0.25);
	});

	it("gloss progress is stable while idle and malformed or backward queries do not mutate it", () => {
		const state = new BreathingBorderState();
		expect(state.glossProgress(10_000)).toBe(0);
		expect(state.glossProgress(Number.NaN)).toBe(0);

		state.applyAgentStart(5000);
		expect(state.glossProgress(1000)).toBe(0);
		expect(state.glossProgress(Number.POSITIVE_INFINITY)).toBe(0);
		expect(state.glossProgress(5000 + GLOSS_LAP_DURATION_MS / 4)).toBe(0.25);
	});

	it("turn_start/turn_end measure duration via the injected clock, not the raw event fields", () => {
		const state = new BreathingBorderState();
		expect(state.breathPeriodMs()).toBe(BASE_BREATH_PERIOD_MS);
		state.applyTurnStart(1, 0);
		state.applyTurnEnd(1, 1);
		expect(state.breathPeriodMs()).toBe(MIN_BREATH_PERIOD_MS);
	});

	it("turn_end for a mismatched turnIndex is ignored", () => {
		const state = new BreathingBorderState();
		state.applyTurnStart(1, 0);
		state.applyTurnEnd(2, 100_000);
		expect(state.breathPeriodMs()).toBe(BASE_BREATH_PERIOD_MS);
	});
});

describe("breathing border hardening: adversarial/non-finite inputs", () => {
	it("brightnessToken(NaN) is a documented quirk, not a crash: NaN fails both threshold comparisons and falls through to the brightest bucket", () => {
		// `NaN < 0.15` and `NaN < 0.6` are both false, so the fallthrough branch wins —
		// a plain comparison chain, not an array lookup, so it degrades to a valid
		// (if surprising) token rather than corrupting the border chrome.
		expect(brightnessToken(Number.NaN)).toBe("borderAccent");
	});

	it("breathEnvelope/exhaleEnvelope propagate NaN for a NaN clock or period rather than silently clamping", () => {
		expect(breathEnvelope(Number.NaN, BASE_BREATH_PERIOD_MS)).toBeNaN();
		expect(breathEnvelope(100, Number.NaN)).toBeNaN();
		expect(exhaleEnvelope(Number.NaN, EXHALE_DURATION_MS)).toBeNaN();
	});

	it("glossLapProgress holds at top-left for negative, backward, or non-finite elapsed time", () => {
		expect(glossLapProgress(-1)).toBe(0);
		expect(glossLapProgress(Number.NaN)).toBe(0);
		expect(glossLapProgress(Number.POSITIVE_INFINITY)).toBe(0);
		expect(glossLapProgress(Number.NEGATIVE_INFINITY)).toBe(0);
	});

	it("exhaleEnvelope clamps any non-positive elapsed (not just 0) to full brightness", () => {
		expect(exhaleEnvelope(-1, EXHALE_DURATION_MS)).toBe(1);
		expect(exhaleEnvelope(-1_000_000, EXHALE_DURATION_MS)).toBe(1);
	});

	it("breathPeriodMsForTurnDuration treats Infinity and NaN the same as no-turn-known: the base period, not an unclamped runaway value", () => {
		expect(breathPeriodMsForTurnDuration(Number.POSITIVE_INFINITY)).toBe(BASE_BREATH_PERIOD_MS);
		expect(breathPeriodMsForTurnDuration(Number.NaN)).toBe(BASE_BREATH_PERIOD_MS);
	});

	it("BreathingBorderState.settleIfDone is idempotent once idle: repeated calls stay false with no re-triggered settle", () => {
		const state = new BreathingBorderState();
		state.applyAgentStart(0);
		state.applyAgentEnd(0);
		expect(state.settleIfDone(EXHALE_DURATION_MS)).toBe(true); // fires exactly once
		expect(state.settleIfDone(EXHALE_DURATION_MS)).toBe(false); // already idle, no re-trigger
		expect(state.settleIfDone(EXHALE_DURATION_MS + 5000)).toBe(false);
	});

	it("BreathingBorderState.applyAgentEnd called twice in a row restarts the exhale timer from the second call", () => {
		const state = new BreathingBorderState();
		state.applyAgentStart(0);
		state.applyAgentEnd(1000);
		expect(state.exhaleElapsedMs(1500)).toBe(500);

		state.applyAgentEnd(2000); // fires again mid-exhale, e.g. a second agent_end
		expect(state.phase).toBe("exhaling");
		expect(state.exhaleElapsedMs(2500)).toBe(500); // measured from the restarted start, not the first
	});

	it("BreathingBorderState.applyTurnEnd is ignored when no turn_start was ever observed (turnStartedAt undefined)", () => {
		const state = new BreathingBorderState();
		state.applyTurnEnd(0, 1000);
		expect(state.snapshot().periodMs).toBe(BASE_BREATH_PERIOD_MS); // no turn duration recorded
	});

	it("BreathingBorderState clamps backward wall-clock skew in turn duration to the base period, never a negative-duration cadence", () => {
		const state = new BreathingBorderState();
		state.applyTurnStart(0, 5000);
		state.applyTurnEnd(0, 1000); // "now" moved backward relative to turn_start
		expect(state.snapshot().periodMs).toBe(BASE_BREATH_PERIOD_MS); // negative duration guarded by breathPeriodMsForTurnDuration
	});

	it("breathElapsedMs/exhaleElapsedMs clamp backward clock skew to 0 rather than going negative", () => {
		const state = new BreathingBorderState();
		state.applyAgentStart(5000);
		expect(state.breathElapsedMs(1000)).toBe(0);

		state.applyAgentEnd(5000);
		expect(state.exhaleElapsedMs(1000)).toBe(0);
	});
});
