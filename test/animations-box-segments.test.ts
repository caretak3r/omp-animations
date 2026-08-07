import { describe, expect, it } from "bun:test";
import { buildCacheMeterSegment } from "../src/animations-box/segments";
import { BOX_SEGMENT_IDS } from "../src/animations-box/settings";
import { BADGE_GLYPH, CACHE_METER_COLORS, CacheMeterState, renderCacheMeterRow } from "../src/cache-meter";

// Identity theme so assertions see plain text instead of ANSI escapes.
const idTheme = { fg: (_color: string, text: string) => text };
// Color-tagging theme for tests that need to assert which color token the builder chose.
const taggedTheme = { fg: (color: string, text: string) => `${color}:${text}` };

function usageSample(
	provider: string,
	model: string,
	usage: Partial<Parameters<CacheMeterState["recordUsage"]>[0]["usage"]> = {},
) {
	return {
		provider,
		model,
		usage: { input: 0, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 10, ...usage },
	};
}

describe("buildCacheMeterSegment — priority", () => {
	it("derives its priority from cacheMeter's position in BOX_SEGMENT_IDS, never a hardcoded literal", () => {
		const sample = buildCacheMeterSegment(new CacheMeterState(), 0, idTheme);
		expect(sample.priority).toBe(BOX_SEGMENT_IDS.indexOf("cacheMeter") + 1);
	});

	it("id is always cacheMeter", () => {
		expect(buildCacheMeterSegment(new CacheMeterState(), 0, idTheme).id).toBe("cacheMeter");
	});
});

describe("buildCacheMeterSegment — resting row (Decision 5: enabled-but-idle, never absent)", () => {
	it("is inactive with empty variants before any prompt-cache telemetry has landed", () => {
		const sample = buildCacheMeterSegment(new CacheMeterState(), 0, idTheme);
		expect(sample.active).toBe(false);
		expect(sample.variants).toEqual([]);
	});

	it("still renders a full dim resting row: glyph, label 'cache', primary '—', empty secondary/trailing", () => {
		const sample = buildCacheMeterSegment(new CacheMeterState(), 0, idTheme);
		expect(sample.detail).toEqual({ glyph: BADGE_GLYPH, label: "cache", primary: "—", secondary: "", trailing: "" });
	});

	it("colors the resting glyph dim, not the active badge accent", () => {
		const sample = buildCacheMeterSegment(new CacheMeterState(), 0, taggedTheme);
		expect(sample.detail.glyph).toBe(`dim:${BADGE_GLYPH}`);
	});
});

describe("buildCacheMeterSegment — active row", () => {
	function warmedState(): CacheMeterState {
		const state = new CacheMeterState();
		state.recordUsage(usageSample("anthropic", "claude", { input: 400, cacheRead: 600, cacheWrite: 200 }));
		return state;
	}

	it("is active once telemetry lands, with variants matching renderCacheMeterRow at the exact 999/40/18/3 budgets, deduped", () => {
		const state = warmedState();
		const snapshot = state.snapshot();
		const sample = buildCacheMeterSegment(state, 12_345, idTheme);
		expect(sample.active).toBe(true);

		const expected = [999, 40, 18, 3].map(width =>
			renderCacheMeterRow(snapshot, width, 12_345, idTheme, "subtle", snapshot.warmth, false, CACHE_METER_COLORS),
		);
		const dedupedExpected: string[] = [];
		for (const v of expected) if (dedupedExpected.at(-1) !== v) dedupedExpected.push(v);
		expect(sample.variants).toEqual(dedupedExpected);
	});

	it("never eases the warmth or blinks the badge — always the snapshot's true warmth, unalerted", () => {
		const state = warmedState();
		const snapshot = state.snapshot();
		const sample = buildCacheMeterSegment(state, 999, idTheme);
		// alerted=false and displayWarmth=snapshot.warmth are baked into every variant already
		// asserted above; this pins the detail column's own percentage to the same true value.
		expect(sample.detail.primary).toBe(`${(snapshot.warmth * 100).toFixed(1)}%`);
	});

	it("consecutive-equal variants never repeat (dedupe held)", () => {
		const state = warmedState();
		const sample = buildCacheMeterSegment(state, 0, idTheme);
		for (let i = 1; i < sample.variants.length; i++) {
			expect(sample.variants[i]).not.toBe(sample.variants[i - 1]);
		}
	});

	it("detail.secondary falls back to hit/request counts when no savings rate is derivable", () => {
		const state = warmedState(); // no Usage.cost supplied anywhere
		const snapshot = state.snapshot();
		expect(snapshot.savedCost).toBeUndefined();
		const sample = buildCacheMeterSegment(state, 0, idTheme);
		expect(sample.detail.secondary).toBe(`${snapshot.hitCount}/${snapshot.requestCount}`);
	});

	it("detail.secondary leads with saved cost once a rate is derivable", () => {
		const state = new CacheMeterState();
		state.recordUsage(
			usageSample("anthropic", "claude", {
				input: 400,
				cacheRead: 600,
				cacheWrite: 200,
				cost: { input: 0.3, output: 0.05, cacheRead: 0.02, cacheWrite: 0.01, total: 0.38 },
			}),
		);
		const snapshot = state.snapshot();
		expect(snapshot.savedCost).toBeDefined();
		const sample = buildCacheMeterSegment(state, 0, idTheme);
		expect(sample.detail.secondary).toBe(`saved $${(snapshot.savedCost as number).toFixed(2)}`);
	});

	it("detail.trailing is 'r <read> · w <write>' using the same number formatting as the standalone widget", () => {
		const state = warmedState();
		const snapshot = state.snapshot();
		const sample = buildCacheMeterSegment(state, 0, idTheme);
		expect(sample.detail.trailing).toBe(`r ${snapshot.cacheReadTokens} · w ${snapshot.cacheWriteTokens}`);
	});

	it("colors the active glyph with the badge accent, honoring an accent override", () => {
		const state = warmedState();
		const colors = { ...CACHE_METER_COLORS, badge: "syntaxString" as const };
		const sample = buildCacheMeterSegment(state, 0, taggedTheme, colors);
		expect(sample.detail.glyph).toBe(`syntaxString:${BADGE_GLYPH}`);
	});
});
