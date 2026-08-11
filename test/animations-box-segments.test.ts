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
import type { PhraseSpan } from "../src/animations-box/status-line";
import { AUDIT_TRAIL_BOX_COLORS, AuditLedgerState, renderAuditMeterRow, statusGlyphs } from "../src/audit-trail-box";
import { CACHE_METER_COLORS, CacheMeterState, renderCacheMeterRow } from "../src/cache-meter";
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
import {
	CATEGORY_THEME_COLOR,
	ConstellationState,
	categoryIcon,
	renderConstellationTally,
} from "../src/tool-constellation";

// Identity theme so variant assertions see plain text instead of ANSI escapes.
// Builders emit PLAIN spans (Plan 018) — the theme only ever reaches the
// simple-mode variant renderers, so no color-tagging double is needed here.
const idTheme = { fg: (_color: string, text: string) => text };

// Unicode-tier glyphs, resolved once — every builder call below defaults to `"unicode"`.
const STATUS_GLYPHS = statusGlyphs("unicode");
const CATEGORY_ICON = categoryIcon("unicode");

/** D4's *idle* resting phrase — a lone dim em-dash, shared by every builder. */
const IDLE_SPANS: readonly PhraseSpan[] = [{ key: "idle", text: "—", tone: "dim" }];

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

describe("buildCacheMeterSegment — resting line (Decision 5: enabled-but-idle, never absent)", () => {
	it("is inactive with empty variants before any prompt-cache telemetry has landed", () => {
		const sample = buildCacheMeterSegment(new CacheMeterState(), 0, idTheme);
		expect(sample.active).toBe(false);
		expect(sample.variants).toEqual([]);
	});

	it("still renders a full resting line: idle dot, label 'cache', badge accent, lone dim em-dash", () => {
		const sample = buildCacheMeterSegment(new CacheMeterState(), 0, idTheme);
		expect(sample.line).toEqual({
			dot: "idle",
			label: "cache",
			accent: CACHE_METER_COLORS.badge,
			spans: IDLE_SPANS,
		});
	});
});

describe("buildCacheMeterSegment — active line", () => {
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

	it("consecutive-equal variants never repeat (dedupe held)", () => {
		const state = warmedState();
		const sample = buildCacheMeterSegment(state, 0, idTheme);
		for (let i = 1; i < sample.variants.length; i++) {
			expect(sample.variants[i]).not.toBe(sample.variants[i - 1]);
		}
	});

	it("lights the live dot and keeps the badge accent, honoring an accent override", () => {
		const state = warmedState();
		const colors = { ...CACHE_METER_COLORS, badge: "syntaxString" as const };
		const sample = buildCacheMeterSegment(state, 0, idTheme, colors);
		expect(sample.line.dot).toBe("live");
		expect(sample.line.accent).toBe("syntaxString");
	});

	it("pct span is the snapshot's true warmth — never eased, never alerted", () => {
		const state = warmedState();
		const sample = buildCacheMeterSegment(state, 999, idTheme);
		expect(sample.line.spans[0]).toEqual({ key: "pct", text: "50.0%" });
	});

	it("falls back to a hits span (hit/request counts) when no savings rate is derivable", () => {
		const state = warmedState(); // no Usage.cost supplied anywhere
		const snapshot = state.snapshot();
		expect(snapshot.savedCost).toBeUndefined();
		const sample = buildCacheMeterSegment(state, 0, idTheme);
		expect(sample.line.spans[1]).toEqual({ key: "hits", text: `${snapshot.hitCount}/${snapshot.requestCount}` });
	});

	it("leads with a saved-cost span once a rate is derivable", () => {
		const state = new CacheMeterState();
		state.recordUsage(
			usageSample("anthropic", "claude", {
				input: 400,
				cacheRead: 600,
				cacheWrite: 200,
				cost: { input: 0.3, output: 0.05, cacheRead: 0.02, cacheWrite: 0.01, total: 0.38 },
			}),
		);
		const savedCost = state.snapshot().savedCost as number;
		expect(savedCost).toBeDefined();
		const sample = buildCacheMeterSegment(state, 0, idTheme);
		const expected = savedCost < 0.01 ? "<$0.01" : `$${savedCost.toFixed(2)}`;
		expect(sample.line.spans[1]).toEqual({ key: "saved", text: `saved ${expected}` });
	});

	it("carries the r/w/miss token triple only as a wide-only tail span", () => {
		const state = warmedState();
		const snapshot = state.snapshot();
		const sample = buildCacheMeterSegment(state, 0, idTheme);
		expect(sample.line.spans[2]).toEqual({
			key: "tokens",
			text: `r ${snapshot.cacheReadTokens} · w ${snapshot.cacheWriteTokens} · miss ${snapshot.missTokens}`,
			wideOnly: true,
		});
	});
});

describe("buildCacheMeterSegment — glyph preset", () => {
	it("forwards the preset into the simple-mode variants (ascii badge substitute '#')", () => {
		const state = new CacheMeterState();
		state.recordUsage(usageSample("anthropic", "claude", { input: 400, cacheRead: 600, cacheWrite: 200 }));
		const active = buildCacheMeterSegment(state, 0, idTheme, CACHE_METER_COLORS, "ascii");
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

describe("buildCadenceEqualizerSegment — resting line (Decision 5: enabled-but-idle, never absent)", () => {
	it("is inactive with empty variants before the first assistant message_start (hasStreamed=false)", () => {
		const sample = buildCadenceEqualizerSegment(new CadenceEqualizerState(), false, null, 0, idTheme);
		expect(sample.active).toBe(false);
		expect(sample.variants).toEqual([]);
	});

	it("still renders a full resting line: idle dot, label 'cadence', burst accent, lone dim em-dash", () => {
		const sample = buildCadenceEqualizerSegment(new CadenceEqualizerState(), false, null, 0, idTheme);
		expect(sample.line).toEqual({
			dot: "idle",
			label: "cadence",
			accent: cadenceEqualizerColors().burst,
			spans: IDLE_SPANS,
		});
	});
});

describe("buildCadenceEqualizerSegment — active line", () => {
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

	it("rate span is '<N> t/s', rounded, when a live rate is sampled", () => {
		const state = warmedCadenceState();
		const sample = buildCadenceEqualizerSegment(state, true, 41.6, 0, idTheme);
		expect(sample.line.dot).toBe("live");
		expect(sample.line.spans[0]).toEqual({ key: "rate", text: "42 t/s" });
	});

	it("rate span falls back to the keeper's own idle convention ('--') once hasStreamed is true but nothing is currently sampled", () => {
		const state = warmedCadenceState();
		const sample = buildCadenceEqualizerSegment(state, true, null, 0, idTheme);
		expect(sample.line.spans[0]).toEqual({ key: "rate", text: "--" });
	});

	it("peak span is 'peak <N>', the highest band-peak amplitude denormalized back through MAX_REFERENCE_RATE", () => {
		const state = warmedCadenceState();
		const peaks = state.snapshotPeaks();
		let peakAmplitude = 0;
		for (const peak of peaks) if (peak > peakAmplitude) peakAmplitude = peak;
		const sample = buildCadenceEqualizerSegment(state, true, 41, 0, idTheme);
		expect(sample.line.spans[1]).toEqual({
			key: "peak",
			text: `peak ${Math.round(peakAmplitude * MAX_REFERENCE_RATE)}`,
		});
	});

	it("keeps the burst accent, honoring an accent override", () => {
		const state = warmedCadenceState();
		const colors = cadenceEqualizerColors("syntaxString");
		const sample = buildCadenceEqualizerSegment(state, true, 41, 0, idTheme, colors);
		expect(sample.line.accent).toBe(colors.burst);
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

describe("buildAuditTrailBoxSegment — resting line (Decision 5: enabled-but-idle, never absent)", () => {
	it("is inactive with empty variants before any tool has touched a path", () => {
		const sample = buildAuditTrailBoxSegment(new AuditLedgerState(), 0, idTheme);
		expect(sample.active).toBe(false);
		expect(sample.variants).toEqual([]);
	});

	it("still renders a full resting line: idle dot, label 'audit', badge accent, lone dim em-dash", () => {
		const sample = buildAuditTrailBoxSegment(new AuditLedgerState(), 0, idTheme);
		expect(sample.line).toEqual({
			dot: "idle",
			label: "audit",
			accent: AUDIT_TRAIL_BOX_COLORS.badge,
			spans: IDLE_SPANS,
		});
	});
});

describe("buildAuditTrailBoxSegment — active line", () => {
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

	it("counts span is the status counts, highest-risk-first, using the keeper's own status glyphs", () => {
		const state = new AuditLedgerState();
		state.noteRead("/repo/src/foo.ts"); // fresh
		const sample = buildAuditTrailBoxSegment(state, 0, idTheme);
		expect(sample.line.dot).toBe("live");
		expect(sample.line.spans[0]).toEqual({ key: "counts", text: `1${STATUS_GLYPHS.fresh}` });
	});

	it("metrics span is 'reads <reads> · writes <writes> · amp <write amplification>×'", () => {
		const state = new AuditLedgerState();
		state.noteRead("/repo/src/foo.ts");
		state.noteWrite("/repo/src/foo.ts", 0);
		const sample = buildAuditTrailBoxSegment(state, 0, idTheme);
		expect(sample.line.spans[1]).toEqual({ key: "metrics", text: "reads 1 · writes 1 · amp 1.0×" });
	});

	it("last span is the basename of the most recently touched path, wide-only", () => {
		const state = new AuditLedgerState();
		state.noteRead("/repo/src/foo.ts");
		state.noteTurn(); // advance the turn clock so bar.ts's touch is unambiguously later
		state.noteWrite("/repo/src/bar.ts", 0);
		const sample = buildAuditTrailBoxSegment(state, 0, idTheme);
		expect(sample.line.spans[2]).toEqual({ key: "last", text: "bar.ts", wideOnly: true });
	});

	it("keeps the badge accent, honoring an accent override", () => {
		const state = new AuditLedgerState();
		state.noteRead("/repo/src/foo.ts");
		const colors = { ...AUDIT_TRAIL_BOX_COLORS, badge: "syntaxString" as const };
		const sample = buildAuditTrailBoxSegment(state, 0, idTheme, colors);
		expect(sample.line.accent).toBe("syntaxString");
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

describe("buildRateLimitTidepoolSegment — resting line (Decision 5: enabled-but-idle, never absent)", () => {
	it("is inactive with empty variants before any recognized response has landed (snapshot() undefined)", () => {
		const sample = buildRateLimitTidepoolSegment(new RateLimitTidepoolState(), 0, idTheme);
		expect(sample.active).toBe(false);
		expect(sample.variants).toEqual([]);
	});

	it("still renders a full resting line: idle dot, label 'limits', water accent, lone dim em-dash", () => {
		const sample = buildRateLimitTidepoolSegment(new RateLimitTidepoolState(), 0, idTheme);
		expect(sample.line).toEqual({
			dot: "idle",
			label: "limits",
			accent: TIDEPOOL_COLORS.water,
			spans: IDLE_SPANS,
		});
	});
});

describe("buildRateLimitTidepoolSegment — active line", () => {
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

	it("pct span is the refill-adjusted level as a rounded percentage", () => {
		const state = pooledState(0.784);
		const sample = buildRateLimitTidepoolSegment(state, 0, idTheme);
		expect(sample.line.dot).toBe("live");
		expect(sample.line.spans[0]).toEqual({ key: "pct", text: "78%" });
	});

	it("pct span eases toward full as now advances from observedAtMs toward resetAtMs (refillLevel)", () => {
		const state = pooledState(0.5, 10_000, 0);
		const sample = buildRateLimitTidepoolSegment(state, 5_000, idTheme);
		const expectedLevel = refillLevel(0.5, 5_000, 0, 10_000);
		expect(sample.line.spans[0]).toEqual({ key: "pct", text: `${Math.round(expectedLevel * 100)}%` });
		expect(Math.round(expectedLevel * 100)).not.toBe(50); // must have actually refilled, not held the raw observed level
	});

	it("provider span is the bare provider", () => {
		const state = pooledState();
		const sample = buildRateLimitTidepoolSegment(state, 0, idTheme);
		expect(sample.line.spans[1]).toEqual({ key: "provider", text: "anthropic" });
	});

	it("reset span is 'resets <N>m' for a reset more than a minute out", () => {
		const state = pooledState(0.5, 12 * 60_000, 0);
		const sample = buildRateLimitTidepoolSegment(state, 0, idTheme);
		expect(sample.line.spans[2]).toEqual({ key: "reset", text: "resets 12m" });
	});

	it("reset span is 'resets <N>s' for a sub-minute reset", () => {
		const state = pooledState(0.5, 30_000, 0);
		const sample = buildRateLimitTidepoolSegment(state, 0, idTheme);
		expect(sample.line.spans[2]).toEqual({ key: "reset", text: "resets 30s" });
	});

	it("reset span is absent when the binding bucket reported no reset", () => {
		const state = pooledState(0.5, undefined, 0);
		const sample = buildRateLimitTidepoolSegment(state, 0, idTheme);
		expect(sample.line.spans).toHaveLength(2);
		expect(sample.line.spans.some(span => span.key === "reset")).toBe(false);
	});

	it("reset span reads 'resets now' once the reset has already passed", () => {
		const state = pooledState(0.5, 1_000, 0);
		const sample = buildRateLimitTidepoolSegment(state, 5_000, idTheme);
		expect(sample.line.spans[2]).toEqual({ key: "reset", text: "resets now" });
	});

	it("keeps the water accent, honoring an accent override — the sand alarm color stays fixed regardless", () => {
		const state = pooledState();
		const colors = { ...TIDEPOOL_COLORS, water: "syntaxString" as const };
		const sample = buildRateLimitTidepoolSegment(state, 0, idTheme, colors);
		expect(sample.line.accent).toBe("syntaxString");
		expect(colors.sand).toBe(TIDEPOOL_COLORS.sand);
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

describe("buildToolConstellationSegment — resting line (Decision 5: enabled-but-idle, never absent)", () => {
	it("is inactive with empty variants before any tool_call has fired", () => {
		const sample = buildToolConstellationSegment(new ConstellationState(), 0, idTheme);
		expect(sample.active).toBe(false);
		expect(sample.variants).toEqual([]);
	});

	it("still renders a full resting line: idle dot, label 'tools', dim accent, lone dim em-dash", () => {
		const sample = buildToolConstellationSegment(new ConstellationState(), 0, idTheme);
		expect(sample.line).toEqual({
			dot: "idle",
			label: "tools",
			accent: "dim",
			spans: IDLE_SPANS,
		});
	});
});

describe("buildToolConstellationSegment — active line", () => {
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
		expect(sample.line.spans[1]).toEqual({ key: "top", text: "read" });
	});

	it("total span is the total fire count across every category", () => {
		const state = new ConstellationState();
		state.recordFire("read", 0);
		state.recordFire("read", 0);
		state.recordFire("bash", 0);
		const sample = buildToolConstellationSegment(state, 0, idTheme);
		expect(sample.line.dot).toBe("live");
		expect(sample.line.spans[0]).toEqual({ key: "total", text: "3 calls" });
	});

	it("tally span is the icon+count+name tally, in CATEGORY_ORDER, wide-only", () => {
		const state = new ConstellationState();
		state.recordFire("read", 0);
		state.recordFire("read", 0);
		state.recordFire("bash", 0);
		const sample = buildToolConstellationSegment(state, 0, idTheme);
		expect(sample.line.spans[2]).toEqual({
			key: "tally",
			text: `${CATEGORY_ICON.read}2 read · ${CATEGORY_ICON.bash}1 bash`,
			wideOnly: true,
		});
	});

	it("accents the line with the dominant category's CATEGORY_THEME_COLOR — no accent override slot exists for this segment", () => {
		const state = new ConstellationState();
		state.recordFire("read", 0);
		const sample = buildToolConstellationSegment(state, 0, idTheme);
		expect(sample.line.accent).toBe(CATEGORY_THEME_COLOR.read);
	});
});

describe("buildToolConstellationSegment — glyph preset", () => {
	it("forwards the preset into the tally span's category icons (ascii substitutes)", () => {
		const state = new ConstellationState();
		state.recordFire("read", 0);
		const active = buildToolConstellationSegment(state, 0, idTheme, "ascii");
		expect(active.line.spans[2]).toEqual({ key: "tally", text: "^1 read", wideOnly: true }); // read -> "^" in ascii
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

describe("buildPalimpsestSegment — resting line (Decision 5: enabled-but-idle, never absent)", () => {
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

	it("still renders a full resting line: idle dot, label 'files', ember accent, lone dim em-dash", () => {
		const sample = buildPalimpsestSegment(new PalimpsestState(), 0, idTheme);
		expect(sample.line).toEqual({
			dot: "idle",
			label: "files",
			accent: PALIMPSEST_COLORS.ember,
			spans: IDLE_SPANS,
		});
	});
});

describe("buildPalimpsestSegment — active line", () => {
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
		expect(sample.line.spans[0]).toEqual({ key: "hot", text: "b.ts ×2" });
		expect(sample.line.spans[1]).toEqual({ key: "rows", text: "2 rows" });
	});

	it("hot span is '<basename> ×<overlap>', rows span pluralizes the visible-row count", () => {
		const state = thrashedState();
		const sample = buildPalimpsestSegment(state, 0, idTheme);
		expect(sample.line.dot).toBe("live");
		expect(sample.line.spans).toEqual([
			{ key: "hot", text: "foo.ts ×2" },
			{ key: "rows", text: "1 row" },
		]);
	});

	it("keeps the ember accent, honoring an accent override", () => {
		const state = thrashedState();
		const colors = { ...PALIMPSEST_COLORS, ember: "syntaxString" as const };
		const sample = buildPalimpsestSegment(state, 0, idTheme, colors);
		expect(sample.line.accent).toBe("syntaxString");
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

describe("buildReflectionRippleSegment — resting line (Decision 1: idle is the COMMON state, not a startup gap)", () => {
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

	it("still renders a full resting line: idle dot, label 'reflect', ring accent, lone dim em-dash", () => {
		const sample = buildReflectionRippleSegment(new ReflectionRippleState(), 0, idTheme);
		expect(sample.line).toEqual({
			dot: "idle",
			label: "reflect",
			accent: REFLECTION_RIPPLE_COLORS.ring,
			spans: IDLE_SPANS,
		});
	});
});

describe("buildReflectionRippleSegment — active line", () => {
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

	it("rules span joins every matched rule name, in event order", () => {
		const state = ripplingState(["ruleA", "ruleB"], 0);
		const sample = buildReflectionRippleSegment(state, 0, idTheme);
		expect(sample.line.dot).toBe("live");
		expect(sample.line.spans[0]).toEqual({ key: "rules", text: "ruleA, ruleB" });
	});

	it("count span is the bare session trigger count", () => {
		const state = new ReflectionRippleState();
		state.applyTrigger(["a"], 0);
		state.applyTrigger(["b"], 10);
		const sample = buildReflectionRippleSegment(state, 10, idTheme);
		expect(sample.line.spans[1]).toEqual({ key: "count", text: "2" });
	});

	it("keeps the ring accent, honoring an accent override", () => {
		const state = ripplingState();
		const colors = { ...REFLECTION_RIPPLE_COLORS, ring: "syntaxString" as const };
		const sample = buildReflectionRippleSegment(state, 0, idTheme, colors);
		expect(sample.line.accent).toBe("syntaxString");
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
