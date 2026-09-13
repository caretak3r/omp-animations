import { describe, expect, it } from "bun:test";
import {
	appendCacheOutcome,
	appendDurationSample,
	buildCacheOutcome,
	type CacheOutcomeTuple,
	type CollisionCapabilities,
	type CollisionFrame,
	composeCollisionDiffraction,
	type DurationSample,
	quantizeDurationSamples,
} from "../src/signal-extras/metric-effects";

const wideUnicode: CollisionCapabilities = { width: 80, unicode: true, color: true, reducedMotion: false };

function changedFrame(observedAt = 1_000): CollisionFrame {
	return {
		phase: "changed",
		observedAt,
		facts: [
			{ sampleId: "ttftSplit", priority: 2 },
			{ sampleId: "cacheMeter", priority: 1 },
		],
	};
}

describe("bounded comparable duration metrics", () => {
	it("stays dormant for insufficient, incomparable, and nonfinite samples", () => {
		expect(
			quantizeDurationSamples([
				{ operationClass: "ttft", durationMs: 100 },
				{ operationClass: "ttft", durationMs: 110 },
				{ operationClass: "ttft", durationMs: 90 },
				{ operationClass: "ttft", durationMs: 105 },
			]),
		).toBeUndefined();

		expect(
			quantizeDurationSamples([
				{ operationClass: "ttft", durationMs: 100 },
				{ operationClass: "ttft", durationMs: 110 },
				{ operationClass: "provider-request", durationMs: 90 },
				{ operationClass: "ttft", durationMs: 105 },
				{ operationClass: "ttft", durationMs: 120 },
			]),
		).toBeUndefined();

		expect(
			quantizeDurationSamples([
				{ operationClass: "ttft", durationMs: 100 },
				{ operationClass: "ttft", durationMs: 110 },
				{ operationClass: "ttft", durationMs: Number.NaN },
				{ operationClass: "ttft", durationMs: 105 },
				{ operationClass: "ttft", durationMs: 120 },
			]),
		).toBeUndefined();
	});

	it("retains a fixed eight-sample capacity and rejects arbitrary keys", () => {
		let history: readonly DurationSample[] = [];
		for (let index = 0; index < 10; index++) {
			history = appendDurationSample(history, { operationClass: "ttft", durationMs: index });
		}
		expect(history).toHaveLength(8);
		expect(history.map(sample => sample.durationMs)).toEqual([2, 3, 4, 5, 6, 7, 8, 9]);

		const unchanged = appendDurationSample(history, {
			operationClass: "prompt:/Users/private/model-key",
			durationMs: 10,
		});
		expect(unchanged).toBe(history);
	});

	it("does not turn tiny variation into a faster or slower claim", () => {
		const result = quantizeDurationSamples([
			{ operationClass: "ttft", durationMs: 1_000 },
			{ operationClass: "ttft", durationMs: 1_006 },
			{ operationClass: "ttft", durationMs: 994 },
			{ operationClass: "ttft", durationMs: 1_003 },
			{ operationClass: "ttft", durationMs: 1_012 },
		]);
		expect(result?.comparison).toBe("typical");
		expect(result?.levels.every(level => level >= 0 && level <= 4)).toBeTrue();
	});

	it("bounds outliers while permitting a defensible recent comparison", () => {
		const result = quantizeDurationSamples([
			{ operationClass: "tool-call", durationMs: 400 },
			{ operationClass: "tool-call", durationMs: 410 },
			{ operationClass: "tool-call", durationMs: 390 },
			{ operationClass: "tool-call", durationMs: 405 },
			{ operationClass: "tool-call", durationMs: 1_200 },
		]);
		expect(result).toMatchObject({ operationClass: "tool-call", comparison: "slower", sampleCount: 5 });
		expect(result?.levels.at(-1)).toBe(4);
	});
});

describe("authoritative cache outcome tuples", () => {
	it("preserves compared, reused, missed, stored, and measured quantities", () => {
		expect(
			buildCacheOutcome({
				layer: "provider",
				lookupClass: "system-tools",
				disposition: "reused",
				cacheRead: 150,
				cacheWrite: 25,
				uncached: 50,
				measuredSavingsMs: 80,
			}),
		).toEqual({
			layer: "provider",
			lookupClass: "system-tools",
			disposition: "reused",
			compared: 200,
			reused: 150,
			missed: 50,
			bypassed: 0,
			stored: 25,
			measuredSavingsMs: 80,
		});
	});

	it("distinguishes an authoritative miss from an authoritative bypass", () => {
		const miss = buildCacheOutcome({
			layer: "provider-prompt",
			lookupClass: "prompt-prefix",
			disposition: "missed",
			cacheRead: 0,
			cacheWrite: 120,
			uncached: 120,
		});
		const bypass = buildCacheOutcome({
			layer: "provider",
			lookupClass: "turn-tail",
			disposition: "bypassed",
			cacheRead: 0,
			cacheWrite: 0,
			uncached: 48,
		});

		expect(miss).toMatchObject({ compared: 120, reused: 0, missed: 120, bypassed: 0, stored: 120 });
		expect(bypass).toMatchObject({ compared: 0, reused: 0, missed: 0, bypassed: 48, stored: 0 });
	});

	it("keeps all-zero telemetry dormant", () => {
		expect(
			buildCacheOutcome({
				layer: "provider",
				lookupClass: "prompt-prefix",
				disposition: "missed",
				cacheRead: 0,
				cacheWrite: 0,
				uncached: 0,
			}),
		).toBeUndefined();
	});

	it("does not infer a hit or savings from quantities or duration", () => {
		expect(
			buildCacheOutcome({
				layer: "provider",
				lookupClass: "prompt-prefix",
				disposition: undefined,
				cacheRead: 500,
				cacheWrite: 0,
				uncached: 20,
				measuredSavingsMs: 1,
			}),
		).toBeUndefined();

		const reused = buildCacheOutcome({
			layer: "provider",
			lookupClass: "prompt-prefix",
			disposition: "reused",
			cacheRead: 500,
			cacheWrite: 0,
			uncached: 20,
		});
		expect(reused).toBeDefined();
		expect("measuredSavingsMs" in reused!).toBeFalse();
	});

	it("bounds retained outcome history", () => {
		let history: readonly CacheOutcomeTuple[] = [];
		for (let index = 1; index <= 10; index++) {
			history = appendCacheOutcome(history, {
				layer: "provider",
				lookupClass: "conversation-prefix",
				disposition: "reused",
				cacheRead: index,
				cacheWrite: 0,
				uncached: 0,
			});
		}
		expect(history).toHaveLength(8);
		expect(history.map(outcome => outcome.reused)).toEqual([3, 4, 5, 6, 7, 8, 9, 10]);
	});
});

describe("same-frame collision diffraction", () => {
	it("uses at most three finite fixed-width stages, then a static count and expiry", () => {
		const frame = changedFrame();
		const tokens = [0, 200, 400, 600, 1_199].map(age =>
			composeCollisionDiffraction(frame, frame.observedAt + age, wideUnicode),
		);
		expect(tokens.map(token => token?.stage)).toEqual([1, 2, 3, "static", "static"]);
		expect(tokens.every(token => token?.fringe.length === 9)).toBeTrue();
		expect(tokens[0]).toMatchObject({ target: "border", foreground: "cacheMeter", priority: 1, coalescedCount: 1 });
		expect(composeCollisionDiffraction(frame, frame.observedAt + 1_200, wideUnicode)).toBeUndefined();
	});

	it("preserves fixed-width semantics in ASCII and without color", () => {
		const token = composeCollisionDiffraction(changedFrame(), 1_000, {
			width: 80,
			unicode: false,
			color: false,
			reducedMotion: false,
		});
		expect(token?.fringe).toBe("..<.*.>..");
		expect(token?.fringe.length).toBe(9);
		expect(token?.coalescedCount).toBe(1);
	});

	it("coalesces repeated facts in one frame and bounds their count", () => {
		const facts = Array.from({ length: 120 }, () => ({ sampleId: "skillChromatograph", priority: 2 }));
		facts.push({ sampleId: "errorIsotope", priority: 1 });
		const token = composeCollisionDiffraction({ phase: "changed", observedAt: 0, facts }, 0, wideUnicode);
		expect(token).toMatchObject({ foreground: "errorIsotope", priority: 1, coalescedCount: 99 });
	});

	it("omits diffraction for reduced motion and narrow widths", () => {
		const frame = changedFrame();
		expect(composeCollisionDiffraction(frame, 1_000, { ...wideUnicode, reducedMotion: true })).toBeUndefined();
		expect(composeCollisionDiffraction(frame, 1_000, { ...wideUnicode, width: 31 })).toBeUndefined();
	});

	it("does no work for stable, idle, or single-fact frames", () => {
		for (const phase of ["stable", "idle"] as const) {
			expect(composeCollisionDiffraction({ ...changedFrame(), phase }, 1_000, wideUnicode)).toBeUndefined();
		}
		expect(
			composeCollisionDiffraction(
				{ phase: "changed", observedAt: 1_000, facts: [{ sampleId: "cacheMeter", priority: 1 }] },
				1_000,
				wideUnicode,
			),
		).toBeUndefined();
	});

	it("never retains private or forbidden host sentinels", () => {
		const sentinel = "PRIVATE prompt /Users/rohit secret-model raw-tool-output";
		const cache = buildCacheOutcome({
			layer: sentinel,
			lookupClass: sentinel,
			disposition: "reused",
			cacheRead: 1,
			cacheWrite: 0,
			uncached: 0,
		});
		const collision = composeCollisionDiffraction(
			{
				phase: "changed",
				observedAt: 0,
				facts: [
					{ sampleId: sentinel, priority: 1 },
					{ sampleId: "ttftSplit", priority: 2 },
					{ sampleId: "cacheMeter", priority: 1 },
				],
			},
			0,
			wideUnicode,
		);
		expect(cache).toBeUndefined();
		expect(JSON.stringify(collision)).not.toContain(sentinel);
	});
});
