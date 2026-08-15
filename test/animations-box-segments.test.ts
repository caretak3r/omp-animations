import { describe, expect, it } from "bun:test";
import {
	buildAuditTrailBoxSegment,
	buildCacheMeterSegment,
	buildCadenceEqualizerSegment,
	buildPalimpsestSegment,
	buildRateLimitTidepoolSegment,
	buildReflectionRippleSegment,
	buildToolActivitySegment,
} from "../src/animations-box/segments";
import { BOX_SEGMENT_IDS } from "../src/animations-box/settings";
import type { PhraseSpan } from "../src/animations-box/status-line";
import { ToolActivityState } from "../src/animations-box/tool-activity";
import {
	AUDIT_TRAIL_BOX_COLORS,
	AuditLedgerState,
	POISON_STREAK_TICKS,
	type ProbeReading,
	renderAuditMeterRow,
} from "../src/audit-trail-box";
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

// Identity theme so variant assertions see plain text instead of ANSI escapes.
// Builders emit PLAIN spans (Plan 018) — the theme only ever reaches the
// simple-mode variant renderers, so no color-tagging double is needed here.
const idTheme = { fg: (_color: string, text: string) => text };

/** D4's *idle* resting phrase — a lone dim em-dash, shared by every builder. */
const IDLE_SPANS: readonly PhraseSpan[] = [{ key: "idle", text: "—", tone: "dim" }];

/** Drive `state` past divergence hysteresis for `path`, well clear of any formatter window. */
function poison(state: AuditLedgerState, path: string, startMs: number, hash: string): void {
	const reading: ProbeReading = { path, hash, reachable: true };
	for (let tick = 0; tick < POISON_STREAK_TICKS; tick++) {
		state.noteProbe([reading], startMs + tick * 1000);
	}
}

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

	it("pct span is '<N>% hit' at the snapshot's true warmth, carrying the D5 up-good gradient", () => {
		const state = warmedState();
		const snapshot = state.snapshot();
		const sample = buildCacheMeterSegment(state, 999, idTheme);
		expect(sample.line.spans[0]).toEqual({
			key: "pct",
			text: "50% hit",
			gradient: { ratio: snapshot.warmth, direction: "up-good" },
		});
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

	it("carries uncached volume only as a wide-only tail span (D3: the r/w/miss triple is cut)", () => {
		const state = warmedState();
		const snapshot = state.snapshot();
		const sample = buildCacheMeterSegment(state, 0, idTheme);
		expect(sample.line.spans[2]).toEqual({
			key: "uncached",
			text: `${snapshot.missTokens} uncached`,
			wideOnly: true,
		});
	});

	it("omits the uncached tail entirely when every prompt token was cached", () => {
		const state = new CacheMeterState();
		state.recordUsage(usageSample("anthropic", "claude", { cacheRead: 600, cacheWrite: 200 }));
		expect(state.snapshot().missTokens).toBe(0);
		const sample = buildCacheMeterSegment(state, 0, idTheme);
		expect(sample.line.spans.some(span => span.key === "uncached")).toBe(false);
	});
});

describe("buildCacheMeterSegment — n/a line (D4: undefined ≠ zero)", () => {
	function uncachedRequests(state: CacheMeterState, count: number): void {
		for (let i = 0; i < count; i++) {
			state.recordUsage(usageSample("ollama", "gpt-oss", { input: 100 }));
		}
	}

	it("stays on the live phrase below the request floor — too early to call the provider cacheless", () => {
		const state = new CacheMeterState();
		uncachedRequests(state, 7);
		const sample = buildCacheMeterSegment(state, 0, idTheme);
		expect(sample.line.dot).toBe("live");
		expect(sample.line.spans[0]?.key).toBe("pct");
	});

	it("latches the n/a shape at the floor: idle dot, dim words, no numbers — variants (simple mode) untouched", () => {
		const state = new CacheMeterState();
		uncachedRequests(state, 8);
		const sample = buildCacheMeterSegment(state, 0, idTheme);
		expect(sample.active).toBe(true); // simple mode unchanged — D4 is a detailed-mode distinction
		expect(sample.variants.length).toBeGreaterThan(0);
		expect(sample.line).toEqual({
			dot: "idle",
			label: "cache",
			accent: CACHE_METER_COLORS.badge,
			spans: [{ key: "na", text: "no caching on this provider", tone: "dim" }],
		});
	});

	it("a single later cache hit un-latches permanently — the counters are monotone, so the condition can never re-arm", () => {
		const state = new CacheMeterState();
		uncachedRequests(state, 8);
		state.recordUsage(usageSample("ollama", "gpt-oss", { input: 100, cacheRead: 50 }));
		expect(buildCacheMeterSegment(state, 0, idTheme).line.spans[0]?.key).toBe("pct");
		uncachedRequests(state, 20); // more uncached traffic afterwards must not re-latch
		expect(buildCacheMeterSegment(state, 0, idTheme).line.dot).toBe("live");
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

	it("phrase leads with plain-word read/write tallies — no glyphs, no amp (D3)", () => {
		const state = new AuditLedgerState();
		state.noteRead("/repo/src/foo.ts"); // fresh — no risk statuses outstanding
		const sample = buildAuditTrailBoxSegment(state, 0, idTheme);
		expect(sample.line.dot).toBe("live");
		expect(sample.line.spans[0]).toEqual({ key: "reads", text: "1 read" });
		expect(sample.line.spans[1]).toEqual({ key: "writes", text: "0 writes" });
		expect(sample.line.spans.some(span => span.key === "poisoned" || span.key === "dirty")).toBe(false);
	});

	it("a dirty path surfaces as an 'edited' notable span and escalates the dot to notable (D3+D6)", () => {
		const state = new AuditLedgerState();
		state.noteWrite("/repo/src/foo.ts", 0);
		const sample = buildAuditTrailBoxSegment(state, 0, idTheme);
		expect(sample.line.dot).toBe("notable");
		expect(sample.line.spans[2]).toEqual({ key: "dirty", text: "1 edited", tone: "notable" });
	});

	it("a poisoned path surfaces as 'changed on disk' with the alert tone and dot, outranking dirty (D6: alerts persist)", () => {
		const state = new AuditLedgerState();
		state.noteRead("/repo/src/poisoned.ts", { hash: "h1" });
		poison(state, "/repo/src/poisoned.ts", 10_000, "h2");
		state.noteWrite("/repo/src/dirty.ts", 20_000);
		const sample = buildAuditTrailBoxSegment(state, 20_000, idTheme);
		expect(sample.line.dot).toBe("alert");
		expect(sample.line.spans[2]).toEqual({ key: "poisoned", text: "1 changed on disk", tone: "alert" });
		expect(sample.line.spans[3]).toEqual({ key: "dirty", text: "1 edited", tone: "notable" });
	});

	it("last span is the basename of the most recently touched path, wide-only, always the phrase tail", () => {
		const state = new AuditLedgerState();
		state.noteRead("/repo/src/foo.ts");
		state.noteTurn(); // advance the turn clock so bar.ts's touch is unambiguously later
		state.noteWrite("/repo/src/bar.ts", 0);
		const sample = buildAuditTrailBoxSegment(state, 0, idTheme);
		expect(sample.line.spans.at(-1)).toEqual({ key: "last", text: "bar.ts", wideOnly: true });
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

function pooledState(
	level = 0.78,
	resetAtMs: number | undefined = undefined,
	observedAtMs = 0,
): RateLimitTidepoolState {
	const state = new RateLimitTidepoolState();
	state.applySample({ provider: "anthropic", family: "anthropic", level, resetAtMs, observedAtMs });
	return state;
}

describe("buildRateLimitTidepoolSegment — active line", () => {
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

	it("pct span is '<N>% left' at the refill-adjusted level, carrying the D5 up-good gradient (the ratio is the remaining fraction)", () => {
		const state = pooledState(0.784);
		const sample = buildRateLimitTidepoolSegment(state, 0, idTheme);
		expect(sample.line.dot).toBe("live");
		expect(sample.line.spans[0]).toEqual({
			key: "pct",
			text: "78% left",
			gradient: { ratio: refillLevel(0.784, 0, 0, undefined), direction: "up-good" },
		});
	});

	it("pct span eases toward full as now advances from observedAtMs toward resetAtMs (refillLevel)", () => {
		const state = pooledState(0.5, 10_000, 0);
		const sample = buildRateLimitTidepoolSegment(state, 5_000, idTheme);
		const expectedLevel = refillLevel(0.5, 5_000, 0, 10_000);
		expect(sample.line.spans[0]).toEqual({
			key: "pct",
			text: `${Math.round(expectedLevel * 100)}% left`,
			gradient: { ratio: expectedLevel, direction: "up-good" },
		});
		expect(Math.round(expectedLevel * 100)).not.toBe(50); // must have actually refilled, not held the raw observed level
	});

	it("provider span trails the phrase (spec order: pct · reset · provider)", () => {
		const noReset = buildRateLimitTidepoolSegment(pooledState(), 0, idTheme);
		expect(noReset.line.spans[1]).toEqual({ key: "provider", text: "anthropic" });
		const withReset = buildRateLimitTidepoolSegment(pooledState(0.5, 12 * 60_000, 0), 0, idTheme);
		expect(withReset.line.spans[2]).toEqual({ key: "provider", text: "anthropic" });
	});

	it("reset span is 'resets <N>m' for a reset more than a minute out", () => {
		const state = pooledState(0.5, 12 * 60_000, 0);
		const sample = buildRateLimitTidepoolSegment(state, 0, idTheme);
		expect(sample.line.spans[1]).toEqual({ key: "reset", text: "resets 12m" });
	});

	it("reset span is 'resets <N>s' for a sub-minute reset", () => {
		const state = pooledState(0.5, 30_000, 0);
		const sample = buildRateLimitTidepoolSegment(state, 0, idTheme);
		expect(sample.line.spans[1]).toEqual({ key: "reset", text: "resets 30s" });
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
		expect(sample.line.spans[1]).toEqual({ key: "reset", text: "resets now" });
	});

	it("keeps the water accent, honoring an accent override — the sand alarm color stays fixed regardless", () => {
		const state = pooledState();
		const colors = { ...TIDEPOOL_COLORS, water: "syntaxString" as const };
		const sample = buildRateLimitTidepoolSegment(state, 0, idTheme, colors);
		expect(sample.line.accent).toBe("syntaxString");
		expect(colors.sand).toBe(TIDEPOOL_COLORS.sand);
	});
});

describe("buildRateLimitTidepoolSegment — dot escalation (D6: alerts persist, no blinking)", () => {
	it("≤ 20% remaining escalates to the notable dot with an amber pct tone replacing the gradient", () => {
		const sample = buildRateLimitTidepoolSegment(pooledState(0.2), 0, idTheme);
		expect(sample.line.dot).toBe("notable");
		expect(sample.line.spans[0]).toEqual({ key: "pct", text: "20% left", tone: "notable" });
	});

	it("≤ 10% remaining escalates to the alert dot with a red pct tone", () => {
		const sample = buildRateLimitTidepoolSegment(pooledState(0.1), 0, idTheme);
		expect(sample.line.dot).toBe("alert");
		expect(sample.line.spans[0]).toEqual({ key: "pct", text: "10% left", tone: "alert" });
	});

	it("just above the notable threshold stays live with the gradient — escalation replaces the gradient, never stacks", () => {
		const sample = buildRateLimitTidepoolSegment(pooledState(0.21), 0, idTheme);
		expect(sample.line.dot).toBe("live");
		expect(sample.line.spans[0]?.tone).toBeUndefined();
		expect(sample.line.spans[0]?.gradient).toEqual({
			ratio: refillLevel(0.21, 0, 0, undefined),
			direction: "up-good",
		});
	});
});

describe("buildToolActivitySegment — priority", () => {
	it("derives its priority from toolActivity's position in BOX_SEGMENT_IDS, never a hardcoded literal", () => {
		const sample = buildToolActivitySegment(new ToolActivityState(), 0, idTheme);
		expect(sample.priority).toBe(BOX_SEGMENT_IDS.indexOf("toolActivity") + 1);
	});

	it("id is always toolActivity", () => {
		expect(buildToolActivitySegment(new ToolActivityState(), 0, idTheme).id).toBe("toolActivity");
	});
});

describe("buildToolActivitySegment — resting line (Decision 5: enabled-but-idle, never absent)", () => {
	it("is inactive with empty variants before any tool_call has fired", () => {
		const sample = buildToolActivitySegment(new ToolActivityState(), 0, idTheme);
		expect(sample.active).toBe(false);
		expect(sample.variants).toEqual([]);
	});

	it("still renders a full resting line: idle dot, label 'tools', dim accent, lone dim em-dash", () => {
		const sample = buildToolActivitySegment(new ToolActivityState(), 0, idTheme);
		expect(sample.line).toEqual({
			dot: "idle",
			label: "tools",
			accent: "dim",
			spans: IDLE_SPANS,
		});
	});
});

describe("buildToolActivitySegment — active line", () => {
	function stateWith(...toolNames: readonly string[]): ToolActivityState {
		const state = new ToolActivityState();
		for (const name of toolNames) state.record(name);
		return state;
	}

	it("total span counts every call, file tools included — the audit row owns their breakdown, not their existence", () => {
		const sample = buildToolActivitySegment(stateWith("read", "read", "bash"), 0, idTheme);
		expect(sample.active).toBe(true);
		expect(sample.line.dot).toBe("live");
		expect(sample.line.spans[0]).toEqual({ key: "total", text: "3 calls" });
	});

	it("singularizes a lone call", () => {
		expect(buildToolActivitySegment(stateWith("bash"), 0, idTheme).line.spans[0]?.text).toBe("1 call");
	});

	it("never names read or write in the breakdown — that is the audit row's duplication this row removes", () => {
		const sample = buildToolActivitySegment(stateWith("read", "read", "read", "edit", "bash"), 0, idTheme);
		expect(sample.line.spans.map(span => span.key)).toEqual(["total", "cat:bash"]);
		expect(sample.variants).toEqual(["5 calls — bash (1)", "5 calls"]);
	});

	it("collapses to the bare total when only file tools have fired", () => {
		const sample = buildToolActivitySegment(stateWith("read", "write"), 0, idTheme);
		expect(sample.variants).toEqual(["2 calls"]);
		expect(sample.line.spans).toEqual([{ key: "total", text: "2 calls" }]);
	});

	it("orders the breakdown busiest-first and caps it at two categories (TOP_CATEGORY_LIMIT)", () => {
		const sample = buildToolActivitySegment(
			stateWith("grep", "glob", "grep", "bash", "task", "task", "task", "task"),
			0,
			idTheme,
		);
		expect(sample.line.spans).toEqual([
			{ key: "total", text: "8 calls" },
			{ key: "cat:agent", text: "agent (4)", sep: " — " },
			{ key: "cat:search", text: "search (3)", sep: undefined },
		]);
	});

	it("breaks a tied count by REPORTED_CATEGORIES order, not insertion order", () => {
		const sample = buildToolActivitySegment(stateWith("task", "bash"), 0, idTheme);
		expect(sample.line.spans.map(span => span.text)).toEqual(["2 calls", "bash (1)", "agent (1)"]);
	});

	it("routes mcp bridge names to the mcp category and unknown tools to other", () => {
		const sample = buildToolActivitySegment(stateWith("mcp__qmd_query", "some_plugin_tool"), 0, idTheme);
		expect(sample.line.spans.map(span => span.text)).toEqual(["2 calls", "mcp (1)", "other (1)"]);
	});

	it("spells the simple-mode ladder with the same phrase the detailed line renders, dropping the tail first", () => {
		const sample = buildToolActivitySegment(stateWith("bash", "bash", "grep"), 0, idTheme);
		expect(sample.variants).toEqual(["3 calls — bash (2) · search (1)", "3 calls — bash (2)", "3 calls"]);
	});

	it("uses one accent for the whole row — the deleted constellation's per-category rainbow is gone", () => {
		const bash = buildToolActivitySegment(stateWith("bash"), 0, idTheme);
		const agent = buildToolActivitySegment(stateWith("task"), 0, idTheme);
		expect(bash.line.accent).toBe(agent.line.accent);
		expect(bash.line.accent).not.toBe("dim");
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
		expect(sample.line.spans[1]).toEqual({ key: "count", text: "2 hot files" });
	});

	it("hot span is '<basename> ×<overlap>', count span pluralizes the hot-file tally", () => {
		const state = thrashedState();
		const sample = buildPalimpsestSegment(state, 0, idTheme);
		expect(sample.line.dot).toBe("live");
		expect(sample.line.spans).toEqual([
			{ key: "hot", text: "foo.ts ×2" },
			{ key: "count", text: "1 hot file" },
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
