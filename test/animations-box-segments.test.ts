import { describe, expect, it } from "bun:test";
import {
	buildAuditTrailBoxSegment,
	buildCacheMeterSegment,
	buildPalimpsestSegment,
	buildToolConstellationSegment,
} from "../src/animations-box/segments";
import { BOX_SEGMENT_IDS } from "../src/animations-box/settings";
import {
	BADGE_GLYPH as AUDIT_BADGE_GLYPH,
	AUDIT_TRAIL_BOX_COLORS,
	AuditLedgerState,
	renderAuditMeterRow,
	STATUS_GLYPHS,
} from "../src/audit-trail-box";
import { BADGE_GLYPH, CACHE_METER_COLORS, CacheMeterState, renderCacheMeterRow } from "../src/cache-meter";
import { GLOW_THRESHOLD, PALIMPSEST_COLORS, PalimpsestState } from "../src/palimpsest";
import { CATEGORY_ICON, ConstellationState, EMPTY_GLYPH, renderConstellationTally } from "../src/tool-constellation";

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

	it("detail.trailing is 'r/w <reads>/<writes> · ×<write amplification>'", () => {
		const state = new AuditLedgerState();
		state.noteRead("/repo/src/foo.ts");
		state.noteWrite("/repo/src/foo.ts", 0);
		const snapshot = state.snapshot();
		const sample = buildAuditTrailBoxSegment(state, 0, idTheme);
		expect(sample.detail.trailing).toBe(
			`r/w ${snapshot.metrics.reads}/${snapshot.metrics.writes} · ×${snapshot.metrics.writeAmplification.toFixed(1)}`,
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
		expect(sample.detail).toEqual({ glyph: EMPTY_GLYPH, label: "tools", primary: "—", secondary: "", trailing: "" });
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

	it("detail.trailing is the plain icon+count tally, in CATEGORY_ORDER, uncolored", () => {
		const state = new ConstellationState();
		state.recordFire("read", 0);
		state.recordFire("read", 0);
		state.recordFire("bash", 0);
		const sample = buildToolConstellationSegment(state, 0, idTheme);
		expect(sample.detail.trailing).toBe(`${CATEGORY_ICON.read}2 ${CATEGORY_ICON.bash}1`);
	});

	it("colors the dominant-category glyph with CATEGORY_THEME_COLOR — no accent override slot exists for this segment", () => {
		const state = new ConstellationState();
		state.recordFire("read", 0);
		const sample = buildToolConstellationSegment(state, 0, taggedTheme);
		expect(sample.detail.glyph).toBe("syntaxVariable:⛏");
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
		expect(sample.detail).toEqual({ glyph: "▓", label: "files", primary: "—", secondary: "", trailing: "" });
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
