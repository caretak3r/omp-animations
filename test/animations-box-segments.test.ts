import { describe, expect, it } from "bun:test";
import {
	buildAuditTrailBoxSegment,
	buildCacheMeterSegment,
	buildCadenceEqualizerSegment,
	buildPalimpsestSegment,
	buildRateLimitTidepoolSegment,
	buildReflectionRippleSegment,
	buildToolConstellationSegment,
} from "../src/animations-box/segments";
import { BOX_SEGMENT_IDS } from "../src/animations-box/settings";
import {
	AUDIT_TRAIL_BOX_COLORS,
	AuditLedgerState,
	badgeGlyph as auditBadgeGlyphFor,
	renderAuditMeterRow,
	statusGlyphs,
} from "../src/audit-trail-box";
import {
	CACHE_METER_COLORS,
	CacheMeterState,
	badgeGlyph as cacheBadgeGlyphFor,
	renderCacheMeterRow,
} from "../src/cache-meter";
import {
	CadenceEqualizerState,
	cadenceEqualizerColors,
	renderCompactEqualizer,
	renderEqualizerRow,
	renderEqualizerText,
} from "../src/cadence-equalizer";
import { MAX_REFERENCE_RATE } from "../src/cadence-equalizer/scale";
import { GLOW_THRESHOLD, PALIMPSEST_COLORS, PalimpsestState } from "../src/palimpsest";
import { RateLimitTidepoolState, refillLevel, renderTidepoolRow, TIDEPOOL_COLORS } from "../src/rate-limit-tidepool";
import { REFLECTION_RIPPLE_COLORS, ReflectionRippleState, renderReflectionRippleRow } from "../src/reflection-ripple";
import { ConstellationState, categoryIcon, emptyGlyph, renderConstellationTally } from "../src/tool-constellation";

// Identity theme so assertions see plain text instead of ANSI escapes.
const idTheme = { fg: (_color: string, text: string) => text };
// Color-tagging theme for tests that need to assert which color token the builder chose.
const taggedTheme = { fg: (color: string, text: string) => `${color}:${text}` };

// Unicode-tier glyphs, resolved once — every builder call below defaults to `"unicode"`.
const BADGE_GLYPH = cacheBadgeGlyphFor("unicode");
const AUDIT_BADGE_GLYPH = auditBadgeGlyphFor("unicode");
const STATUS_GLYPHS = statusGlyphs("unicode");
const CATEGORY_ICON = categoryIcon("unicode");
const EMPTY_GLYPH = emptyGlyph("unicode");

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

	it("still renders a full dim resting row: glyph, label 'cache', hollow bar, primary '—', empty secondary/trailing", () => {
		const sample = buildCacheMeterSegment(new CacheMeterState(), 0, idTheme);
		expect(sample.detail).toEqual({
			glyph: BADGE_GLYPH,
			label: "cache",
			bar: "[░░░░░░░░░░]",
			primary: "—",
			secondary: "",
			trailing: "",
		});
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

	it("detail.trailing is 'r <read> · w <write> · miss <miss>' using the same number formatting as the standalone widget", () => {
		const state = warmedState();
		const snapshot = state.snapshot();
		const sample = buildCacheMeterSegment(state, 0, idTheme);
		expect(sample.detail.trailing).toBe(
			`r ${snapshot.cacheReadTokens} · w ${snapshot.cacheWriteTokens} · miss ${snapshot.missTokens}`,
		);
	});

	it("colors the active glyph with the badge accent, honoring an accent override", () => {
		const state = warmedState();
		const colors = { ...CACHE_METER_COLORS, badge: "syntaxString" as const };
		const sample = buildCacheMeterSegment(state, 0, taggedTheme, colors);
		expect(sample.detail.glyph).toBe(`syntaxString:${BADGE_GLYPH}`);
	});
});

describe("buildCacheMeterSegment — glyph preset", () => {
	function warmedState(): CacheMeterState {
		const state = new CacheMeterState();
		state.recordUsage(usageSample("anthropic", "claude", { input: 400, cacheRead: 600, cacheWrite: 200 }));
		return state;
	}

	it("defaults to the unicode badge when no preset is passed", () => {
		const sample = buildCacheMeterSegment(new CacheMeterState(), 0, idTheme);
		expect(sample.detail.glyph).toBe(BADGE_GLYPH);
	});

	it("swaps the badge for the ascii substitute when preset is 'ascii', resting and active", () => {
		const resting = buildCacheMeterSegment(new CacheMeterState(), 0, idTheme, CACHE_METER_COLORS, "ascii");
		expect(resting.detail.glyph).toBe("#");

		const active = buildCacheMeterSegment(warmedState(), 0, idTheme, CACHE_METER_COLORS, "ascii");
		expect(active.detail.glyph).toBe("#");
		expect(active.variants[0]?.startsWith("#")).toBe(true);
	});
});

describe("buildCadenceEqualizerSegment — priority", () => {
	it("derives its priority from cadenceEqualizer's position in BOX_SEGMENT_IDS, never a hardcoded literal", () => {
		const sample = buildCadenceEqualizerSegment(new CadenceEqualizerState(), false, null, 0, idTheme);
		expect(sample.priority).toBe(BOX_SEGMENT_IDS.indexOf("cadenceEqualizer") + 1);
	});

	it("id is always cadenceEqualizer", () => {
		expect(buildCadenceEqualizerSegment(new CadenceEqualizerState(), false, null, 0, idTheme).id).toBe(
			"cadenceEqualizer",
		);
	});
});

describe("buildCadenceEqualizerSegment — resting row (Decision 5: enabled-but-idle, never absent)", () => {
	it("is inactive with empty variants before the first assistant message_start (hasStreamed=false)", () => {
		const sample = buildCadenceEqualizerSegment(new CadenceEqualizerState(), false, null, 0, idTheme);
		expect(sample.active).toBe(false);
		expect(sample.variants).toEqual([]);
	});

	it("still renders a full resting row: label 'cadence', primary '—', empty secondary/trailing", () => {
		const sample = buildCadenceEqualizerSegment(new CadenceEqualizerState(), false, null, 0, idTheme);
		expect(sample.detail.label).toBe("cadence");
		expect(sample.detail.primary).toBe("—");
		expect(sample.detail.secondary).toBe("");
		expect(sample.detail.trailing).toBe("");
	});

	it("the resting glyph is the live renderCompactEqualizer strip over the state's own (zero) bands, never a separate invented literal", () => {
		const state = new CadenceEqualizerState();
		const sample = buildCadenceEqualizerSegment(state, false, null, 0, taggedTheme);
		expect(sample.detail.glyph).toBe(
			renderCompactEqualizer(state.snapshotBands(), taggedTheme, cadenceEqualizerColors()),
		);
	});
});

describe("buildCadenceEqualizerSegment — active row", () => {
	function warmedCadenceState(): CadenceEqualizerState {
		const state = new CadenceEqualizerState();
		for (let i = 0; i < 10; i++) state.pushSample(0.9);
		return state;
	}

	it("is active once hasStreamed is true, with variants matching the renderEqualizerRow -> renderCompactEqualizer -> renderEqualizerText ladder, deduped", () => {
		const state = warmedCadenceState();
		const bands = state.snapshotBands();
		const peaks = state.snapshotPeaks();
		const sample = buildCadenceEqualizerSegment(state, true, 41, 0, idTheme);
		expect(sample.active).toBe(true);

		const expected = [
			renderEqualizerRow(bands, peaks, idTheme, cadenceEqualizerColors()),
			renderCompactEqualizer(bands, idTheme, cadenceEqualizerColors()),
			renderEqualizerText(41),
		];
		const dedupedExpected: string[] = [];
		for (const v of expected) if (dedupedExpected.at(-1) !== v) dedupedExpected.push(v);
		expect(sample.variants).toEqual(dedupedExpected);
	});

	it("consecutive-equal variants never repeat (dedupe held)", () => {
		const state = warmedCadenceState();
		const sample = buildCadenceEqualizerSegment(state, true, 41, 0, idTheme);
		for (let i = 1; i < sample.variants.length; i++) {
			expect(sample.variants[i]).not.toBe(sample.variants[i - 1]);
		}
	});

	it("detail.primary is '<N> t/s', rounded, when a live rate is sampled", () => {
		const state = warmedCadenceState();
		const sample = buildCadenceEqualizerSegment(state, true, 41.6, 0, idTheme);
		expect(sample.detail.primary).toBe("42 t/s");
	});

	it("detail.primary falls back to renderEqualizerText's own idle convention ('--') once hasStreamed is true but nothing is currently sampled", () => {
		const state = warmedCadenceState();
		const sample = buildCadenceEqualizerSegment(state, true, null, 0, idTheme);
		expect(sample.detail.primary).toBe("--");
	});

	it("detail.secondary is 'peak <N>', the highest band-peak amplitude denormalized back through MAX_REFERENCE_RATE", () => {
		const state = warmedCadenceState();
		const peaks = state.snapshotPeaks();
		let peakAmplitude = 0;
		for (const peak of peaks) if (peak > peakAmplitude) peakAmplitude = peak;
		const sample = buildCadenceEqualizerSegment(state, true, 41, 0, idTheme);
		expect(sample.detail.secondary).toBe(`peak ${Math.round(peakAmplitude * MAX_REFERENCE_RATE)}`);
	});

	it("detail.trailing is the full renderEqualizerRow band bar (peak caps included)", () => {
		const state = warmedCadenceState();
		const sample = buildCadenceEqualizerSegment(state, true, 41, 0, idTheme);
		expect(sample.detail.trailing).toBe(
			renderEqualizerRow(state.snapshotBands(), state.snapshotPeaks(), idTheme, cadenceEqualizerColors()),
		);
	});

	it("detail.glyph is the renderCompactEqualizer strip over the SAME live bands, honoring an accent override for the burst bucket", () => {
		const state = warmedCadenceState();
		const colors = cadenceEqualizerColors("syntaxString");
		const sample = buildCadenceEqualizerSegment(state, true, 41, 0, taggedTheme, colors);
		expect(sample.detail.glyph).toBe(renderCompactEqualizer(state.snapshotBands(), taggedTheme, colors));
		// The warmed state (target 0.9, 10 steps) drives the fast band well past the
		// burst threshold (>0.75 normalized), so the override must actually surface.
		expect(sample.detail.glyph).toContain("syntaxString:");
	});
});

describe("buildAuditTrailBoxSegment — priority", () => {
	it("derives its priority from auditTrailBox's position in BOX_SEGMENT_IDS, never a hardcoded literal", () => {
		const sample = buildAuditTrailBoxSegment(new AuditLedgerState(), 0, idTheme);
		expect(sample.priority).toBe(BOX_SEGMENT_IDS.indexOf("auditTrailBox") + 1);
	});

	it("id is always auditTrailBox", () => {
		expect(buildAuditTrailBoxSegment(new AuditLedgerState(), 0, idTheme).id).toBe("auditTrailBox");
	});
});

describe("buildAuditTrailBoxSegment — resting row (Decision 5: enabled-but-idle, never absent)", () => {
	it("is inactive with empty variants before any tool has touched a path", () => {
		const sample = buildAuditTrailBoxSegment(new AuditLedgerState(), 0, idTheme);
		expect(sample.active).toBe(false);
		expect(sample.variants).toEqual([]);
	});

	it("still renders a full dim resting row: glyph, label 'audit', primary '—', empty secondary/trailing", () => {
		const sample = buildAuditTrailBoxSegment(new AuditLedgerState(), 0, idTheme);
		expect(sample.detail).toEqual({
			glyph: AUDIT_BADGE_GLYPH,
			label: "audit",
			bar: "",
			primary: "—",
			secondary: "",
			trailing: "",
		});
	});

	it("colors the resting glyph dim, not the active badge accent", () => {
		const sample = buildAuditTrailBoxSegment(new AuditLedgerState(), 0, taggedTheme);
		expect(sample.detail.glyph).toBe(`dim:${AUDIT_BADGE_GLYPH}`);
	});
});

describe("buildAuditTrailBoxSegment — active row", () => {
	it("is active once the first path is tracked, with variants matching renderAuditMeterRow at the exact 999/40/18 budgets, deduped", () => {
		const state = new AuditLedgerState();
		state.noteRead("/repo/src/foo.ts");
		const snapshot = state.snapshot();
		const sample = buildAuditTrailBoxSegment(state, 12_345, idTheme);
		expect(sample.active).toBe(true);

		const expected = [999, 40, 18].map(width =>
			renderAuditMeterRow(snapshot, width, 12_345, idTheme, "subtle", AUDIT_TRAIL_BOX_COLORS),
		);
		const dedupedExpected: string[] = [];
		for (const v of expected) if (dedupedExpected.at(-1) !== v) dedupedExpected.push(v);
		expect(sample.variants).toEqual(dedupedExpected);
	});

	it("consecutive-equal variants never repeat (dedupe held)", () => {
		const state = new AuditLedgerState();
		state.noteRead("/repo/src/foo.ts");
		const sample = buildAuditTrailBoxSegment(state, 0, idTheme);
		for (let i = 1; i < sample.variants.length; i++) {
			expect(sample.variants[i]).not.toBe(sample.variants[i - 1]);
		}
	});

	it("detail.primary is the status counts, highest-risk-first, using the keeper's own STATUS_GLYPHS", () => {
		const state = new AuditLedgerState();
		state.noteRead("/repo/src/foo.ts"); // fresh
		const sample = buildAuditTrailBoxSegment(state, 0, idTheme);
		expect(sample.detail.primary).toBe(`1${STATUS_GLYPHS.fresh}`);
	});

	it("detail.secondary is the basename of the most recently touched path", () => {
		const state = new AuditLedgerState();
		state.noteRead("/repo/src/foo.ts");
		state.noteTurn(); // advance the turn clock so bar.ts's touch is unambiguously later
		state.noteWrite("/repo/src/bar.ts", 0);
		const sample = buildAuditTrailBoxSegment(state, 0, idTheme);
		expect(sample.detail.secondary).toBe("bar.ts");
	});

	it("detail.trailing is 'reads <reads> · writes <writes> · amp <write amplification>×'", () => {
		const state = new AuditLedgerState();
		state.noteRead("/repo/src/foo.ts");
		state.noteWrite("/repo/src/foo.ts", 0);
		const snapshot = state.snapshot();
		const sample = buildAuditTrailBoxSegment(state, 0, idTheme);
		expect(sample.detail.trailing).toBe(
			`reads ${snapshot.metrics.reads} · writes ${snapshot.metrics.writes} · amp ${snapshot.metrics.writeAmplification.toFixed(1)}×`,
		);
	});

	it("colors the active glyph with the badge accent when nothing is poisoned, honoring an accent override", () => {
		const state = new AuditLedgerState();
		state.noteRead("/repo/src/foo.ts");
		const colors = { ...AUDIT_TRAIL_BOX_COLORS, badge: "syntaxString" as const };
		const sample = buildAuditTrailBoxSegment(state, 0, taggedTheme, colors);
		expect(sample.detail.glyph).toBe(`syntaxString:${AUDIT_BADGE_GLYPH}`);
	});

	it("colors the glyph with the poisoned token once a path has crossed the POISONED gate, never pulsing it", () => {
		const state = new AuditLedgerState();
		state.noteRead("/repo/src/foo.ts", { hash: "h1" });
		// Two consecutive divergent probe ticks are required before POISONED sticks (POISON_STREAK_TICKS).
		state.noteProbe([{ path: "/repo/src/foo.ts", hash: "h2", reachable: true }], 0);
		state.noteProbe([{ path: "/repo/src/foo.ts", hash: "h2", reachable: true }], 1);
		const snapshot = state.snapshot();
		expect(snapshot.counts.poisoned).toBe(1);

		const sample = buildAuditTrailBoxSegment(state, 999, taggedTheme, AUDIT_TRAIL_BOX_COLORS);
		expect(sample.detail.glyph).toBe(`${AUDIT_TRAIL_BOX_COLORS.poisoned}:${AUDIT_BADGE_GLYPH}`);
	});
});

describe("buildAuditTrailBoxSegment — glyph preset", () => {
	it("defaults to the unicode badge and status glyphs when no preset is passed", () => {
		const resting = buildAuditTrailBoxSegment(new AuditLedgerState(), 0, idTheme);
		expect(resting.detail.glyph).toBe(AUDIT_BADGE_GLYPH);

		const state = new AuditLedgerState();
		state.noteRead("/repo/src/foo.ts");
		const active = buildAuditTrailBoxSegment(state, 0, idTheme);
		expect(active.detail.primary).toBe(`1${STATUS_GLYPHS.fresh}`);
	});

	it("swaps the badge and status glyphs for their ascii substitutes when preset is 'ascii'", () => {
		const resting = buildAuditTrailBoxSegment(new AuditLedgerState(), 0, idTheme, AUDIT_TRAIL_BOX_COLORS, "ascii");
		expect(resting.detail.glyph).toBe("@");

		const state = new AuditLedgerState();
		state.noteRead("/repo/src/foo.ts");
		const active = buildAuditTrailBoxSegment(state, 0, idTheme, AUDIT_TRAIL_BOX_COLORS, "ascii");
		expect(active.detail.glyph).toBe("@");
		expect(active.detail.primary).toBe("1v"); // fresh -> "v" in ascii
	});
});

describe("buildRateLimitTidepoolSegment — priority", () => {
	it("derives its priority from rateLimitTidepool's position in BOX_SEGMENT_IDS, never a hardcoded literal", () => {
		const sample = buildRateLimitTidepoolSegment(new RateLimitTidepoolState(), 0, idTheme);
		expect(sample.priority).toBe(BOX_SEGMENT_IDS.indexOf("rateLimitTidepool") + 1);
	});

	it("id is always rateLimitTidepool", () => {
		expect(buildRateLimitTidepoolSegment(new RateLimitTidepoolState(), 0, idTheme).id).toBe("rateLimitTidepool");
	});
});

describe("buildRateLimitTidepoolSegment — resting row (Decision 5: enabled-but-idle, never absent)", () => {
	it("is inactive with empty variants before any recognized response has landed (snapshot() undefined)", () => {
		const sample = buildRateLimitTidepoolSegment(new RateLimitTidepoolState(), 0, idTheme);
		expect(sample.active).toBe(false);
		expect(sample.variants).toEqual([]);
	});

	it("still renders a full dim resting row: glyph '◗', label 'limits', hollow bar, primary '—', empty secondary/trailing", () => {
		const sample = buildRateLimitTidepoolSegment(new RateLimitTidepoolState(), 0, idTheme);
		expect(sample.detail).toEqual({
			glyph: "◗",
			label: "limits",
			bar: "[░░░░░░░░░░]",
			primary: "—",
			secondary: "",
			trailing: "",
		});
	});

	it("colors the resting glyph dim, not the active water accent", () => {
		const sample = buildRateLimitTidepoolSegment(new RateLimitTidepoolState(), 0, taggedTheme);
		expect(sample.detail.glyph).toBe("dim:◗");
	});
});

describe("buildRateLimitTidepoolSegment — active row", () => {
	function pooledState(
		level = 0.78,
		resetAtMs: number | undefined = undefined,
		observedAtMs = 0,
	): RateLimitTidepoolState {
		const state = new RateLimitTidepoolState();
		state.applySample({ provider: "anthropic", family: "anthropic", level, resetAtMs, observedAtMs });
		return state;
	}

	it("is active once a snapshot lands, with variants matching renderTidepoolRow at the exact 999/30/12 budgets, deduped", () => {
		const state = pooledState();
		const sample = buildRateLimitTidepoolSegment(state, 0, idTheme);
		expect(sample.active).toBe(true);

		const level = refillLevel(0.78, 0, 0, undefined);
		const expected = [999, 30, 12].map(width =>
			renderTidepoolRow(level, "anthropic", 0, width, idTheme, "subtle", TIDEPOOL_COLORS),
		);
		const dedupedExpected: string[] = [];
		for (const v of expected) if (dedupedExpected.at(-1) !== v) dedupedExpected.push(v);
		expect(sample.variants).toEqual(dedupedExpected);
	});

	it("consecutive-equal variants never repeat (dedupe held)", () => {
		const state = pooledState();
		const sample = buildRateLimitTidepoolSegment(state, 0, idTheme);
		for (let i = 1; i < sample.variants.length; i++) {
			expect(sample.variants[i]).not.toBe(sample.variants[i - 1]);
		}
	});

	it("detail.primary is the refill-adjusted level as a rounded percentage", () => {
		const state = pooledState(0.784);
		const sample = buildRateLimitTidepoolSegment(state, 0, idTheme);
		expect(sample.detail.primary).toBe("78%");
	});

	it("detail.primary eases toward full as now advances from observedAtMs toward resetAtMs (refillLevel)", () => {
		const state = pooledState(0.5, 10_000, 0);
		const sample = buildRateLimitTidepoolSegment(state, 5_000, idTheme);
		const expectedLevel = refillLevel(0.5, 5_000, 0, 10_000);
		expect(sample.detail.primary).toBe(`${Math.round(expectedLevel * 100)}%`);
		expect(sample.detail.primary).not.toBe("50%"); // must have actually refilled, not held the raw observed level
	});

	it("detail.secondary is the bare provider", () => {
		const state = pooledState();
		const sample = buildRateLimitTidepoolSegment(state, 0, idTheme);
		expect(sample.detail.secondary).toBe("anthropic");
	});

	it("detail.trailing is 'resets <N>m' for a reset more than a minute out", () => {
		const state = pooledState(0.5, 12 * 60_000, 0);
		const sample = buildRateLimitTidepoolSegment(state, 0, idTheme);
		expect(sample.detail.trailing).toBe("resets 12m");
	});

	it("detail.trailing is 'resets <N>s' for a sub-minute reset", () => {
		const state = pooledState(0.5, 30_000, 0);
		const sample = buildRateLimitTidepoolSegment(state, 0, idTheme);
		expect(sample.detail.trailing).toBe("resets 30s");
	});

	it("detail.trailing is empty when the binding bucket reported no reset", () => {
		const state = pooledState(0.5, undefined, 0);
		const sample = buildRateLimitTidepoolSegment(state, 0, idTheme);
		expect(sample.detail.trailing).toBe("");
	});

	it("detail.trailing reads 'resets now' once the reset has already passed", () => {
		const state = pooledState(0.5, 1_000, 0);
		const sample = buildRateLimitTidepoolSegment(state, 5_000, idTheme);
		expect(sample.detail.trailing).toBe("resets now");
	});

	it("colors the active glyph with the water accent, honoring an accent override — the sand alarm color stays fixed regardless", () => {
		const state = pooledState();
		const colors = { ...TIDEPOOL_COLORS, water: "syntaxString" as const };
		const sample = buildRateLimitTidepoolSegment(state, 0, taggedTheme, colors);
		expect(sample.detail.glyph).toBe("syntaxString:◗");
		expect(colors.sand).toBe(TIDEPOOL_COLORS.sand);
	});
});

describe("buildRateLimitTidepoolSegment — glyph preset", () => {
	function pooledState(): RateLimitTidepoolState {
		const state = new RateLimitTidepoolState();
		state.applySample({
			provider: "anthropic",
			family: "anthropic",
			level: 0.78,
			resetAtMs: undefined,
			observedAtMs: 0,
		});
		return state;
	}

	it("defaults to the unicode badge '◗' when no preset is passed", () => {
		const sample = buildRateLimitTidepoolSegment(new RateLimitTidepoolState(), 0, idTheme);
		expect(sample.detail.glyph).toBe("◗");
	});

	it("swaps the badge for the ascii substitute ')' when preset is 'ascii', resting and active", () => {
		const resting = buildRateLimitTidepoolSegment(new RateLimitTidepoolState(), 0, idTheme, TIDEPOOL_COLORS, "ascii");
		expect(resting.detail.glyph).toBe(")");

		const active = buildRateLimitTidepoolSegment(pooledState(), 0, idTheme, TIDEPOOL_COLORS, "ascii");
		expect(active.detail.glyph).toBe(")");
	});
});

describe("buildToolConstellationSegment — priority", () => {
	it("derives its priority from toolConstellation's position in BOX_SEGMENT_IDS, never a hardcoded literal", () => {
		const sample = buildToolConstellationSegment(new ConstellationState(), 0, idTheme);
		expect(sample.priority).toBe(BOX_SEGMENT_IDS.indexOf("toolConstellation") + 1);
	});

	it("id is always toolConstellation", () => {
		expect(buildToolConstellationSegment(new ConstellationState(), 0, idTheme).id).toBe("toolConstellation");
	});
});

describe("buildToolConstellationSegment — resting row (Decision 5: enabled-but-idle, never absent)", () => {
	it("is inactive with empty variants before any tool_call has fired", () => {
		const sample = buildToolConstellationSegment(new ConstellationState(), 0, idTheme);
		expect(sample.active).toBe(false);
		expect(sample.variants).toEqual([]);
	});

	it("still renders a full dim resting row: glyph, label 'tools', primary '—', empty secondary/trailing", () => {
		const sample = buildToolConstellationSegment(new ConstellationState(), 0, idTheme);
		expect(sample.detail).toEqual({
			glyph: EMPTY_GLYPH,
			label: "tools",
			bar: "",
			primary: "—",
			secondary: "",
			trailing: "",
		});
	});

	it("colors the resting glyph dim", () => {
		const sample = buildToolConstellationSegment(new ConstellationState(), 0, taggedTheme);
		expect(sample.detail.glyph).toBe(`dim:${EMPTY_GLYPH}`);
	});
});

describe("buildToolConstellationSegment — active row", () => {
	it("collapses to a single variant when only one category has fired (full and truncated coincide)", () => {
		const state = new ConstellationState();
		state.recordFire("read", 0);
		const sample = buildToolConstellationSegment(state, 0, idTheme);
		expect(sample.active).toBe(true);
		expect(sample.variants).toEqual([renderConstellationTally(state.categoryCounts(), idTheme)]);
	});

	it("keeps two variants — the full rainbow tally, then the dominant category alone — once more than one category has fired", () => {
		const state = new ConstellationState();
		for (let i = 0; i < 5; i++) state.recordFire("read", 0);
		state.recordFire("write", 0);
		state.recordFire("edit", 0); // normalizes to "write" alongside the category above
		const sample = buildToolConstellationSegment(state, 0, idTheme);

		const counts = state.categoryCounts();
		const full = renderConstellationTally(counts, idTheme);
		const narrow = renderConstellationTally(new Map([["read", counts.get("read") ?? 0]]), idTheme);
		expect(sample.variants).toEqual([full, narrow]);
	});

	it("breaks a tied fire count by CATEGORY_ORDER, not insertion order", () => {
		const state = new ConstellationState();
		state.recordFire("write", 0); // categorizes to "write", fired first
		state.recordFire("read", 0); // categorizes to "read", fired second, but read precedes write in CATEGORY_ORDER
		const sample = buildToolConstellationSegment(state, 0, idTheme);
		expect(sample.detail.secondary).toBe("read");
	});

	it("detail.primary is the total fire count across every category", () => {
		const state = new ConstellationState();
		state.recordFire("read", 0);
		state.recordFire("read", 0);
		state.recordFire("bash", 0);
		const sample = buildToolConstellationSegment(state, 0, idTheme);
		expect(sample.detail.primary).toBe("3 calls");
	});

	it("detail.trailing is the icon+count+name tally, in CATEGORY_ORDER, uncolored", () => {
		const state = new ConstellationState();
		state.recordFire("read", 0);
		state.recordFire("read", 0);
		state.recordFire("bash", 0);
		const sample = buildToolConstellationSegment(state, 0, idTheme);
		expect(sample.detail.trailing).toBe(`${CATEGORY_ICON.read}2 read · ${CATEGORY_ICON.bash}1 bash`);
	});

	it("colors the dominant-category glyph with CATEGORY_THEME_COLOR — no accent override slot exists for this segment", () => {
		const state = new ConstellationState();
		state.recordFire("read", 0);
		const sample = buildToolConstellationSegment(state, 0, taggedTheme);
		expect(sample.detail.glyph).toBe("syntaxVariable:⛏");
	});
});

describe("buildToolConstellationSegment — glyph preset", () => {
	it("defaults to the unicode empty glyph and category icons when no preset is passed", () => {
		const resting = buildToolConstellationSegment(new ConstellationState(), 0, idTheme);
		expect(resting.detail.glyph).toBe(EMPTY_GLYPH);

		const state = new ConstellationState();
		state.recordFire("read", 0);
		const active = buildToolConstellationSegment(state, 0, idTheme);
		expect(active.detail.trailing).toBe(`${CATEGORY_ICON.read}1 read`);
	});

	it("swaps the empty glyph and category icons for their ascii substitutes when preset is 'ascii'", () => {
		const resting = buildToolConstellationSegment(new ConstellationState(), 0, idTheme, "ascii");
		expect(resting.detail.glyph).toBe(".");

		const state = new ConstellationState();
		state.recordFire("read", 0);
		const active = buildToolConstellationSegment(state, 0, idTheme, "ascii");
		expect(active.detail.trailing).toBe("^1 read"); // read -> "^" in ascii
		expect(active.detail.glyph).toBe("^");
	});
});

describe("buildPalimpsestSegment — priority", () => {
	it("derives its priority from palimpsest's position in BOX_SEGMENT_IDS, never a hardcoded literal", () => {
		const sample = buildPalimpsestSegment(new PalimpsestState(), 0, idTheme);
		expect(sample.priority).toBe(BOX_SEGMENT_IDS.indexOf("palimpsest") + 1);
	});

	it("id is always palimpsest", () => {
		expect(buildPalimpsestSegment(new PalimpsestState(), 0, idTheme).id).toBe("palimpsest");
	});
});

describe("buildPalimpsestSegment — resting row (Decision 5: enabled-but-idle, never absent)", () => {
	it("is inactive with empty variants before any region clears GLOW_THRESHOLD", () => {
		const sample = buildPalimpsestSegment(new PalimpsestState(), 0, idTheme);
		expect(sample.active).toBe(false);
		expect(sample.variants).toEqual([]);
	});

	it("stays inactive with a single touch — GLOW_THRESHOLD requires at least a second touch of the same region", () => {
		const state = new PalimpsestState();
		state.applySpans("/repo/src/foo.ts", [{ start: 1, end: 5 }]);
		expect(GLOW_THRESHOLD).toBe(2);
		const sample = buildPalimpsestSegment(state, 0, idTheme);
		expect(sample.active).toBe(false);
	});

	it("still renders a full dim resting row: glyph '▓', label 'files', primary '—', empty secondary/trailing", () => {
		const sample = buildPalimpsestSegment(new PalimpsestState(), 0, idTheme);
		expect(sample.detail).toEqual({
			glyph: "▓",
			label: "files",
			bar: "",
			primary: "—",
			secondary: "",
			trailing: "",
		});
	});

	it("colors the resting glyph dim", () => {
		const sample = buildPalimpsestSegment(new PalimpsestState(), 0, taggedTheme);
		expect(sample.detail.glyph).toBe("dim:▓");
	});
});

describe("buildPalimpsestSegment — active row", () => {
	function thrashedState(): PalimpsestState {
		const state = new PalimpsestState();
		state.applySpans("/repo/src/foo.ts", [{ start: 1, end: 5 }]);
		state.applySpans("/repo/src/foo.ts", [{ start: 1, end: 5 }]); // second touch crosses GLOW_THRESHOLD
		return state;
	}

	it("is active once a region crosses GLOW_THRESHOLD, narrowing path ×N -> basename ×N -> ×N", () => {
		const state = thrashedState();
		const sample = buildPalimpsestSegment(state, 0, idTheme);
		expect(sample.active).toBe(true);
		expect(sample.variants).toEqual(["/repo/src/foo.ts ×2", "foo.ts ×2", "×2"]);
	});

	it("collapses the ladder when the path is already a bare filename (path and basename coincide)", () => {
		const state = new PalimpsestState();
		state.applySpans("foo.ts", [{ start: 1, end: 5 }]);
		state.applySpans("foo.ts", [{ start: 1, end: 5 }]);
		const sample = buildPalimpsestSegment(state, 0, idTheme);
		expect(sample.variants).toEqual(["foo.ts ×2", "×2"]);
	});

	it("picks the most recently re-touched region as hottest when several are visible", () => {
		const state = new PalimpsestState();
		state.applySpans("/repo/a.ts", [{ start: 1, end: 5 }]);
		state.applySpans("/repo/a.ts", [{ start: 1, end: 5 }]); // a.ts thrashes at turn 0
		state.advanceTurn(1);
		state.applySpans("/repo/b.ts", [{ start: 1, end: 5 }]);
		state.applySpans("/repo/b.ts", [{ start: 1, end: 5 }]); // b.ts thrashes at turn 1, more recent

		const sample = buildPalimpsestSegment(state, 0, idTheme);
		expect(sample.detail.primary).toBe("b.ts");
		expect(sample.detail.trailing).toBe("2 rows");
	});

	it("detail: ember glyph, basename primary, ×<overlap> secondary, pluralized visible-row count trailing", () => {
		const state = thrashedState();
		const sample = buildPalimpsestSegment(state, 0, idTheme);
		expect(sample.detail).toEqual({
			glyph: "▓",
			label: "files",
			bar: "",
			primary: "foo.ts",
			secondary: "×2",
			trailing: "1 row",
		});
	});

	it("colors the active glyph with the ember accent, honoring an accent override", () => {
		const state = thrashedState();
		const colors = { ...PALIMPSEST_COLORS, ember: "syntaxString" as const };
		const sample = buildPalimpsestSegment(state, 0, taggedTheme, colors);
		expect(sample.detail.glyph).toBe("syntaxString:▓");
	});
});

describe("buildPalimpsestSegment — glyph preset", () => {
	function thrashedState(): PalimpsestState {
		const state = new PalimpsestState();
		state.applySpans("/repo/src/foo.ts", [{ start: 1, end: 5 }]);
		state.applySpans("/repo/src/foo.ts", [{ start: 1, end: 5 }]);
		return state;
	}

	it("defaults to the unicode badge '▓' when no preset is passed", () => {
		const sample = buildPalimpsestSegment(new PalimpsestState(), 0, idTheme);
		expect(sample.detail.glyph).toBe("▓");
	});

	it("swaps the badge for the ascii substitute '%' when preset is 'ascii', resting and active", () => {
		const resting = buildPalimpsestSegment(new PalimpsestState(), 0, idTheme, PALIMPSEST_COLORS, "ascii");
		expect(resting.detail.glyph).toBe("%");

		const active = buildPalimpsestSegment(thrashedState(), 0, idTheme, PALIMPSEST_COLORS, "ascii");
		expect(active.detail.glyph).toBe("%");
	});
});

describe("buildReflectionRippleSegment — priority", () => {
	it("derives its priority from reflectionRipple's position in BOX_SEGMENT_IDS, never a hardcoded literal", () => {
		const sample = buildReflectionRippleSegment(new ReflectionRippleState(), 0, idTheme);
		expect(sample.priority).toBe(BOX_SEGMENT_IDS.indexOf("reflectionRipple") + 1);
	});

	it("id is always reflectionRipple", () => {
		expect(buildReflectionRippleSegment(new ReflectionRippleState(), 0, idTheme).id).toBe("reflectionRipple");
	});
});

describe("buildReflectionRippleSegment — resting row (Decision 1: idle is the COMMON state, not a startup gap)", () => {
	it("is inactive with empty variants before any ttsr_triggered event, and again once a ripple has settled", () => {
		const state = new ReflectionRippleState();
		const sample = buildReflectionRippleSegment(state, 0, idTheme);
		expect(sample.active).toBe(false);
		expect(sample.variants).toEqual([]);

		state.applyTrigger(["rule"], 0);
		state.settleIfDone(999_999); // force-settle far past SETTLE_MS
		expect(state.phase).toBe("idle");
		const settledSample = buildReflectionRippleSegment(state, 999_999, idTheme);
		expect(settledSample.active).toBe(false);
		expect(settledSample.variants).toEqual([]);
	});

	it("still renders a full dim resting row: glyph '○', label 'reflect', primary '—', empty secondary/trailing", () => {
		const sample = buildReflectionRippleSegment(new ReflectionRippleState(), 0, idTheme);
		expect(sample.detail).toEqual({
			glyph: "○",
			label: "reflect",
			bar: "",
			primary: "—",
			secondary: "",
			trailing: "",
		});
	});

	it("colors the resting glyph dim, not the active ring accent", () => {
		const sample = buildReflectionRippleSegment(new ReflectionRippleState(), 0, taggedTheme);
		expect(sample.detail.glyph).toBe("dim:○");
	});
});

describe("buildReflectionRippleSegment — active row", () => {
	function ripplingState(ruleNames: readonly string[] = ["myRule"], triggeredAt = 0): ReflectionRippleState {
		const state = new ReflectionRippleState();
		state.applyTrigger(ruleNames, triggeredAt);
		return state;
	}

	it("is active while phase is rippling, with variants matching renderReflectionRippleRow at the exact 999/40/12 budgets, deduped", () => {
		const state = ripplingState(["myRule"], 100);
		const sample = buildReflectionRippleSegment(state, 150, idTheme);
		expect(sample.active).toBe(true);

		const elapsed = state.rippleElapsedMs(150);
		expect(elapsed).toBe(50);
		const expected = [999, 40, 12].map(width =>
			renderReflectionRippleRow(elapsed, width, idTheme, "subtle", REFLECTION_RIPPLE_COLORS),
		);
		const dedupedExpected: string[] = [];
		for (const v of expected) if (dedupedExpected.at(-1) !== v) dedupedExpected.push(v);
		expect(sample.variants).toEqual(dedupedExpected);
	});

	it("consecutive-equal variants never repeat (dedupe held)", () => {
		const state = ripplingState(["myRule"], 0);
		const sample = buildReflectionRippleSegment(state, 200, idTheme);
		for (let i = 1; i < sample.variants.length; i++) {
			expect(sample.variants[i]).not.toBe(sample.variants[i - 1]);
		}
	});

	it("detail.primary joins every matched rule name, in event order", () => {
		const state = ripplingState(["ruleA", "ruleB"], 0);
		const sample = buildReflectionRippleSegment(state, 0, idTheme);
		expect(sample.detail.primary).toBe("ruleA, ruleB");
	});

	it("detail.secondary is the bare session trigger count", () => {
		const state = new ReflectionRippleState();
		state.applyTrigger(["a"], 0);
		state.applyTrigger(["b"], 10);
		const sample = buildReflectionRippleSegment(state, 10, idTheme);
		expect(sample.detail.secondary).toBe("2");
	});

	it("detail.trailing is always the fixed '—' — this segment has no fifth column of data", () => {
		const state = ripplingState();
		const sample = buildReflectionRippleSegment(state, 0, idTheme);
		expect(sample.detail.trailing).toBe("—");
	});

	it("colors the active glyph with the ring accent, honoring an accent override", () => {
		const state = ripplingState();
		const colors = { ...REFLECTION_RIPPLE_COLORS, ring: "syntaxString" as const };
		const sample = buildReflectionRippleSegment(state, 0, taggedTheme, colors);
		expect(sample.detail.glyph).toBe("syntaxString:○");
	});

	it("phase math is a pure function of (now - trigger timestamp) on the injected clock, never mount/render-relative", () => {
		const state = ripplingState(["a"], 1_000); // triggered at wall-clock t=1000
		const sampleAt1500 = buildReflectionRippleSegment(state, 1_500, idTheme);
		const sampleAt1500Again = buildReflectionRippleSegment(state, 1_500, idTheme);
		expect(sampleAt1500.variants).toEqual(sampleAt1500Again.variants);
		expect(sampleAt1500.variants).toEqual(
			[999, 40, 12]
				.map(width => renderReflectionRippleRow(500, width, idTheme, "subtle", REFLECTION_RIPPLE_COLORS))
				.filter((v, i, arr) => i === 0 || arr[i - 1] !== v),
		);
	});
});

describe("buildReflectionRippleSegment — glyph preset", () => {
	function ripplingState(): ReflectionRippleState {
		const state = new ReflectionRippleState();
		state.applyTrigger(["myRule"], 0);
		return state;
	}

	it("defaults to the unicode badge '○' when no preset is passed", () => {
		const sample = buildReflectionRippleSegment(new ReflectionRippleState(), 0, idTheme);
		expect(sample.detail.glyph).toBe("○");
	});

	it("swaps the badge for the ascii substitute 'o' when preset is 'ascii', resting and active", () => {
		const resting = buildReflectionRippleSegment(
			new ReflectionRippleState(),
			0,
			idTheme,
			REFLECTION_RIPPLE_COLORS,
			"ascii",
		);
		expect(resting.detail.glyph).toBe("o");

		const active = buildReflectionRippleSegment(ripplingState(), 0, idTheme, REFLECTION_RIPPLE_COLORS, "ascii");
		expect(active.detail.glyph).toBe("o");
	});
});
