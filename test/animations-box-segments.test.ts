import { describe, expect, it } from "bun:test";
import { formatNumber } from "@oh-my-pi/pi-utils";
import {
	buildAuditTrailBoxSegment,
	buildCacheMeterSegment,
	buildRateLimitTidepoolSegment,
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
import { CACHE_METER_COLORS, CacheMeterState } from "../src/cache-meter";
import { ProviderHealthState, RateLimitTidepoolState, refillLevel, TIDEPOOL_COLORS } from "../src/rate-limit-tidepool";

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

	it("distinguishes recent per-request token reuse from session requests with reuse", () => {
		const state = new CacheMeterState();
		state.recordUsage(usageSample("anthropic", "claude", { input: 10_000 }));
		for (let i = 0; i < 10; i++) {
			state.recordUsage(usageSample("anthropic", "claude", { input: 400, cacheRead: 600, cacheWrite: 200 }));
		}
		const sample = buildCacheMeterSegment(state, 999, idTheme);
		const phrase = sample.line.spans.map(span => span.text).join(" · ");
		expect(phrase).toContain("50% recent token reuse");
		expect(phrase).toContain("10/11 session requests with reuse");
		expect(sample.line.spans.find(span => span.key === "pct")?.gradient?.ratio).toBe(0.5);
		for (const variant of sample.variants) {
			if (variant.includes("%")) expect(variant).toMatch(/50% recent token reuse|reuse 50%/u);
			if (variant.includes("/")) expect(variant).toContain("10/11 session requests with reuse");
		}
		const narrow = sample.variants.find(variant => variant.length <= 18);
		expect(narrow).toContain("50%");
		expect(narrow).toMatch(/recent.*reuse/u);
		const smallest = sample.variants.find(variant => variant.length <= 10);
		expect(smallest).toContain("50%");
		expect(smallest).toContain("reuse");
	});

	it("omits money claims in both modes when no savings rate is derivable", () => {
		const sample = buildCacheMeterSegment(warmedState(), 0, idTheme);
		expect(sample.line.spans.some(span => span.key === "saved")).toBe(false);
		expect(sample.line.spans.map(span => span.text).join(" ")).not.toContain("$");
		for (const variant of sample.variants) expect(variant).not.toContain("$");
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

	it("labels the reusable and stored token split without colliding with file operations", () => {
		const state = warmedState();
		const snapshot = state.snapshot();
		const sample = buildCacheMeterSegment(state, 0, idTheme);
		expect(sample.line.spans.slice(3)).toEqual([
			{ key: "read", text: `${formatNumber(snapshot.cacheReadTokens)} reused`, wideOnly: true },
			{ key: "write", text: `${formatNumber(snapshot.cacheWriteTokens)} stored`, wideOnly: true },
		]);
	});

	it("retains invalidation evidence at every compact level without blinking it", () => {
		const state = new CacheMeterState();
		state.recordUsage(usageSample("anthropic", "claude", { cacheRead: 4_000 }));
		state.recordUsage(usageSample("anthropic", "claude", { input: 3_000, cacheWrite: 1_000 }));
		const sample = buildCacheMeterSegment(state, 0, idTheme);
		expect(sample.line.spans[0]?.text).toContain("1 invalidations");
		for (const variant of sample.variants) expect(variant).toContain("1 invalidations");
		expect(buildCacheMeterSegment(state, 1_500, idTheme).variants).toEqual(sample.variants);
	});
});

describe("buildCacheMeterSegment cold workload", () => {
	function uncachedRequests(state: CacheMeterState, count: number): void {
		for (let i = 0; i < count; i++) {
			state.recordUsage(usageSample("ollama", "gpt-oss", { input: 100 }));
		}
	}

	it("keeps reporting measured reuse below the sustained cold-workload floor", () => {
		const state = new CacheMeterState();
		uncachedRequests(state, 7);
		const sample = buildCacheMeterSegment(state, 0, idTheme);
		expect(sample.line.dot).toBe("live");
		expect(sample.line.spans[0]?.key).toBe("pct");
	});

	it("reports only the absence of observed reuse after eight cold requests", () => {
		const state = new CacheMeterState();
		uncachedRequests(state, 8);
		const sample = buildCacheMeterSegment(state, 0, idTheme);
		const phrase = sample.line.spans.map(span => span.text).join(" ");
		expect(phrase).toContain("no reuse observed");
		for (const text of [phrase, ...sample.variants]) {
			expect(text).not.toMatch(/provider|unsupported|unavailable|incapable|n\/a/iu);
			expect(text).not.toContain("$");
		}
	});

	it("stops the no-reuse observation after later reuse, even if subsequent requests are cold", () => {
		const state = new CacheMeterState();
		uncachedRequests(state, 8);
		state.recordUsage(usageSample("ollama", "gpt-oss", { input: 100, cacheRead: 50 }));
		expect(buildCacheMeterSegment(state, 0, idTheme).line.spans[0]?.key).toBe("pct");
		uncachedRequests(state, 20); // more uncached traffic afterwards must not re-latch
		expect(buildCacheMeterSegment(state, 0, idTheme).line.dot).toBe("live");
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
		expect(sample.line.spans.some(span => span.key === "writes")).toBe(false);
		expect(sample.line.spans.some(span => span.key === "poisoned" || span.key === "dirty")).toBe(false);
	});

	it("a dirty path surfaces as an 'edited' notable span and escalates the dot to notable (D3+D6)", () => {
		const state = new AuditLedgerState();
		state.noteWrite("/repo/src/foo.ts", 0);
		const sample = buildAuditTrailBoxSegment(state, 0, idTheme);
		expect(sample.line.dot).toBe("notable");
		expect(sample.line.spans[1]).toEqual({ key: "dirty", text: "1 edited", tone: "notable" });
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

	it("last span is labeled 'last <basename>' of the most recently touched path, wide-only, always the phrase tail (daw.8)", () => {
		const state = new AuditLedgerState();
		state.noteRead("/repo/src/foo.ts");
		state.noteTurn(); // advance the turn clock so bar.ts's touch is unambiguously later
		state.noteWrite("/repo/src/bar.ts", 0);
		const sample = buildAuditTrailBoxSegment(state, 0, idTheme);
		expect(sample.line.spans.at(-1)).toEqual({ key: "last", text: "last bar.ts", wideOnly: true });
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

describe("buildRateLimitTidepoolSegment — 'no data available' never collapses into 'no limits pressure' (daw.5)", () => {
	// daw.5: subagent provider responses never reach this plugin's
	// after_provider_response handler — each subagent turn runs through its
	// own ExtensionRunner instance (node_modules/@oh-my-pi/pi-coding-agent's
	// sdk.ts constructs exactly one ExtensionRunner per process; a plugin's
	// hooks are wired to that instance only), the same host limitation
	// AGENTS.md already documents for AgentRegistry.global(). The row cannot
	// be made to activate for headroom it structurally cannot observe. What
	// this pins instead is that the row never *misreports*: an unobserved
	// session (idle) and a real near-empty-but-observed reading are
	// structurally distinct states, not the same dash read two ways.
	it("idle (never observed) and a real near-zero reading render different dots, activity, and text", () => {
		const idle = buildRateLimitTidepoolSegment(new RateLimitTidepoolState(), 0, idTheme);
		const critical = buildRateLimitTidepoolSegment(
			pooledState(0.02),
			0,
			idTheme,
			undefined,
			undefined,
			healthSnapshot(),
		);

		expect(idle.active).toBe(false);
		expect(idle.line.dot).toBe("idle");
		expect(idle.line.spans).toEqual(IDLE_SPANS);

		expect(critical.active).toBe(true);
		expect(critical.line.dot).toBe("alert");
		// Health + low tidepool: alert dot from tidepool escalation
		expect(critical.line.spans[0]?.key).toBe("status");
		expect(critical.active).toBe(true);
	});

	it("a healthy observed reading also never renders as the idle dash — real low pressure looks nothing like no data", () => {
		const healthy = buildRateLimitTidepoolSegment(
			pooledState(0.95),
			0,
			idTheme,
			undefined,
			undefined,
			healthSnapshot(),
		);
		expect(healthy.active).toBe(true);
		expect(healthy.line.dot).toBe("live");
		expect(healthy.line.spans[0]?.key).toBe("status"); // health leads
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

function healthSnapshot(status = 200, okCount = 1) {
	return { okCount, lastStatus: status, troubleCounts: {}, lastTrouble: undefined };
}

function healthAfter(statuses: readonly number[]) {
	const state = new ProviderHealthState();
	for (const [index, status] of statuses.entries()) state.noteStatus(status, (index + 1) * 1_000);
	const snapshot = state.snapshot();
	if (snapshot === undefined) throw new Error("expected a health snapshot");
	return snapshot;
}

describe("buildRateLimitTidepoolSegment — active line", () => {
	it("variants step from every span, to the narrow-safe spans, to the bare health lead, deduped", () => {
		const state = pooledState(0.784, 12 * 60_000, 0);
		const sample = buildRateLimitTidepoolSegment(state, 0, idTheme, undefined, undefined, healthSnapshot(200, 7));
		expect(sample.active).toBe(true);
		expect(sample.variants).toEqual([
			"http 200 · 7 ok · 78% left · resets 12m · anthropic",
			"http 200 · 7 ok",
			"http 200",
		]);
	});

	it("healthy lead reports the actual last status, not a fixed 200", () => {
		const sample = buildRateLimitTidepoolSegment(
			new RateLimitTidepoolState(),
			0,
			idTheme,
			undefined,
			undefined,
			healthAfter([200, 304]),
		);
		expect(sample.line.dot).toBe("live");
		expect(sample.line.spans.map(span => span.text)).toEqual(["http 304", "2 ok"]);
	});

	it("consecutive-equal variants never repeat (dedupe held)", () => {
		const state = pooledState();
		const sample = buildRateLimitTidepoolSegment(state, 0, idTheme, undefined, undefined, healthSnapshot());
		for (let i = 1; i < sample.variants.length; i++) {
			expect(sample.variants[i]).not.toBe(sample.variants[i - 1]);
		}
	});

	it("pct span is '<N>% left' at the refill-adjusted level as wide-only tail", () => {
		const state = pooledState(0.784);
		const sample = buildRateLimitTidepoolSegment(state, 0, idTheme, undefined, undefined, healthSnapshot());
		expect(sample.line.dot).toBe("live");
		const pctSpan = sample.line.spans.find(s => s.key === "pct");
		expect(pctSpan?.text).toBe("78% left");
		expect(pctSpan?.wideOnly).toBe(true);
		expect(pctSpan?.gradient).toEqual({ ratio: refillLevel(0.784, 0, 0, undefined), direction: "up-good" });
	});

	it("pct span eases toward full as now advances from observedAtMs toward resetAtMs (refillLevel)", () => {
		const state = pooledState(0.5, 10_000, 0);
		const sample = buildRateLimitTidepoolSegment(state, 5_000, idTheme, undefined, undefined, healthSnapshot());
		const expectedLevel = refillLevel(0.5, 5_000, 0, 10_000);
		const pctSpan = sample.line.spans.find(s => s.key === "pct");
		expect(pctSpan?.text).toBe(`${Math.round(expectedLevel * 100)}% left`);
		expect(Math.round(expectedLevel * 100)).not.toBe(50);
	});

	it("provider span trails as wide-only tail", () => {
		const noReset = buildRateLimitTidepoolSegment(pooledState(), 0, idTheme, undefined, undefined, healthSnapshot());
		expect(noReset.line.spans.find(s => s.key === "provider")?.text).toBe("anthropic");
		const withReset = buildRateLimitTidepoolSegment(
			pooledState(0.5, 12 * 60_000, 0),
			0,
			idTheme,
			undefined,
			undefined,
			healthSnapshot(),
		);
		expect(withReset.line.spans.find(s => s.key === "provider")?.text).toBe("anthropic");
	});

	it("reset span is 'resets <N>m' for a reset more than a minute out", () => {
		const state = pooledState(0.5, 12 * 60_000, 0);
		const sample = buildRateLimitTidepoolSegment(state, 0, idTheme, undefined, undefined, healthSnapshot());
		expect(sample.line.spans.find(s => s.key === "reset")?.text).toBe("resets 12m");
	});

	it("reset span is 'resets <N>s' for a sub-minute reset", () => {
		const state = pooledState(0.5, 30_000, 0);
		const sample = buildRateLimitTidepoolSegment(state, 0, idTheme, undefined, undefined, healthSnapshot());
		expect(sample.line.spans.find(s => s.key === "reset")?.text).toBe("resets 30s");
	});

	it("reset span is absent when the binding bucket reported no reset", () => {
		const state = pooledState(0.5, undefined, 0);
		const sample = buildRateLimitTidepoolSegment(state, 0, idTheme, undefined, undefined, healthSnapshot());
		expect(sample.line.spans.some(span => span.key === "reset")).toBe(false);
	});

	it("reset span reads 'resets now' once the reset has already passed", () => {
		const state = pooledState(0.5, 1_000, 0);
		const sample = buildRateLimitTidepoolSegment(state, 5_000, idTheme, undefined, undefined, healthSnapshot());
		expect(sample.line.spans.find(s => s.key === "reset")?.text).toBe("resets now");
	});

	it("keeps the water accent, honoring an accent override", () => {
		const state = pooledState();
		const colors = { ...TIDEPOOL_COLORS, water: "syntaxString" as const };
		const sample = buildRateLimitTidepoolSegment(state, 0, idTheme, colors, undefined, healthSnapshot());
		expect(sample.line.accent).toBe("syntaxString");
	});
});

describe("buildRateLimitTidepoolSegment — dot escalation (D6: alerts persist, no blinking)", () => {
	it("≤ 20% remaining escalates to the notable dot with an amber pct tone replacing the gradient", () => {
		const sample = buildRateLimitTidepoolSegment(
			pooledState(0.2),
			0,
			idTheme,
			undefined,
			undefined,
			healthSnapshot(),
		);
		expect(sample.line.dot).toBe("notable");
		const pctSpan = sample.line.spans.find(s => s.key === "pct");
		expect(pctSpan?.text).toBe("20% left");
		expect(pctSpan?.tone).toBe("notable");
	});

	it("≤ 10% remaining escalates to the alert dot with a red pct tone", () => {
		const sample = buildRateLimitTidepoolSegment(
			pooledState(0.1),
			0,
			idTheme,
			undefined,
			undefined,
			healthSnapshot(),
		);
		expect(sample.line.dot).toBe("alert");
		const pctSpan = sample.line.spans.find(s => s.key === "pct");
		expect(pctSpan?.text).toBe("10% left");
		expect(pctSpan?.tone).toBe("alert");
	});

	it("just above the notable threshold stays live with the gradient", () => {
		const sample = buildRateLimitTidepoolSegment(
			pooledState(0.21),
			0,
			idTheme,
			undefined,
			undefined,
			healthSnapshot(),
		);
		expect(sample.line.dot).toBe("live");
		const pctSpan = sample.line.spans.find(s => s.key === "pct");
		expect(pctSpan?.tone).toBeUndefined();
		expect(pctSpan?.gradient).toEqual({ ratio: refillLevel(0.21, 0, 0, undefined), direction: "up-good" });
	});
});

describe("buildRateLimitTidepoolSegment — provider health trouble", () => {
	it("is idle until the first provider response, even with a pool sample", () => {
		const sample = buildRateLimitTidepoolSegment(pooledState(), 0, idTheme);
		expect(sample.active).toBe(false);
		expect(sample.line.dot).toBe("idle");
	});

	it("lists trouble classes worst-first with their own counts, then the newest failure's status and age", () => {
		// 401 at t=1s, 429 at 2s, 500 at 3s, 200 at 4s → viewed at 10s.
		const sample = buildRateLimitTidepoolSegment(
			new RateLimitTidepoolState(),
			10_000,
			idTheme,
			undefined,
			undefined,
			healthAfter([401, 429, 500, 200]),
		);
		expect(sample.line.spans.map(span => span.text)).toEqual([
			"throttle ×1",
			"server ×1",
			"auth ×1",
			"last 500 7s ago",
			"1 ok",
		]);
		expect(sample.variants.at(-1)).toBe("throttle ×1 · 7s");
	});

	it("holds the alert dot after a trailing 200: one success does not erase five 429s", () => {
		const sample = buildRateLimitTidepoolSegment(
			new RateLimitTidepoolState(),
			60_000,
			idTheme,
			undefined,
			undefined,
			healthAfter([429, 429, 429, 429, 429, 200]),
		);
		expect(sample.line.dot).toBe("alert");
		expect(sample.line.spans[0]).toEqual({ key: "throttle", text: "throttle ×5", tone: "alert" });
		expect(sample.line.spans.find(span => span.key === "ok")?.text).toBe("1 ok");
	});

	it("an unclassified status is notable, not alert, and omits the ok span when nothing succeeded", () => {
		const sample = buildRateLimitTidepoolSegment(
			new RateLimitTidepoolState(),
			1_500,
			idTheme,
			undefined,
			undefined,
			healthAfter([418]),
		);
		expect(sample.line.dot).toBe("notable");
		expect(sample.line.spans.map(span => span.text)).toEqual(["other ×1", "last 418 <1s ago"]);
	});

	it("a near-empty pool escalates a healthy row, but never softens an alerted one", () => {
		const healthyLowPool = buildRateLimitTidepoolSegment(
			pooledState(0.05),
			0,
			idTheme,
			undefined,
			undefined,
			healthSnapshot(),
		);
		expect(healthyLowPool.line.dot).toBe("alert");
		const troubledFullPool = buildRateLimitTidepoolSegment(
			pooledState(1),
			2_000,
			idTheme,
			undefined,
			undefined,
			healthAfter([500]),
		);
		expect(troubledFullPool.line.dot).toBe("alert");
		const troubledNotablePool = buildRateLimitTidepoolSegment(
			pooledState(0.15),
			2_000,
			idTheme,
			undefined,
			undefined,
			healthAfter([500]),
		);
		expect(troubledNotablePool.line.dot).toBe("alert");
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

	it("counts every call and keeps file tools out of the compact category breakdown", () => {
		const sample = buildToolActivitySegment(stateWith("read", "read", "edit", "bash"), 0, idTheme);
		expect(sample.active).toBe(true);
		expect(sample.line.dot).toBe("live");
		expect(sample.line.activity).toBe(false);
		expect(sample.line.spans).toEqual([
			{ key: "total", text: "4 calls" },
			{ key: "cat:bash", text: "bash (1)" },
		]);
	});

	it("singularizes a lone call without adding internal phase terminology", () => {
		const sample = buildToolActivitySegment(stateWith("write"), 0, idTheme);
		expect(sample.line.spans[0]?.text).toBe("1 call");
		expect(sample.variants).toEqual(["1 call"]);
	});

	it("orders the category breakdown busiest-first and caps it at two categories", () => {
		const sample = buildToolActivitySegment(
			stateWith("grep", "glob", "grep", "bash", "task", "task", "task", "task"),
			0,
			idTheme,
		);
		expect(sample.line.spans).toEqual([
			{ key: "total", text: "8 calls" },
			{ key: "cat:agent", text: "agent (4)" },
			{ key: "cat:search", text: "search (3)" },
		]);
	});

	it("breaks tied categories by display order and classifies MCP plus unknown tools", () => {
		const tie = buildToolActivitySegment(stateWith("task", "bash"), 0, idTheme);
		expect(tie.line.spans.map(span => span.text)).toEqual(["2 calls", "bash (1)", "agent (1)"]);

		const bridges = buildToolActivitySegment(stateWith("mcp__qmd_query", "some_plugin_tool"), 0, idTheme);
		expect(bridges.line.spans.map(span => span.text)).toEqual(["2 calls", "mcp (1)", "other (1)"]);
	});

	it("leads with the active tool and elapsed time, then pulses the row", () => {
		const state = stateWith("bash", "read");
		state.start("bash", "bash", 100);
		state.start("read", "read", 200);
		const sample = buildToolActivitySegment(state, 4_900, idTheme);
		expect(sample.line.activity).toBe(true);
		expect(sample.line.spans.slice(0, 3)).toEqual([
			{ key: "active", text: "bash" },
			{ key: "elapsed", text: "4.8s active", flash: false },
			{ key: "total", text: "2 calls" },
		]);
	});

	it("keeps settled latency statistics out of the display row", () => {
		const state = new ToolActivityState();
		const samples = [
			["read", 100],
			["read", 200],
			["read", 300],
			["read", 400],
			["bash", 4_800],
		] as const;
		for (const [index, [toolName, duration]] of samples.entries()) {
			const id = String(index);
			state.record(toolName);
			state.start(id, toolName, index * 10_000);
			state.end(id, toolName, false, index * 10_000 + duration);
		}
		state.settle();
		const sample = buildToolActivitySegment(state, 50_000, idTheme);
		expect(sample.line.activity).toBe(false);
		expect(sample.line.spans).toEqual([
			{ key: "total", text: "5 calls" },
			{ key: "cat:bash", text: "bash (1)" },
		]);
	});

	it("spells the simple-mode ladder from categories down to the bare total", () => {
		const sample = buildToolActivitySegment(stateWith("bash", "bash", "grep"), 0, idTheme);
		expect(sample.variants).toEqual(["3 calls · bash (2) · search (1)", "3 calls"]);
	});

	it("uses one accent for the whole row", () => {
		const bash = buildToolActivitySegment(stateWith("bash"), 0, idTheme);
		const agent = buildToolActivitySegment(stateWith("task"), 0, idTheme);
		expect(bash.line.accent).toBe(agent.line.accent);
		expect(bash.line.accent).not.toBe("dim");
	});
});
