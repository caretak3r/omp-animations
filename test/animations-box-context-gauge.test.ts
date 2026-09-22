import { describe, expect, it } from "bun:test";
import type { ContextUsage } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import {
	type ContextUsageLevel,
	getContextUsageLevel,
	getContextUsageThemeColor,
} from "@oh-my-pi/pi-tui/chrome/context-thresholds";
import { formatNumber } from "@oh-my-pi/pi-utils";
import {
	BURN_MIN_TURNS,
	CONTEXT_QUOTA_DEFAULT_PERCENT,
	CONTEXT_QUOTA_MAX_PERCENT,
	CONTEXT_QUOTA_MIN_PERCENT,
	ContextGaugeState,
} from "../src/animations-box/context-gauge";
import { buildContextGaugeSegment } from "../src/animations-box/segments";
import {
	BOX_REQUIRED_SEGMENT_IDS,
	BOX_SEGMENT_IDS,
	resolveAnimationsBoxConfig,
	resolveAnimationsBoxConfigFromSources,
} from "../src/animations-box/settings";
import type { PhraseSpan, StatusDot } from "../src/animations-box/status-line";
import { renderProgressBar } from "../src/progress-bar";

// Identity theme so bar assertions see plain glyphs instead of ANSI escapes.
const idTheme = { fg: (_color: string, text: string) => text };

function usage(tokens: number, contextWindow: number, percent?: number): ContextUsage {
	return { tokens, contextWindow, percent: percent ?? (contextWindow > 0 ? (tokens / contextWindow) * 100 : 0) };
}

/** Feed one turn: a fresh reading, then the turn boundary that deltas it. */
function turn(state: ContextGaugeState, tokens: number, contextWindow = 200_000): void {
	state.observe(usage(tokens, contextWindow));
	state.noteTurn();
}

function spanText(spans: readonly PhraseSpan[], key: string): string | undefined {
	return spans.find(span => span.key === key)?.text;
}

describe("ContextGaugeState — resting shape", () => {
	it("reports a structurally absent window before the first reading, never a zeroed one", () => {
		const snapshot = new ContextGaugeState().snapshot();
		expect(snapshot.contextWindow).toBe(0);
		expect(snapshot.tokens).toBe(0);
		expect(snapshot.quotaTokens).toBe(0);
		expect(snapshot.quotaRatio).toBe(0);
		expect(snapshot.headroomTokens).toBe(0);
		expect(snapshot.tokensPerTurn).toBeNull();
		expect(snapshot.turnsLeft).toBeNull();
		expect(snapshot.compactions).toBe(0);
	});

	it("ignores an absent reading and any reading with no usable window", () => {
		const state = new ContextGaugeState();
		state.observe(undefined);
		state.observe(usage(50_000, 0));
		state.observe(usage(50_000, Number.NaN));
		state.observe(usage(Number.POSITIVE_INFINITY, 200_000));
		state.observe(usage(-1, 200_000));
		expect(state.snapshot().contextWindow).toBe(0);
	});
});

describe("ContextGaugeState — quota fill", () => {
	it("fills against the quota ceiling, not the raw window", () => {
		const state = new ContextGaugeState(80);
		state.observe(usage(120_000, 200_000));
		const snapshot = state.snapshot();
		expect(snapshot.quotaTokens).toBe(160_000);
		expect(snapshot.quotaRatio).toBeCloseTo(0.75, 10);
		expect(snapshot.headroomTokens).toBe(40_000);
		expect(snapshot.windowPercent).toBeCloseTo(60, 10);
	});

	it("pins at full past the ceiling and never reports negative headroom", () => {
		const state = new ContextGaugeState(80);
		state.observe(usage(190_000, 200_000));
		const snapshot = state.snapshot();
		expect(snapshot.quotaRatio).toBe(1);
		expect(snapshot.headroomTokens).toBe(0);
	});

	it("takes the window percentage the host already computed, so the row can never disagree with the footer", () => {
		const state = new ContextGaugeState();
		state.observe(usage(120_000, 200_000, 63.5));
		expect(state.snapshot().windowPercent).toBe(63.5);
	});

	it("derives the window percentage itself when the host omits a usable one", () => {
		const state = new ContextGaugeState();
		state.observe(usage(50_000, 200_000, Number.NaN));
		expect(state.snapshot().windowPercent).toBeCloseTo(25, 10);
	});

	it("clamps the quota percent into range at construction", () => {
		expect(new ContextGaugeState(0).quotaPercent).toBe(CONTEXT_QUOTA_MIN_PERCENT);
		expect(new ContextGaugeState(500).quotaPercent).toBe(CONTEXT_QUOTA_MAX_PERCENT);
		expect(new ContextGaugeState(Number.NaN).quotaPercent).toBe(CONTEXT_QUOTA_DEFAULT_PERCENT);
		expect(new ContextGaugeState().quotaPercent).toBe(CONTEXT_QUOTA_DEFAULT_PERCENT);
	});
});

describe("ContextGaugeState — burn rate", () => {
	it("withholds an estimate until it has seen enough turn deltas to average", () => {
		const state = new ContextGaugeState(80);
		turn(state, 20_000);
		expect(state.snapshot().tokensPerTurn).toBeNull();
		turn(state, 30_000);
		expect(state.snapshot().tokensPerTurn).toBeNull();
		turn(state, 40_000);
		const snapshot = state.snapshot();
		expect(snapshot.tokensPerTurn).toBe(10_000);
		expect(snapshot.turnsLeft).toBe(12); // (160k quota - 40k) / 10k
	});

	it("needs exactly BURN_MIN_TURNS deltas — one fewer stays null", () => {
		const state = new ContextGaugeState(80);
		for (let i = 1; i <= BURN_MIN_TURNS; i++) turn(state, i * 10_000);
		expect(state.snapshot().tokensPerTurn).toBeNull();
		turn(state, (BURN_MIN_TURNS + 1) * 10_000);
		expect(state.snapshot().tokensPerTurn).not.toBeNull();
	});

	it("ignores turns where the context shrank or stood still, so a rewrite never reads as negative burn", () => {
		const state = new ContextGaugeState(80);
		turn(state, 100_000);
		turn(state, 110_000);
		turn(state, 40_000); // compacted out-of-band
		turn(state, 40_000); // no growth
		turn(state, 50_000);
		const snapshot = state.snapshot();
		expect(snapshot.tokensPerTurn).toBe(10_000);
		expect(snapshot.turnsLeft).toBe(11); // (160k - 50k) / 10k
	});

	it("reports zero turns left once the quota is exhausted, not a negative count", () => {
		const state = new ContextGaugeState(80);
		turn(state, 150_000);
		turn(state, 160_000);
		turn(state, 170_000);
		expect(state.snapshot().turnsLeft).toBe(0);
	});

	it("re-baselines the burn window on compaction and counts the compaction", () => {
		const state = new ContextGaugeState(80);
		turn(state, 100_000);
		turn(state, 120_000);
		turn(state, 140_000);
		expect(state.snapshot().tokensPerTurn).toBe(20_000);

		state.noteCompaction();
		const compacted = state.snapshot();
		expect(compacted.compactions).toBe(1);
		expect(compacted.tokensPerTurn).toBeNull();
		expect(compacted.turnsLeft).toBeNull();

		turn(state, 40_000);
		turn(state, 45_000);
		turn(state, 50_000);
		expect(state.snapshot().tokensPerTurn).toBe(5_000);
	});

	it("a turn boundary before any reading is inert", () => {
		const state = new ContextGaugeState();
		state.noteTurn();
		state.noteTurn();
		expect(state.snapshot().tokensPerTurn).toBeNull();
	});
});

describe("buildContextGaugeSegment — identity", () => {
	it("derives its priority from contextGauge's position in BOX_SEGMENT_IDS", () => {
		const sample = buildContextGaugeSegment(new ContextGaugeState(), 0, idTheme);
		expect(sample.id).toBe("contextGauge");
		expect(sample.priority).toBe(BOX_SEGMENT_IDS.indexOf("contextGauge") + 1);
	});

	it("stays above the cache row", () => {
		expect(BOX_REQUIRED_SEGMENT_IDS.indexOf("contextGauge")).toBeLessThan(
			BOX_REQUIRED_SEGMENT_IDS.indexOf("cacheMeter"),
		);
	});
});

describe("buildContextGaugeSegment — resting", () => {
	it("rests dim with no numbers until the host reports a window", () => {
		const sample = buildContextGaugeSegment(new ContextGaugeState(), 0, idTheme);
		expect(sample.active).toBe(false);
		expect(sample.variants).toEqual([]);
		expect(sample.line.dot).toBe("idle");
		expect(sample.line.label).toBe("context");
		expect(sample.line.spans).toEqual([{ key: "idle", text: "—", tone: "dim" }]);
	});
});

describe("buildContextGaugeSegment — live line", () => {
	function liveSample(tokens: number, contextWindow = 200_000, percent?: number) {
		const state = new ContextGaugeState(80);
		state.observe(usage(tokens, contextWindow, percent));
		return { sample: buildContextGaugeSegment(state, 0, idTheme), state };
	}

	it("renders the canonical progress bar byte-for-byte and applies quota health only to its fill", () => {
		const { sample } = liveSample(120_000);
		const visual = sample.line.spans[0] as PhraseSpan;
		const pct = sample.line.spans[1] as PhraseSpan;
		const fill = getContextUsageThemeColor(getContextUsageLevel(60, 200_000));
		expect(visual.text).toBe(renderProgressBar(0.75, idTheme, fill, "dim", "unicode"));
		expect(visual.text).toBe("[████████░░]");
		expect(visual.text).not.toContain("\x1b");
		expect(visual.gradient).toEqual({ ratio: 0.75, direction: "down-good" });
		expect(pct.gradient).toBeUndefined();
	});

	it("distinguishes configured budget fill from the model window at different quota settings", () => {
		for (const [quota, fill] of [
			[80, 75],
			[100, 60],
		] as const) {
			const state = new ContextGaugeState(quota);
			state.observe(usage(120_000, 200_000));
			const sample = buildContextGaugeSegment(state, 0, idTheme);
			const snapshot = state.snapshot();
			expect(spanText(sample.line.spans, "pct")).toBe(`${fill}% budget`);
			expect(spanText(sample.line.spans, "headroom")).toBe(
				`${formatNumber(snapshot.headroomTokens)} left of ${formatNumber(snapshot.quotaTokens)}`,
			);
			for (const variant of sample.variants) expect(variant).toContain(`${fill}% budget`);
		}
	});

	it("keeps the ceiling, the burn estimate and the compaction tally on the sheddable tail", () => {
		const state = new ContextGaugeState(80);
		turn(state, 100_000);
		turn(state, 110_000);
		turn(state, 120_000);
		state.noteCompaction();
		state.observe(usage(120_000, 200_000));
		const spans = buildContextGaugeSegment(state, 0, idTheme).line.spans;
		for (const key of ["headroom", "compactions"]) {
			expect(spans.find(span => span.key === key)?.wideOnly).toBe(true);
		}
	});

	it("omits the burn estimate and the compaction tally while neither exists", () => {
		const { sample } = liveSample(120_000);
		expect(spanText(sample.line.spans, "turns")).toBeUndefined();
		expect(spanText(sample.line.spans, "compactions")).toBeUndefined();
	});

	it("names the burn estimate in turns once it has one", () => {
		const state = new ContextGaugeState(80);
		turn(state, 20_000);
		turn(state, 30_000);
		turn(state, 40_000);
		const spans = buildContextGaugeSegment(state, 0, idTheme).line.spans;
		expect(spanText(spans, "turns")).toBe("~12 turns left");
	});

	it("suppresses the burn forecast beyond the useful horizon (>99 turns)", () => {
		const state = new ContextGaugeState(80);
		turn(state, 1_000);
		turn(state, 1_100);
		turn(state, 1_200);
		const spans = buildContextGaugeSegment(state, 0, idTheme).line.spans;
		expect(spanText(spans, "turns")).toBeUndefined();
	});

	it("singularizes a lone remaining turn and a lone compaction", () => {
		const state = new ContextGaugeState(80);
		state.noteCompaction();
		turn(state, 100_000);
		turn(state, 120_000);
		turn(state, 140_000); // 20k/turn average against 20k of headroom
		const spans = buildContextGaugeSegment(state, 0, idTheme).line.spans;
		expect(spanText(spans, "turns")).toBe("~1 turn left");
		expect(spanText(spans, "compactions")).toBe("1 compaction");
	});

	it("escalates the dot and the accent through the host's own threshold bands", () => {
		const bands: readonly [number, StatusDot, ContextUsageLevel][] = [
			[10, "live", "normal"],
			[55, "notable", "warning"],
			[80, "notable", "purple"],
			[95, "alert", "error"],
		];
		for (const [percent, dot, level] of bands) {
			const { sample } = liveSample(Math.round(200_000 * (percent / 100)), 200_000, percent);
			expect(sample.line.dot).toBe(dot);
			expect(sample.line.accent).toBe(getContextUsageThemeColor(level));
		}
	});

	it("sheds the simple-mode ladder widest-first without repeating a rung", () => {
		const { sample } = liveSample(120_000);
		expect(sample.active).toBe(true);
		expect(sample.variants.length).toBeGreaterThan(1);
		const widths = sample.variants.map(variant => variant.length);
		expect(widths).toEqual([...widths].sort((a, b) => b - a));
		expect(new Set(sample.variants).size).toBe(sample.variants.length);
	});

	it("renders the bar at the caller's glyph preset", () => {
		const state = new ContextGaugeState(80);
		state.observe(usage(120_000, 200_000));
		const ascii = buildContextGaugeSegment(state, 0, idTheme, "ascii");
		const bar = ascii.line.spans[0] as PhraseSpan;
		const fill = getContextUsageThemeColor(getContextUsageLevel(60, 200_000));
		expect(bar.text).toBe(renderProgressBar(0.75, idTheme, fill, "dim", "ascii"));
		expect(bar.text).not.toContain("█");
	});

	it("keeps the live bar whole-cell when the host automatically selects the nerd preset", () => {
		const state = new ContextGaugeState(80);
		state.observe(usage(120_000, 200_000));
		const nerd = buildContextGaugeSegment(state, 0, idTheme, "nerd");
		const bar = nerd.line.spans[0] as PhraseSpan;
		expect(bar.text).toBe(`[${"█".repeat(8)}${"░".repeat(2)}]`);
		expect(bar.text).not.toMatch(/[\u2589-\u258f]/u);
	});
});

describe("animationsContextQuota setting", () => {
	it("defaults to the typical compaction threshold", () => {
		expect(resolveAnimationsBoxConfig({}).contextQuota).toBe(CONTEXT_QUOTA_DEFAULT_PERCENT);
	});

	it("takes a stored number or its numeric string form", () => {
		expect(resolveAnimationsBoxConfig({ animationsContextQuota: 60 }).contextQuota).toBe(60);
		expect(resolveAnimationsBoxConfig({ animationsContextQuota: "60" }).contextQuota).toBe(60);
	});

	it("clamps out-of-range values instead of trusting them", () => {
		expect(resolveAnimationsBoxConfig({ animationsContextQuota: 1 }).contextQuota).toBe(CONTEXT_QUOTA_MIN_PERCENT);
		expect(resolveAnimationsBoxConfig({ animationsContextQuota: 300 }).contextQuota).toBe(CONTEXT_QUOTA_MAX_PERCENT);
	});

	it("falls back to the default on garbage rather than throwing", () => {
		expect(resolveAnimationsBoxConfig({ animationsContextQuota: "loads" }).contextQuota).toBe(
			CONTEXT_QUOTA_DEFAULT_PERCENT,
		);
		expect(resolveAnimationsBoxConfig({ animationsContextQuota: {} }).contextQuota).toBe(
			CONTEXT_QUOTA_DEFAULT_PERCENT,
		);
	});

	it("reads the env fallback when nothing is stored", () => {
		expect(resolveAnimationsBoxConfigFromSources({}, { OMP_ANIMATIONS_CONTEXT_QUOTA: "65" }).contextQuota).toBe(65);
		expect(
			resolveAnimationsBoxConfigFromSources({ animationsContextQuota: 55 }, { OMP_ANIMATIONS_CONTEXT_QUOTA: "65" })
				.contextQuota,
		).toBe(55);
	});
});
