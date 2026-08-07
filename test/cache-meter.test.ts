import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import type { ExtensionCommandContext, ExtensionContext } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import type { MessageEndEvent } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { accentColorKey, animationsEnvKey, placementKey } from "../src/appearance";
import { CACHE_METER_COMMAND, type CacheMeterExtensionOptions, createCacheMeterExtension } from "../src/cache-meter";
import { type CacheMeterContext, CacheMeterController, WIDGET_KEY } from "../src/cache-meter/controller";
import {
	ATTRIBUTION_WINDOW_MS,
	CacheMeterState,
	type CacheUsageSample,
	detectCacheInvalidation,
	MIN_CACHE_FOOTPRINT,
	WARMTH_WINDOW,
} from "../src/cache-meter/state";
import {
	badgeGlyph,
	badgePulseGlyph,
	CACHE_METER_COLORS,
	CacheMeterWidget,
	easedHitRate,
	HIT_RATE_EASE_DURATION_MS,
	INVALIDATION_ALERT_DURATION_MS,
	INVALIDATION_BLINK_PERIOD_MS,
	invalidationGlyph,
	renderCacheMeterOffText,
	renderCacheMeterPanel,
	renderCacheMeterRow,
} from "../src/cache-meter/widget";
import { AnimationHost, type FrameScheduler, MotionPolicy } from "../src/kit";
import { ANIMATIONS, createAnimationsPlugin } from "../src/registrar";

// Identity theme so assertions see plain text instead of ANSI escapes.
const idTheme = { fg: (_color: string, text: string) => text };
// Color-tagging theme for tests that need to assert which color token the renderer chose.
const taggedTheme = { fg: (color: string, text: string) => `${color}:${text}` };
const WIDE = 200;

// Unicode-tier glyphs, resolved once — every renderer call below defaults to `"unicode"`.
const BADGE_GLYPH = badgeGlyph("unicode");
const BADGE_PULSE_GLYPH = badgePulseGlyph("unicode");
const INVALIDATION_GLYPH = invalidationGlyph("unicode");

/** Manual frame scheduler: drives host ticks and the shared clock deterministically. */
function manualScheduler(): FrameScheduler & { advance(ms: number): void; readonly running: boolean } {
	let current = 0;
	let ticker: (() => void) | undefined;
	return {
		now: () => current,
		start(_intervalMs, tick) {
			ticker = tick;
			return () => {
				ticker = undefined;
			};
		},
		advance(ms) {
			current += ms;
			ticker?.();
		},
		get running() {
			return ticker !== undefined;
		},
	};
}

const noopTui = { requestComponentRender: () => {} };
const fullEnv = { hasUI: true, isTTY: true, env: {} as Record<string, string | undefined> };

/** One finalized-request sample, with sane defaults for the fields a given test doesn't care about. */
function usageSample(provider: string, model: string, usage: Partial<CacheUsageSample> = {}) {
	return {
		provider,
		model,
		usage: { input: 0, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 10, ...usage },
	};
}

// ═══════════════════════════════════════════════════════════════════════════
// Glyph presets
// ═══════════════════════════════════════════════════════════════════════════

describe("cache meter glyphs (preset-aware)", () => {
	it("badgeGlyph/badgePulseGlyph/invalidationGlyph default to unicode, byte-identical to the original hardcoded values", () => {
		expect(badgeGlyph()).toBe("▤");
		expect(badgePulseGlyph()).toBe("▥");
		expect(invalidationGlyph()).toBe("⊘");
	});

	it("ascii substitutes are exact one-column values, distinct from one another", () => {
		expect(badgeGlyph("ascii")).toBe("#");
		expect(badgePulseGlyph("ascii")).toBe("*");
		expect(invalidationGlyph("ascii")).toBe("x");
		const glyphs = [badgeGlyph("ascii"), badgePulseGlyph("ascii"), invalidationGlyph("ascii")];
		expect(new Set(glyphs).size).toBe(glyphs.length);
		for (const glyph of glyphs) {
			expect(glyph).toHaveLength(1);
			expect(glyph.charCodeAt(0)).toBeLessThan(128);
		}
	});

	it("nerd aliases unicode exactly", () => {
		expect(badgeGlyph("nerd")).toBe(badgeGlyph("unicode"));
		expect(badgePulseGlyph("nerd")).toBe(badgePulseGlyph("unicode"));
		expect(invalidationGlyph("nerd")).toBe(invalidationGlyph("unicode"));
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// State aggregation
// ═══════════════════════════════════════════════════════════════════════════

describe("cache meter state aggregation", () => {
	it("keeps cache reads, writes, and provider-reported uncached input as independent buckets", () => {
		const state = new CacheMeterState();
		expect(
			state.recordUsage(usageSample("anthropic", "claude", { input: 200, cacheRead: 800, cacheWrite: 100 }))
				.recorded,
		).toBe(true);
		expect(
			state.recordUsage(usageSample("anthropic", "claude", { input: 50, cacheRead: 0, cacheWrite: 50 })).recorded,
		).toBe(true);

		const snapshot = state.snapshot();
		expect(snapshot).toMatchObject({
			requestCount: 2,
			hitCount: 1,
			cacheReadTokens: 800,
			cacheWriteTokens: 150,
			missTokens: 250,
			promptTokens: 1_200,
		});
		expect(snapshot.cacheReadTokens + snapshot.cacheWriteTokens + snapshot.missTokens).toBe(snapshot.promptTokens);
		expect(snapshot.hitRate).toBeCloseTo(800 / 1_200, 10);
	});

	it("rejects unmetered responses and normalizes invalid provider buckets without inventing a hit", () => {
		const state = new CacheMeterState();
		expect(state.recordUsage(usageSample("a", "m", { input: 0, cacheRead: 0, cacheWrite: 0 })).recorded).toBe(false);
		expect(
			state.recordUsage(
				usageSample("a", "m", { input: 10, cacheRead: Number.NaN, cacheWrite: Number.POSITIVE_INFINITY }),
			).recorded,
		).toBe(true);
		expect(state.recordUsage(usageSample("a", "m", { input: -5, cacheRead: 9, cacheWrite: -2 })).recorded).toBe(true);

		expect(state.snapshot()).toMatchObject({
			requestCount: 2,
			hitCount: 1,
			cacheReadTokens: 9,
			cacheWriteTokens: 0,
			missTokens: 10,
			promptTokens: 19,
		});
	});

	it("groups totals per provider+model, independent of the session-wide total, in first-seen order", () => {
		const state = new CacheMeterState();
		state.recordUsage(usageSample("anthropic", "claude-opus", { input: 100, cacheRead: 900 }));
		state.recordUsage(usageSample("google", "gemini-3", { input: 500, cacheRead: 0 }));
		state.recordUsage(usageSample("anthropic", "claude-opus", { input: 0, cacheRead: 1000 }));

		const snapshot = state.snapshot();
		expect(snapshot.requestCount).toBe(3);
		expect(snapshot.groups).toHaveLength(2);
		expect(snapshot.groups.map(g => g.provider)).toEqual(["anthropic", "google"]);
		expect(snapshot.groups[0]).toMatchObject({
			provider: "anthropic",
			model: "claude-opus",
			requestCount: 2,
			hitCount: 2,
			cacheReadTokens: 1_900,
			missTokens: 100,
		});
		expect(snapshot.groups[1]).toMatchObject({
			provider: "google",
			model: "gemini-3",
			requestCount: 1,
			hitCount: 0,
			missTokens: 500,
		});
	});

	it("an all-invalid/zero sample never creates a group at all", () => {
		const state = new CacheMeterState();
		state.recordUsage(usageSample("a", "m", { input: 0, cacheRead: 0, cacheWrite: 0 }));
		expect(state.snapshot().groups).toEqual([]);
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// Cache invalidation detection (ported semantics)
// ═══════════════════════════════════════════════════════════════════════════

describe("detectCacheInvalidation (pure port of the host's own detector)", () => {
	it("never flags the first request for a lineage", () => {
		expect(detectCacheInvalidation(undefined, { input: 5_000, cacheRead: 0, cacheWrite: 5_000 })).toBe(false);
	});

	it("never flags when the previous request's cacheRead sat below the footprint floor", () => {
		expect(
			detectCacheInvalidation(
				{ input: 0, cacheRead: MIN_CACHE_FOOTPRINT - 1, cacheWrite: 0 },
				{ input: 5_000, cacheRead: 0, cacheWrite: 5_000 },
			),
		).toBe(false);
	});

	it("never flags a request that still reused some cache", () => {
		expect(
			detectCacheInvalidation(
				{ input: 0, cacheRead: 5_000, cacheWrite: 0 },
				{ input: 100, cacheRead: 1, cacheWrite: 5_000 },
			),
		).toBe(false);
	});

	it("never flags an implicit-cache provider's routine cacheRead-to-zero noise (cacheWrite always 0)", () => {
		// Google/OpenAI/Fireworks: a warm prefix, then a turn where cacheRead collapsed
		// to 0 and cacheWrite is 0 — propagation noise, not a real invalidation.
		expect(
			detectCacheInvalidation(
				{ input: 0, cacheRead: 6_000, cacheWrite: 0 },
				{ input: 6_000, cacheRead: 0, cacheWrite: 0 },
			),
		).toBe(false);
	});

	it("flags an explicit-cache provider's warm -> cold transition (cacheWrite > 0 recreates the prefix)", () => {
		expect(
			detectCacheInvalidation(
				{ input: 0, cacheRead: 6_000, cacheWrite: 0 },
				{ input: 100, cacheRead: 0, cacheWrite: 6_000 },
			),
		).toBe(true);
	});

	it("never flags when the reprocessed total stays under the footprint floor", () => {
		expect(
			detectCacheInvalidation(
				{ input: 0, cacheRead: 6_000, cacheWrite: 0 },
				{ input: 10, cacheRead: 0, cacheWrite: 10 },
			),
		).toBe(false);
	});
});

describe("cache meter state — invalidation accounting scoped per provider+model", () => {
	it("scopes the baseline per lineage — switching provider/model never falsely invalidates", () => {
		const state = new CacheMeterState();
		state.recordUsage(usageSample("anthropic", "claude", { cacheRead: 6_000 }));
		const { invalidated } = state.recordUsage(usageSample("google", "gemini-3", { input: 100 }));
		expect(invalidated).toBe(false);
		expect(state.snapshot().invalidationCount).toBe(0);
	});

	it("counts an explicit-cache provider's cold turn on both the session total and its own group", () => {
		const state = new CacheMeterState();
		state.recordUsage(usageSample("anthropic", "claude", { cacheRead: 6_000 }));
		const { invalidated } = state.recordUsage(
			usageSample("anthropic", "claude", { input: 6_000, cacheWrite: 6_000 }),
		);
		expect(invalidated).toBe(true);

		const snapshot = state.snapshot();
		expect(snapshot.invalidationCount).toBe(1);
		expect(snapshot.groups[0]).toMatchObject({ provider: "anthropic", invalidationCount: 1 });
	});

	it("never flags an implicit-cache provider's cacheRead noise, even across repeated warm/cold cycles", () => {
		const state = new CacheMeterState();
		state.recordUsage(usageSample("google", "gemini-3", { cacheRead: 6_000 }));
		state.recordUsage(usageSample("google", "gemini-3", { input: 6_000 }));
		state.recordUsage(usageSample("google", "gemini-3", { cacheRead: 6_000 }));
		state.recordUsage(usageSample("google", "gemini-3", { input: 6_000 }));
		expect(state.snapshot().invalidationCount).toBe(0);
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// Dollar cost accounting and savings derivation (Usage.cost)
// ═══════════════════════════════════════════════════════════════════════════

describe("cache meter state — cost accounting", () => {
	it("accumulates Usage.cost session-wide and per group, independent of each other", () => {
		const state = new CacheMeterState();
		state.recordUsage(
			usageSample("anthropic", "claude", {
				input: 100,
				cacheRead: 900,
				cacheWrite: 50,
				cost: { input: 0.25, output: 0.125, cacheRead: 0.0625, cacheWrite: 0.03125, total: 0.5 },
			}),
		);
		state.recordUsage(
			usageSample("google", "gemini-3", {
				input: 200,
				cost: { input: 0.5, output: 0.25, cacheRead: 0, cacheWrite: 0, total: 0.75 },
			}),
		);

		const snapshot = state.snapshot();
		expect(snapshot).toMatchObject({
			costTotal: 1.25,
			costInput: 0.75,
			costOutput: 0.375,
			costCacheRead: 0.0625,
			costCacheWrite: 0.03125,
		});
		expect(snapshot.groups.find(g => g.provider === "anthropic")).toMatchObject({ costTotal: 0.5 });
		expect(snapshot.groups.find(g => g.provider === "google")).toMatchObject({ costTotal: 0.75 });
	});

	it("leaves every cost bucket at zero when no request ever carries Usage.cost", () => {
		const state = new CacheMeterState();
		state.recordUsage(usageSample("anthropic", "claude", { input: 400, cacheRead: 600, cacheWrite: 200 }));
		expect(state.snapshot()).toMatchObject({
			costTotal: 0,
			costInput: 0,
			costOutput: 0,
			costCacheRead: 0,
			costCacheWrite: 0,
		});
	});

	it("accumulates the Anthropic cttl split session-wide and per group, leaving it at zero for other providers", () => {
		const state = new CacheMeterState();
		state.recordUsage(
			usageSample("anthropic", "claude", { cacheWrite: 500, cttl: { ephemeral5m: 300, ephemeral1h: 200 } }),
		);
		state.recordUsage(usageSample("google", "gemini-3", { cacheWrite: 500 }));

		const snapshot = state.snapshot();
		expect(snapshot).toMatchObject({ cttlEphemeral5m: 300, cttlEphemeral1h: 200 });
		expect(snapshot.groups.find(g => g.provider === "anthropic")).toMatchObject({
			cttlEphemeral5m: 300,
			cttlEphemeral1h: 200,
		});
		expect(snapshot.groups.find(g => g.provider === "google")).toMatchObject({
			cttlEphemeral5m: 0,
			cttlEphemeral1h: 0,
		});
	});

	it("never fabricates a saved-cost figure for a group that has never had a derivable rate", () => {
		const state = new CacheMeterState();
		state.recordUsage(usageSample("z", "nocost", { input: 500, cacheRead: 500 }));
		const snapshot = state.snapshot();
		expect(snapshot.groups[0]?.savedCost).toBeUndefined();
		expect(snapshot.savedCost).toBeUndefined();
	});

	it("derives a group's savings from its own most recent full-price rate, applied to a later cache-heavy request", () => {
		const state = new CacheMeterState();
		// No cache reads yet, but this establishes anthropic/claude's rate: $1 / 1,000 tokens.
		state.recordUsage(
			usageSample("anthropic", "claude", {
				input: 1_000,
				cost: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0, total: 1 },
			}),
		);
		// 1,000 cache-read tokens would cost $1 at that rate; this request actually paid $0.10 for them.
		state.recordUsage(
			usageSample("anthropic", "claude", {
				cacheRead: 1_000,
				cost: { input: 0, output: 0, cacheRead: 0.1, cacheWrite: 0, total: 0.1 },
			}),
		);

		const snapshot = state.snapshot();
		expect(snapshot.groups[0]?.savedCost).toBeCloseTo(0.9, 10);
		expect(snapshot.savedCost).toBeCloseTo(0.9, 10);
	});

	it("prices a request's own cache reads against the rate that same request derives, when it carries both", () => {
		const state = new CacheMeterState();
		state.recordUsage(
			usageSample("anthropic", "claude", {
				input: 1_000,
				cacheRead: 500,
				cost: { input: 1, output: 0, cacheRead: 0.05, cacheWrite: 0, total: 1.05 },
			}),
		);
		expect(state.snapshot().groups[0]?.savedCost).toBeCloseTo(0.45, 10);
	});

	it("reports a defined $0 saved once a rate is known, even before any cache read has happened — never omitted", () => {
		const state = new CacheMeterState();
		state.recordUsage(
			usageSample("anthropic", "claude", {
				input: 1_000,
				cost: { input: 1.5, output: 0, cacheRead: 0, cacheWrite: 0, total: 1.5 },
			}),
		);
		expect(state.snapshot().savedCost).toBe(0);
	});

	it("keeps each group's own rate independent — a pricier group's rate never leaks into a cheaper group's savings", () => {
		const state = new CacheMeterState();
		state.recordUsage(
			usageSample("anthropic", "claude", {
				input: 1_000,
				cost: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0, total: 1 },
			}),
		); // anthropic rate: $0.001/token
		state.recordUsage(
			usageSample("google", "gemini-3", {
				input: 1_000,
				cost: { input: 4, output: 0, cacheRead: 0, cacheWrite: 0, total: 4 },
			}),
		); // google rate: $0.004/token — 4x anthropic's
		state.recordUsage(
			usageSample("anthropic", "claude", {
				cacheRead: 1_000,
				cost: { input: 0, output: 0, cacheRead: 0.2, cacheWrite: 0, total: 0.2 },
			}),
		); // priced at anthropic's own rate: 1_000 * 0.001 - 0.2 = 0.8
		state.recordUsage(
			usageSample("google", "gemini-3", {
				cacheRead: 1_000,
				cost: { input: 0, output: 0, cacheRead: 0.2, cacheWrite: 0, total: 0.2 },
			}),
		); // priced at google's own rate: 1_000 * 0.004 - 0.2 = 3.8

		const snapshot = state.snapshot();
		expect(snapshot.groups.find(g => g.provider === "anthropic")?.savedCost).toBeCloseTo(0.8, 10);
		expect(snapshot.groups.find(g => g.provider === "google")?.savedCost).toBeCloseTo(3.8, 10);
		expect(snapshot.savedCost).toBeCloseTo(4.6, 10);
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// Invalidation-cause attribution (compact / auto-compact / session-switch / model-switch)
// ═══════════════════════════════════════════════════════════════════════════

describe("cache meter state — invalidation attribution", () => {
	/** Warms a lineage, then collapses it cold — the same shape every other invalidation test uses, parameterized on timestamps. */
	function warmThenCold(state: CacheMeterState, atMsWarm: number, atMsCold: number) {
		state.recordUsage(usageSample("anthropic", "claude", { cacheRead: 6_000 }), atMsWarm);
		return state.recordUsage(usageSample("anthropic", "claude", { input: 6_000, cacheWrite: 6_000 }), atMsCold);
	}

	it("credits a manual compact recorded within the attribution window", () => {
		const state = new CacheMeterState();
		state.recordEvent("compact", 1_000);
		const { invalidated } = warmThenCold(state, 500, 1_000 + ATTRIBUTION_WINDOW_MS);
		expect(invalidated).toBe(true);
		expect(state.snapshot().invalidations).toEqual([{ cause: "compact", atMs: 1_000 + ATTRIBUTION_WINDOW_MS }]);
	});

	it("credits an auto-compact as a cause distinct from a manual compact", () => {
		const state = new CacheMeterState();
		state.recordEvent("auto-compact", 2_000);
		warmThenCold(state, 1_500, 2_500);
		expect(state.snapshot().invalidations[0]?.cause).toBe("auto-compact");
	});

	it("credits a session-switch event", () => {
		const state = new CacheMeterState();
		state.recordEvent("session-switch", 3_000);
		warmThenCold(state, 2_900, 3_050);
		expect(state.snapshot().invalidations[0]?.cause).toBe("session-switch");
	});

	it("detects a provider/model switch on its own, and credits it when the original model comes back cold", () => {
		const state = new CacheMeterState();
		state.recordUsage(usageSample("anthropic", "claude", { cacheRead: 6_000 }), 0); // warms claude
		state.recordUsage(usageSample("google", "gemini-3", { input: 100 }), 100); // switches away
		const { invalidated } = state.recordUsage(
			usageSample("anthropic", "claude", { input: 6_000, cacheWrite: 6_000 }),
			150,
		); // back to claude, cold
		expect(invalidated).toBe(true);
		expect(state.snapshot().invalidations.at(-1)?.cause).toBe("model-switch");
	});

	it("falls back to unattributed once the most recent event has aged out of the attribution window", () => {
		const state = new CacheMeterState();
		state.recordEvent("compact", 0);
		warmThenCold(state, ATTRIBUTION_WINDOW_MS, 2 * ATTRIBUTION_WINDOW_MS + 1);
		expect(state.snapshot().invalidations[0]?.cause).toBe("unattributed");
	});

	it("is unattributed when no event was ever recorded", () => {
		const state = new CacheMeterState();
		warmThenCold(state, 0, 10);
		expect(state.snapshot().invalidations[0]?.cause).toBe("unattributed");
	});

	it("invalidationCount matches invalidations.length while the session stays under the retention cap", () => {
		const state = new CacheMeterState();
		state.recordUsage(usageSample("a", "m1", { cacheRead: 6_000 }), 0);
		state.recordUsage(usageSample("a", "m1", { input: 6_000, cacheWrite: 6_000 }), 10);
		state.recordUsage(usageSample("b", "m2", { cacheRead: 6_000 }), 20);
		state.recordUsage(usageSample("b", "m2", { input: 6_000, cacheWrite: 6_000 }), 30);

		const snapshot = state.snapshot();
		expect(snapshot.invalidationCount).toBe(2);
		expect(snapshot.invalidationCount).toBe(snapshot.invalidations.length);
	});

	it("invalidationCount is the true uncapped total even once retention caps invalidations at 20", () => {
		const state = new CacheMeterState();
		for (let i = 0; i < 25; i++) {
			state.recordUsage(usageSample("p", "m", { cacheRead: 6_000 }), i * 1_000);
			state.recordUsage(usageSample("p", "m", { input: 6_000, cacheWrite: 6_000 }), i * 1_000 + 500);
		}
		const snapshot = state.snapshot();
		// "How many times did this happen" (25) and "what were the recent ones" (20 retained)
		// are different questions — the count must never saturate at the retention cap.
		expect(snapshot.invalidationCount).toBe(25);
		expect(snapshot.invalidations).toHaveLength(20);
		// Oldest five (atMs 500..4500) were dropped; the retained window starts at the 6th invalidation.
		expect(snapshot.invalidations[0]?.atMs).toBe(5 * 1_000 + 500);
	});

	it("a single group's invalidationCount never exceeds the session total, even past the retention cap", () => {
		const state = new CacheMeterState();
		for (let i = 0; i < 25; i++) {
			state.recordUsage(usageSample("p", "m", { cacheRead: 6_000 }), i * 1_000);
			state.recordUsage(usageSample("p", "m", { input: 6_000, cacheWrite: 6_000 }), i * 1_000 + 500);
		}
		const snapshot = state.snapshot();
		expect(snapshot.groups[0]?.invalidationCount).toBe(25);
		expect(snapshot.groups[0]?.invalidationCount).toBeLessThanOrEqual(snapshot.invalidationCount);
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// Rolling warmth window (live "is the cache warm right now" signal)
// ═══════════════════════════════════════════════════════════════════════════

describe("cache meter state — rolling warmth window", () => {
	it("is 0 before anything is recorded", () => {
		expect(new CacheMeterState().snapshot().warmth).toBe(0);
		expect(new CacheMeterState().snapshot().warmthWindow).toEqual([]);
	});

	it("is the mean of every request's own hit fraction while the window is still filling", () => {
		const state = new CacheMeterState();
		state.recordUsage(usageSample("a", "m", { cacheRead: 100 })); // ratio 1.0
		state.recordUsage(usageSample("a", "m", { input: 100 })); // ratio 0.0
		const snapshot = state.snapshot();
		expect(snapshot.warmthWindow).toEqual([1, 0]);
		expect(snapshot.warmth).toBeCloseTo(0.5, 10);
	});

	it("evicts exactly the oldest entry once a request arrives past WARMTH_WINDOW capacity", () => {
		const state = new CacheMeterState();
		// Fill the window with WARMTH_WINDOW cold requests (ratio 0), then one more, still cold —
		// warmth should stay pinned at 0 throughout, since eviction only ever drops the oldest.
		for (let i = 0; i < WARMTH_WINDOW; i++) state.recordUsage(usageSample("a", "m", { input: 100 }));
		expect(state.snapshot().warmthWindow).toHaveLength(WARMTH_WINDOW);
		expect(state.snapshot().warmth).toBe(0);

		// The WARMTH_WINDOW + 1st request is a full hit — it must evict the single oldest
		// cold entry, not reset or grow the window.
		state.recordUsage(usageSample("a", "m", { cacheRead: 100 }));
		const snapshot = state.snapshot();
		expect(snapshot.warmthWindow).toHaveLength(WARMTH_WINDOW);
		expect(snapshot.warmthWindow.at(-1)).toBe(1);
		expect(snapshot.warmth).toBeCloseTo(1 / WARMTH_WINDOW, 10);
	});

	it("is session-wide, not scoped per provider/model group", () => {
		const state = new CacheMeterState();
		state.recordUsage(usageSample("anthropic", "claude", { cacheRead: 100 }));
		state.recordUsage(usageSample("google", "gemini-3", { input: 100 }));
		expect(state.snapshot().warmthWindow).toEqual([1, 0]);
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// Row renderer — width tiers, invalidation cell, blink phase
// ═══════════════════════════════════════════════════════════════════════════

describe("cache meter row (compact surface) — width tiers", () => {
	function fixtureSnapshot() {
		const state = new CacheMeterState();
		state.recordUsage(usageSample("anthropic", "claude", { input: 400, cacheRead: 600, cacheWrite: 200 }));
		return state.snapshot();
	}

	/** Same shape as `fixtureSnapshot`, but with cost telemetry that derives a savings figure. */
	function costedFixtureSnapshot() {
		const state = new CacheMeterState();
		state.recordUsage(
			usageSample("anthropic", "claude", {
				input: 400,
				cacheRead: 600,
				cacheWrite: 200,
				cost: { input: 0.3, output: 0.05, cacheRead: 0.02, cacheWrite: 0.01, total: 0.38 },
			}),
		);
		return state.snapshot();
	}

	it("full tier (no derivable savings): hit-led fallback, sparkline, badge — no bar, at the exact width it needs", () => {
		const row = renderCacheMeterRow(fixtureSnapshot(), 47, 0, idTheme, "subtle");
		expect(row).toBe(`${BADGE_GLYPH} HIT 50.0% (1/1) ▅ READ 600 WRITE 200 MISS 400`);
	});

	it("threads a live preset into the row's badge glyph — not just the default", () => {
		const row = renderCacheMeterRow(
			fixtureSnapshot(),
			47,
			0,
			idTheme,
			"subtle",
			undefined,
			false,
			undefined,
			"ascii",
		);
		expect(row.startsWith(badgeGlyph("ascii"))).toBe(true);
		expect(row).not.toContain(badgeGlyph("unicode"));
	});

	it("full tier (savings derivable): SAVED leads, sparkline, hit fraction demoted — at the exact width it needs", () => {
		const snapshot = costedFixtureSnapshot();
		expect(snapshot.savedCost).toBeCloseTo(0.43, 10);
		const row = renderCacheMeterRow(snapshot, 59, 0, idTheme, "subtle");
		expect(row).toBe(`${BADGE_GLYPH} SAVED $0.43 ▅ HIT 50.0% (1/1) READ 600 WRITE 200 MISS 400`);
	});

	it("wide tier (no derivable savings): abbreviated hit-led fallback + sparkline, one column under full's exact width", () => {
		const row = renderCacheMeterRow(fixtureSnapshot(), 46, 0, idTheme, "subtle");
		expect(row).toBe(`${BADGE_GLYPH} H 50.0% (1/1) ▅ R 600 W 200 M 400`);
	});

	it("wide tier (no derivable savings) holds at its own exact width", () => {
		const row = renderCacheMeterRow(fixtureSnapshot(), 35, 0, idTheme, "subtle");
		expect(row).toBe(`${BADGE_GLYPH} H 50.0% (1/1) ▅ R 600 W 200 M 400`);
	});

	it("wide tier (savings derivable): SAVED + sparkline survive the abbreviation, one column under full's exact width", () => {
		const row = renderCacheMeterRow(costedFixtureSnapshot(), 58, 0, idTheme, "subtle");
		expect(row).toBe(`${BADGE_GLYPH} SAVED $0.43 ▅ H 50.0% (1/1) R 600 W 200 M 400`);
	});

	it("wide tier (savings derivable) holds at its own exact width", () => {
		const row = renderCacheMeterRow(costedFixtureSnapshot(), 47, 0, idTheme, "subtle");
		expect(row).toBe(`${BADGE_GLYPH} SAVED $0.43 ▅ H 50.0% (1/1) R 600 W 200 M 400`);
	});

	it("counts tier: drops money and the sparkline, one column under wide's own exact width — identical whether or not savings are derivable", () => {
		const withoutSavings = renderCacheMeterRow(fixtureSnapshot(), 34, 0, idTheme, "subtle");
		const withSavings = renderCacheMeterRow(costedFixtureSnapshot(), 46, 0, idTheme, "subtle");
		expect(withoutSavings).toBe(`${BADGE_GLYPH} H 50.0% (1/1) R 600 W 200 M 400`);
		expect(withSavings).toBe(withoutSavings);
	});

	it("counts tier holds at its own exact width", () => {
		const row = renderCacheMeterRow(fixtureSnapshot(), 33, 0, idTheme, "subtle");
		expect(row).toBe(`${BADGE_GLYPH} H 50.0% (1/1) R 600 W 200 M 400`);
	});

	it("headline tier: a single hit-rate number, one column under the counts tier", () => {
		const row = renderCacheMeterRow(fixtureSnapshot(), 32, 0, idTheme, "subtle");
		expect(row).toBe(`${BADGE_GLYPH} 50.0%`);
	});

	it("headline tier holds at its own exact width", () => {
		const row = renderCacheMeterRow(fixtureSnapshot(), 7, 0, idTheme, "subtle");
		expect(row).toBe(`${BADGE_GLYPH} 50.0%`);
	});

	it("bare badge: one column under the headline tier, and at width 1", () => {
		expect(renderCacheMeterRow(fixtureSnapshot(), 6, 0, idTheme, "subtle")).toBe(BADGE_GLYPH);
		expect(renderCacheMeterRow(fixtureSnapshot(), 1, 0, idTheme, "subtle")).toBe(BADGE_GLYPH);
	});

	it("renders nothing at all at zero or negative width", () => {
		expect(renderCacheMeterRow(fixtureSnapshot(), 0, 0, idTheme, "subtle")).toBe("");
		expect(renderCacheMeterRow(fixtureSnapshot(), -10, 0, idTheme, "subtle")).toBe("");
	});

	it("says there is no telemetry yet before anything is tracked, and shrinks to the badge", () => {
		const empty = new CacheMeterState().snapshot();
		expect(renderCacheMeterRow(empty, WIDE, 0, idTheme, "subtle")).toBe(
			`${BADGE_GLYPH} no prompt-cache telemetry yet`,
		);
		expect(renderCacheMeterRow(empty, 3, 0, idTheme, "subtle")).toBe(BADGE_GLYPH);
	});

	it("every degradation tier stays inside its width budget", () => {
		const state = new CacheMeterState();
		state.recordUsage(usageSample("anthropic", "claude", { cacheRead: 6_000 }));
		state.recordUsage(usageSample("anthropic", "claude", { input: 6_000, cacheWrite: 6_000 }));
		const snapshot = state.snapshot();
		for (let width = 1; width <= 80; width++) {
			expect(renderCacheMeterRow(snapshot, width, 0, idTheme, "subtle").length).toBeLessThanOrEqual(width);
		}
	});

	it("shows the invalidation glyph+count in the full and counts tiers when present", () => {
		const state = new CacheMeterState();
		state.recordUsage(usageSample("anthropic", "claude", { cacheRead: 6_000 }));
		state.recordUsage(usageSample("anthropic", "claude", { input: 6_000, cacheWrite: 6_000 }));
		const snapshot = state.snapshot();
		expect(snapshot.invalidationCount).toBe(1);

		expect(renderCacheMeterRow(snapshot, WIDE, 0, idTheme, "subtle")).toContain(`${INVALIDATION_GLYPH}1`);
	});

	it("colors the badge with the primary accent by default, and each bucket with its own token", () => {
		const row = renderCacheMeterRow(fixtureSnapshot(), WIDE, 0, taggedTheme, "subtle");
		expect(row).toContain(`${CACHE_METER_COLORS.badge}:${BADGE_GLYPH}`);
		expect(row).toContain(`${CACHE_METER_COLORS.hit}:`);
		expect(row).toContain(`${CACHE_METER_COLORS.read}:READ 600`);
		expect(row).toContain(`${CACHE_METER_COLORS.write}:WRITE 200`);
		expect(row).toContain(`${CACHE_METER_COLORS.miss}:MISS 400`);
	});

	it("honors an accent override on the badge without recoloring the fixed buckets", () => {
		const colors = { ...CACHE_METER_COLORS, badge: "syntaxString" as const };
		const row = renderCacheMeterRow(fixtureSnapshot(), WIDE, 0, taggedTheme, "subtle", undefined, false, colors);
		expect(row).toContain(`syntaxString:${BADGE_GLYPH}`);
		expect(row).toContain(`${CACHE_METER_COLORS.hit}:`);
	});

	it("fits the wide tier at 69 columns with savings, a full sparkline, and an invalidation badge all present at once — the combination that used to overflow into counts", () => {
		const state = new CacheMeterState();
		state.recordUsage(
			usageSample("anthropic", "claude", {
				input: 50_000,
				cost: { input: 0.75, output: 0.03, cacheRead: 0, cacheWrite: 0, total: 0.78 },
			}),
		);
		for (let i = 0; i < 4; i++) {
			state.recordUsage(
				usageSample("anthropic", "claude", {
					input: 3_000,
					cacheRead: 40_000,
					cost: { input: 0.045, output: 0.024, cacheRead: 0.012, cacheWrite: 0, total: 0.081 },
				}),
			);
		}
		// An explicit-cache cold turn: invalidates the lineage just warmed above.
		state.recordUsage(
			usageSample("anthropic", "claude", {
				input: 20_000,
				cacheWrite: 20_000,
				cost: { input: 0.3, output: 0.018, cacheRead: 0, cacheWrite: 0.1, total: 0.418 },
			}),
		);
		for (let i = 0; i < 3; i++) {
			state.recordUsage(
				usageSample("anthropic", "claude", {
					input: 2_000,
					cacheRead: 20_000,
					cost: { input: 0.03, output: 0.024, cacheRead: 0.006, cacheWrite: 0, total: 0.06 },
				}),
			);
		}

		const snapshot = state.snapshot();
		expect(snapshot).toMatchObject({ requestCount: 9, invalidationCount: 1 });
		expect(snapshot.savedCost).toBeCloseTo(3.234, 3);
		expect(snapshot.warmthWindow).toHaveLength(9);

		const row = renderCacheMeterRow(snapshot, 69, 0, idTheme, "subtle");
		expect(row).toBe(`${BADGE_GLYPH} SAVED $3.23 ▁████▁███ H 71.6% (7/9) R 220K W 20K M 88K ${INVALIDATION_GLYPH}1`);
		expect(row.length).toBeLessThanOrEqual(69);
	});
});

describe("cache meter row — the eased displayWarmth is what actually draws", () => {
	it("draws the passed displayWarmth, not the snapshot's true (unrelated) warmth", () => {
		const state = new CacheMeterState();
		state.recordUsage(usageSample("anthropic", "claude", { cacheRead: 1_000 })); // true warmth 100%
		const row = renderCacheMeterRow(state.snapshot(), WIDE, 0, idTheme, "subtle", 0.25);
		expect(row).toContain("HIT 25.0%");
	});

	it("defaults to the snapshot's warmth, not its cumulative hitRate, when no override is passed", () => {
		const state = new CacheMeterState();
		// Cumulative hitRate (token-weighted) and rolling warmth (mean of per-request ratios)
		// diverge once requests carry different sizes — a single huge cold request should barely
		// move a multi-request warmth average even though it dominates the token-weighted hitRate.
		for (let i = 0; i < 5; i++) state.recordUsage(usageSample("anthropic", "claude", { cacheRead: 100 }));
		state.recordUsage(usageSample("anthropic", "claude", { input: 100_000 }));
		const snapshot = state.snapshot();
		expect(snapshot.hitRate).toBeLessThan(0.01); // one huge miss swamps the token-weighted total
		expect(snapshot.warmth).toBeCloseTo(5 / 6, 10); // 5 of the last 6 requests were full hits

		const row = renderCacheMeterRow(snapshot, WIDE, 0, idTheme, "subtle");
		expect(row).toContain(`HIT ${(snapshot.warmth * 100).toFixed(1)}%`);
	});
});

describe("cache meter row — per-request warmth sparkline (full tier)", () => {
	it("draws one glyph per recorded request while the rolling window is still filling, never padded", () => {
		const state = new CacheMeterState();
		state.recordUsage(usageSample("anthropic", "claude", { cacheRead: 100 }));
		state.recordUsage(usageSample("anthropic", "claude", { input: 100 }));
		state.recordUsage(usageSample("anthropic", "claude", { cacheRead: 50, cacheWrite: 50 }));

		const snapshot = state.snapshot();
		expect(snapshot.warmthWindow).toHaveLength(3);
		const row = renderCacheMeterRow(snapshot, WIDE, 0, idTheme, "subtle");
		// Glyphs for: 100% cache read, 0% (a pure miss), 50% — coldest to warmest is not monotonic here,
		// so this just pins the exact three-glyph shape rather than asserting a single ramp step.
		expect(row).toContain("█▁▅");
	});

	it("caps at WARMTH_WINDOW glyphs once the rolling window is full, oldest evicted first", () => {
		const state = new CacheMeterState();
		for (let i = 0; i < WARMTH_WINDOW; i++) state.recordUsage(usageSample("anthropic", "claude", { input: 100 })); // all misses
		state.recordUsage(usageSample("anthropic", "claude", { cacheRead: 100 })); // evicts the oldest miss, adds one hit

		const snapshot = state.snapshot();
		expect(snapshot.warmthWindow).toHaveLength(WARMTH_WINDOW);
		const row = renderCacheMeterRow(snapshot, WIDE, 0, idTheme, "subtle");
		expect(row).toContain(`${"▁".repeat(WARMTH_WINDOW - 1)}█`);
	});
});

describe("cache meter row — invalidation alert phase (pure)", () => {
	function invalidatedSnapshot() {
		const state = new CacheMeterState();
		state.recordUsage(usageSample("anthropic", "claude", { cacheRead: 6_000 }));
		state.recordUsage(usageSample("anthropic", "claude", { input: 6_000, cacheWrite: 6_000 }));
		return state.snapshot();
	}

	it("blinks the badge glyph in the full tier only, while a clean ledger never blinks", () => {
		const snapshot = invalidatedSnapshot();
		const bright = renderCacheMeterRow(snapshot, WIDE, 0, idTheme, "full", snapshot.hitRate, true);
		const dark = renderCacheMeterRow(
			snapshot,
			WIDE,
			INVALIDATION_BLINK_PERIOD_MS / 2,
			idTheme,
			"full",
			snapshot.hitRate,
			true,
		);
		expect(bright.startsWith(BADGE_GLYPH)).toBe(true);
		expect(dark.startsWith(BADGE_PULSE_GLYPH)).toBe(true);

		const subtleDark = renderCacheMeterRow(
			snapshot,
			WIDE,
			INVALIDATION_BLINK_PERIOD_MS / 2,
			idTheme,
			"subtle",
			snapshot.hitRate,
			true,
		);
		expect(subtleDark.startsWith(BADGE_GLYPH)).toBe(true);

		const notAlerted = renderCacheMeterRow(
			snapshot,
			WIDE,
			INVALIDATION_BLINK_PERIOD_MS / 2,
			idTheme,
			"full",
			snapshot.hitRate,
			false,
		);
		expect(notAlerted.startsWith(BADGE_GLYPH)).toBe(true);
	});

	it("colors the badge with the invalidation token whenever alerted, in either tier", () => {
		const snapshot = invalidatedSnapshot();
		expect(renderCacheMeterRow(snapshot, WIDE, 0, taggedTheme, "subtle", snapshot.hitRate, true)).toContain(
			`${CACHE_METER_COLORS.invalidation}:`,
		);
		expect(renderCacheMeterRow(snapshot, WIDE, 0, taggedTheme, "subtle", snapshot.hitRate, false)).toContain(
			`${CACHE_METER_COLORS.badge}:${BADGE_GLYPH}`,
		);
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// Off-tier static text
// ═══════════════════════════════════════════════════════════════════════════

describe("cache meter off-tier text (static surface)", () => {
	it("reports the idle state before anything is tracked", () => {
		expect(renderCacheMeterOffText(new CacheMeterState().snapshot())).toBe(
			`${BADGE_GLYPH} no prompt-cache telemetry yet`,
		);
	});

	it("summarizes hit rate, counts, and invalidations as plain text with no color or motion", () => {
		const state = new CacheMeterState();
		state.recordUsage(usageSample("anthropic", "claude", { input: 400, cacheRead: 600, cacheWrite: 200 }));
		const text = renderCacheMeterOffText(state.snapshot());
		expect(text).toBe(`${BADGE_GLYPH} HIT 50.0% (1/1) R 600 W 200 M 400`);
		expect(text).not.toContain("[");
		expect(text).not.toContain(BADGE_PULSE_GLYPH);
	});

	it("appends the invalidation glyph+count only once one is recorded", () => {
		const state = new CacheMeterState();
		state.recordUsage(usageSample("anthropic", "claude", { cacheRead: 6_000 }));
		expect(renderCacheMeterOffText(state.snapshot())).not.toContain(INVALIDATION_GLYPH);

		state.recordUsage(usageSample("anthropic", "claude", { input: 6_000, cacheWrite: 6_000 }));
		expect(renderCacheMeterOffText(state.snapshot())).toContain(`${INVALIDATION_GLYPH}1`);
	});

	it("omits cost and saved entirely when no request has ever carried Usage.cost", () => {
		const state = new CacheMeterState();
		state.recordUsage(usageSample("anthropic", "claude", { input: 400, cacheRead: 600, cacheWrite: 200 }));
		const text = renderCacheMeterOffText(state.snapshot());
		expect(text).not.toContain("$");
		expect(text).not.toContain("saved");
	});

	it("shows the total cost once it's nonzero, and a defined $0.00 saved once a rate is known but nothing was cached yet", () => {
		const state = new CacheMeterState();
		state.recordUsage(
			usageSample("anthropic", "claude", {
				input: 1_000,
				cost: { input: 1.5, output: 0, cacheRead: 0, cacheWrite: 0, total: 1.5 },
			}),
		);
		const text = renderCacheMeterOffText(state.snapshot());
		expect(text).toContain("$1.50");
		expect(text).toContain("saved $0.00");
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// /cache panel
// ═══════════════════════════════════════════════════════════════════════════

describe("cache meter panel (slash-command surface)", () => {
	it("heads with the request count and says so when empty", () => {
		const lines = renderCacheMeterPanel(new CacheMeterState().snapshot(), idTheme);
		expect(lines[0]).toContain("cache meter");
		expect(lines[0]).toContain("0 requests");
		expect(lines[1]).toContain("no prompt-cache telemetry yet");
	});

	it("singularizes the heading for exactly one request", () => {
		const state = new CacheMeterState();
		state.recordUsage(usageSample("anthropic", "claude", { cacheRead: 100 }));
		expect(renderCacheMeterPanel(state.snapshot(), idTheme)[0]).toContain("1 request");
	});

	it("prints one row per provider+model with its own hit rate and totals, then the session totals line", () => {
		const state = new CacheMeterState();
		state.recordUsage(usageSample("anthropic", "claude-opus", { input: 400, cacheRead: 600, cacheWrite: 200 }));
		state.recordUsage(usageSample("google", "gemini-3", { input: 1_000, cacheRead: 0, cacheWrite: 0 }));

		const lines = renderCacheMeterPanel(state.snapshot(), idTheme);
		const claudeRow = lines.find(line => line.includes("anthropic/claude-opus"));
		const geminiRow = lines.find(line => line.includes("google/gemini-3"));
		expect(claudeRow).toContain("HIT 50.0% (1/1)");
		expect(claudeRow).toContain("READ 600");
		expect(geminiRow).toContain("HIT 0.0% (0/1)");

		const total = lines.at(-1) ?? "";
		expect(total).toContain("total HIT");
		expect(total).toContain("READ 600");
		expect(total).toContain("MISS 1.4K");
		expect(total).toContain("invalidations 0");
	});

	it("shows each row's own invalidation count without inflating a clean lineage's row", () => {
		const state = new CacheMeterState();
		state.recordUsage(usageSample("anthropic", "claude", { cacheRead: 6_000 }));
		state.recordUsage(usageSample("anthropic", "claude", { input: 6_000, cacheWrite: 6_000 }));
		state.recordUsage(usageSample("google", "gemini-3", { cacheRead: 6_000 }));

		const lines = renderCacheMeterPanel(state.snapshot(), idTheme);
		const claudeRow = lines.find(line => line.includes("anthropic/claude")) ?? "";
		const geminiRow = lines.find(line => line.includes("google/gemini-3")) ?? "";
		expect(claudeRow).toContain(`${INVALIDATION_GLYPH}1`);
		expect(geminiRow).not.toContain(INVALIDATION_GLYPH);
		expect(lines.at(-1)).toContain("invalidations 1");
	});

	it("omits SPENT and SAVED from the totals line when no request ever carried Usage.cost", () => {
		const state = new CacheMeterState();
		state.recordUsage(usageSample("anthropic", "claude", { input: 400, cacheRead: 600, cacheWrite: 200 }));
		const total = renderCacheMeterPanel(state.snapshot(), idTheme).at(-1) ?? "";
		expect(total).not.toContain("SPENT");
		expect(total).not.toContain("SAVED");
	});

	it("omits the CTTL breakdown from the totals line when neither ephemeral bucket is nonzero", () => {
		const state = new CacheMeterState();
		state.recordUsage(usageSample("anthropic", "claude", { cacheWrite: 500 })); // no cttl override -> both zero
		const total = renderCacheMeterPanel(state.snapshot(), idTheme).at(-1) ?? "";
		expect(total).not.toContain("CTTL");
	});

	it("shows the CTTL 5m/1h split on the totals line once either half is nonzero", () => {
		const state = new CacheMeterState();
		state.recordUsage(
			usageSample("anthropic", "claude", { cacheWrite: 500, cttl: { ephemeral5m: 300, ephemeral1h: 0 } }),
		);
		const total = renderCacheMeterPanel(state.snapshot(), idTheme).at(-1) ?? "";
		expect(total).toContain("CTTL 5m 300 / 1h 0");
	});

	it("adds one aggregate SAVED figure, a SPENT figure, and a per-cause breakdown to the totals line, without disturbing the invalidations count", () => {
		const state = new CacheMeterState();
		state.recordEvent("compact", 0);
		// anthropic/claude: warm, then cold — one invalidation, attributed to the compact recorded above.
		state.recordUsage(usageSample("anthropic", "claude", { cacheRead: 6_000 }), 0);
		state.recordUsage(usageSample("anthropic", "claude", { input: 6_000, cacheWrite: 6_000 }), 10);
		// google/gemini-3: unrelated request that derives a rate and banks a saving.
		state.recordUsage(
			usageSample("google", "gemini-3", {
				input: 1_000,
				cacheRead: 500,
				cost: { input: 1, output: 0, cacheRead: 0.05, cacheWrite: 0, total: 1.05 },
			}),
			20,
		);

		const total = renderCacheMeterPanel(state.snapshot(), idTheme).at(-1) ?? "";
		expect(total).toContain("invalidations 1");
		expect(total).toContain("compact ×1");
		expect(total).toContain("SPENT $1.05");
		expect(total).toContain("SAVED $0.45");
	});

	it("lists recorded invalidations chronologically under the per-model rows, oldest first, with a relative age", () => {
		const state = new CacheMeterState();
		state.recordEvent("compact", 0);
		state.recordUsage(usageSample("anthropic", "claude", { cacheRead: 6_000 }), 0);
		state.recordUsage(usageSample("anthropic", "claude", { input: 6_000, cacheWrite: 6_000 }), 10);

		const now = 10 + 65_000; // just over a minute after the invalidation
		const lines = renderCacheMeterPanel(state.snapshot(), idTheme, { now });
		const timelineLine = lines.find(line => line.includes(INVALIDATION_GLYPH) && line.includes("compact"));
		expect(timelineLine).toContain(`${INVALIDATION_GLYPH} compact · 1m ago`);
	});

	it("caps the timeline at the last 10 invalidations and notes how many earlier ones were dropped", () => {
		const state = new CacheMeterState();
		for (let i = 0; i < 13; i++) {
			state.recordUsage(usageSample("p", "m", { cacheRead: 6_000 }), i * 1_000);
			state.recordUsage(usageSample("p", "m", { input: 6_000, cacheWrite: 6_000 }), i * 1_000 + 500);
		}
		const lines = renderCacheMeterPanel(state.snapshot(), idTheme, { now: 13_000 });
		// Timeline lines lead with the glyph; the per-model row's own `⊘13` trails at the end instead.
		const timelineLines = lines.filter(line => line.trimStart().startsWith(INVALIDATION_GLYPH));
		expect(timelineLines).toHaveLength(10);
		expect(lines.some(line => line.includes("3 earlier invalidations not shown"))).toBe(true);
	});

	it("notes the true omitted count (against invalidationCount), not just the retained array's own overflow", () => {
		const state = new CacheMeterState();
		// 25 invalidations: the ledger retains only the last 20 (state.ts's own cap), and the
		// panel shows only the last 10 of those — the "not shown" note must reflect all 15
		// missing from view (25 - 10), not just the 10 that spilled out of the 20-entry retention.
		for (let i = 0; i < 25; i++) {
			state.recordUsage(usageSample("p", "m", { cacheRead: 6_000 }), i * 1_000);
			state.recordUsage(usageSample("p", "m", { input: 6_000, cacheWrite: 6_000 }), i * 1_000 + 500);
		}
		const snapshot = state.snapshot();
		expect(snapshot.invalidationCount).toBe(25);
		expect(snapshot.invalidations).toHaveLength(20);

		const lines = renderCacheMeterPanel(snapshot, idTheme, { now: 25_000 });
		expect(lines.some(line => line.includes("15 earlier invalidations not shown"))).toBe(true);
	});

	it("omits the timeline section entirely when there are no invalidations", () => {
		const state = new CacheMeterState();
		state.recordUsage(usageSample("anthropic", "claude", { cacheRead: 100 }));
		const lines = renderCacheMeterPanel(state.snapshot(), idTheme);
		expect(lines.some(line => line.includes(INVALIDATION_GLYPH))).toBe(false);
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// easedHitRate (pure)
// ═══════════════════════════════════════════════════════════════════════════

describe("easedHitRate (pure)", () => {
	it("starts at `from` and lands on `to` once the duration elapses", () => {
		expect(easedHitRate(1, 0.1, 0)).toBe(1);
		expect(easedHitRate(1, 0.1, HIT_RATE_EASE_DURATION_MS)).toBeCloseTo(0.1, 10);
		expect(easedHitRate(1, 0.1, HIT_RATE_EASE_DURATION_MS * 10)).toBeCloseTo(0.1, 10);
	});

	it("is monotonic between `from` and `to` on the way there", () => {
		const early = easedHitRate(1, 0.1, HIT_RATE_EASE_DURATION_MS * 0.25);
		const mid = easedHitRate(1, 0.1, HIT_RATE_EASE_DURATION_MS * 0.5);
		const late = easedHitRate(1, 0.1, HIT_RATE_EASE_DURATION_MS * 0.75);
		expect(early).toBeGreaterThan(mid);
		expect(mid).toBeGreaterThan(late);
		expect(early).toBeLessThan(1);
		expect(late).toBeGreaterThan(0.1);
	});

	it("clamps negative elapsed time to the start value", () => {
		expect(easedHitRate(1, 0.1, -50)).toBe(1);
	});

	it("jumps straight to the target when the duration is non-positive", () => {
		expect(easedHitRate(1, 0.1, 100, 0)).toBe(0.1);
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// Widget lifecycle
// ═══════════════════════════════════════════════════════════════════════════

describe("cache meter widget lifecycle", () => {
	it("subscribes to the host on mount and leaves zero subscriptions after dispose", () => {
		const scheduler = manualScheduler();
		const policy = new MotionPolicy(fullEnv, "full");
		const host = new AnimationHost({ policy, scheduler });
		const state = new CacheMeterState();
		state.recordUsage(usageSample("anthropic", "claude", { cacheRead: 100 }));
		const widget = new CacheMeterWidget({ tui: noopTui, host, policy, state, theme: idTheme, clock: scheduler });

		widget.render(WIDE);
		expect(widget.animating).toBe(true);
		expect(host.subscriberCount).toBe(1);

		widget.dispose();
		expect(host.subscriberCount).toBe(0);
		expect(host.running).toBe(false);
	});

	it("does not ease in from zero on mount — the initial frame equals the true snapshot's static render", () => {
		const scheduler = manualScheduler();
		const policy = new MotionPolicy(fullEnv, "full");
		const host = new AnimationHost({ policy, scheduler });
		const state = new CacheMeterState();
		state.recordUsage(usageSample("anthropic", "claude", { cacheRead: 100 }));
		const snapshotAtMount = state.snapshot();
		const widget = new CacheMeterWidget({ tui: noopTui, host, policy, state, theme: idTheme, clock: scheduler });

		expect(widget.render(WIDE)).toEqual([renderCacheMeterRow(snapshotAtMount, WIDE, 0, idTheme, "full")]);
		widget.dispose();
	});

	it("eases the displayed hit rate across frames after a new request lands, then settles on the true value", () => {
		const scheduler = manualScheduler();
		const policy = new MotionPolicy(fullEnv, "full");
		const host = new AnimationHost({ policy, scheduler });
		const state = new CacheMeterState();
		state.recordUsage(usageSample("anthropic", "claude", { cacheRead: 1_000 })); // hit rate 1.0
		const widget = new CacheMeterWidget({ tui: noopTui, host, policy, state, theme: idTheme, clock: scheduler });
		widget.render(WIDE);

		state.recordUsage(usageSample("anthropic", "claude", { input: 9_000 })); // drags hit rate down to 0.1
		scheduler.advance(1); // registers the new target this tick
		const justRetargeted = widget.render(WIDE);

		scheduler.advance(HIT_RATE_EASE_DURATION_MS / 2);
		const midway = widget.render(WIDE);

		scheduler.advance(HIT_RATE_EASE_DURATION_MS * 2);
		const settled = widget.render(WIDE);

		expect(midway).not.toEqual(justRetargeted);
		expect(midway).not.toEqual(settled);
		expect(settled).toEqual([renderCacheMeterRow(state.snapshot(), WIDE, scheduler.now(), idTheme, "full")]);
		widget.dispose();
	});

	it("flashes the badge for INVALIDATION_ALERT_DURATION_MS after a detected invalidation, then reverts", () => {
		const scheduler = manualScheduler();
		const policy = new MotionPolicy(fullEnv, "full");
		const host = new AnimationHost({ policy, scheduler });
		const state = new CacheMeterState();
		state.recordUsage(usageSample("anthropic", "claude", { cacheRead: 6_000 }));
		const widget = new CacheMeterWidget({ tui: noopTui, host, policy, state, theme: taggedTheme, clock: scheduler });
		expect(widget.render(WIDE)[0]).toContain(`${CACHE_METER_COLORS.badge}:${BADGE_GLYPH}`);

		const { invalidated } = state.recordUsage(
			usageSample("anthropic", "claude", { input: 6_000, cacheWrite: 6_000 }),
		);
		expect(invalidated).toBe(true);

		scheduler.advance(1);
		expect(widget.render(WIDE)[0]).toContain(`${CACHE_METER_COLORS.invalidation}:`);

		scheduler.advance(INVALIDATION_ALERT_DURATION_MS + 1);
		expect(widget.render(WIDE)[0]).toContain(`${CACHE_METER_COLORS.badge}:${BADGE_GLYPH}`);
		widget.dispose();
	});

	it("degrades to the static off line if the live policy flips to off after mount", () => {
		const scheduler = manualScheduler();
		const policy = new MotionPolicy(fullEnv, "full");
		const host = new AnimationHost({ policy, scheduler });
		const state = new CacheMeterState();
		state.recordUsage(usageSample("anthropic", "claude", { cacheRead: 100 }));
		const widget = new CacheMeterWidget({ tui: noopTui, host, policy, state, theme: idTheme, clock: scheduler });
		widget.render(WIDE);
		expect(widget.animating).toBe(true);

		policy.setSetting("off");
		expect(widget.animating).toBe(false);
		expect(widget.render(WIDE)).toEqual([renderCacheMeterOffText(state.snapshot())]);
		widget.dispose();
	});

	it("applies the accent override to the badge slot", () => {
		const scheduler = manualScheduler();
		const policy = new MotionPolicy(fullEnv, "subtle");
		const host = new AnimationHost({ policy, scheduler });
		const state = new CacheMeterState();
		state.recordUsage(usageSample("anthropic", "claude", { cacheRead: 100 }));
		const widget = new CacheMeterWidget({
			tui: noopTui,
			host,
			policy,
			state,
			theme: taggedTheme,
			clock: scheduler,
			accentColor: "syntaxNumber",
		});
		expect(widget.render(WIDE)[0]).toContain(`syntaxNumber:${BADGE_GLYPH}`);
		widget.dispose();
	});

	it("reads the injected clock, not the host's mount-relative elapsed time", () => {
		const scheduler = manualScheduler();
		scheduler.advance(10);
		const policy = new MotionPolicy(fullEnv, "full");
		const host = new AnimationHost({ policy, scheduler });
		const state = new CacheMeterState();
		state.recordUsage(usageSample("anthropic", "claude", { cacheRead: 100 }));
		const widget = new CacheMeterWidget({ tui: noopTui, host, policy, state, theme: idTheme, clock: scheduler });

		// elapsedMs is still 0 (nothing has ticked since mount); the clock says otherwise.
		expect(widget.elapsedMs).toBe(0);
		expect(widget.render(WIDE)).toEqual([renderCacheMeterRow(state.snapshot(), WIDE, 10, idTheme, "full")]);
		widget.dispose();
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// Controller
// ═══════════════════════════════════════════════════════════════════════════

function controllerContext(overrides: Partial<CacheMeterContext> = {}): {
	ctx: CacheMeterContext;
	calls: Array<{ key: string; content: unknown }>;
} {
	const calls: Array<{ key: string; content: unknown }> = [];
	const ctx: CacheMeterContext = {
		hasUI: true,
		isTTY: true,
		env: {},
		motionSetting: "full",
		theme: idTheme,
		glyphPreset: "unicode",
		setWidget: (key, content) => calls.push({ key, content }),
		...overrides,
	};
	return { ctx, calls };
}

function assistantMessageEnd(provider: string, model: string, usage: Partial<CacheUsageSample> = {}): MessageEndEvent {
	return {
		type: "message_end",
		message: {
			role: "assistant",
			content: [],
			api: "anthropic-messages",
			provider,
			model,
			usage: { input: 0, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 10, ...usage },
			stopReason: "stop",
			timestamp: 0,
		},
	} as unknown as MessageEndEvent;
}

function nonAssistantMessageEnd(): MessageEndEvent {
	return { type: "message_end", message: { role: "toolResult" } } as unknown as MessageEndEvent;
}

describe("cache meter controller", () => {
	it("mounts lazily on the first request with usable telemetry, not before, and stays idempotent for animated mode", () => {
		const controller = new CacheMeterController({ scheduler: manualScheduler() });
		const { ctx, calls } = controllerContext();

		controller.onMessageEnd(assistantMessageEnd("a", "m", { input: 0, cacheRead: 0, cacheWrite: 0 }), ctx);
		expect(calls).toEqual([]);

		controller.onMessageEnd(assistantMessageEnd("anthropic", "claude", { cacheRead: 100 }), ctx);
		expect(calls).toHaveLength(1);
		expect(calls[0]).toMatchObject({ key: WIDGET_KEY });

		controller.onMessageEnd(assistantMessageEnd("anthropic", "claude", { cacheRead: 50 }), ctx);
		// Animated mode: the widget's own frame subscription repaints; no extra setWidget call.
		expect(calls).toHaveLength(1);
	});

	it("ignores non-assistant message_end events", () => {
		const controller = new CacheMeterController({ scheduler: manualScheduler() });
		const { ctx, calls } = controllerContext();
		expect(() => controller.onMessageEnd(nonAssistantMessageEnd(), ctx)).not.toThrow();
		expect(calls).toEqual([]);
		expect(controller.state.snapshot().requestCount).toBe(0);
	});

	it("stays completely dormant with no UI surface: no widget calls, nothing recorded", () => {
		const controller = new CacheMeterController({ scheduler: manualScheduler() });
		const { ctx, calls } = controllerContext({ hasUI: false });
		controller.onMessageEnd(assistantMessageEnd("anthropic", "claude", { cacheRead: 100 }), ctx);
		expect(calls).toEqual([]);
		expect(controller.state.snapshot().requestCount).toBe(0);
	});

	it("off tier renders the static summary line and repaints it on every recorded request", () => {
		const controller = new CacheMeterController({ scheduler: manualScheduler() });
		const { ctx, calls } = controllerContext({ motionSetting: "off" });

		controller.onMessageEnd(assistantMessageEnd("anthropic", "claude", { cacheRead: 100 }), ctx);
		expect(calls.at(-1)?.content).toEqual([renderCacheMeterOffText(controller.state.snapshot())]);

		controller.onMessageEnd(assistantMessageEnd("anthropic", "claude", { input: 50 }), ctx);
		expect(calls.at(-1)?.content).toEqual([renderCacheMeterOffText(controller.state.snapshot())]);
	});

	it("subtle/full tier mounts the animated widget; dispose tears down the host with zero leaked subscriptions", () => {
		const scheduler = manualScheduler();
		const controller = new CacheMeterController({ scheduler });
		const { ctx, calls } = controllerContext();

		controller.onMessageEnd(assistantMessageEnd("anthropic", "claude", { cacheRead: 100 }), ctx);
		const factory = calls[0]?.content as (tui: typeof noopTui, theme: typeof idTheme) => CacheMeterWidget;
		const widget = factory(noopTui, idTheme);
		expect(scheduler.running).toBe(true);
		expect(widget.animating).toBe(true);

		controller.dispose(ctx);
		expect(calls.at(-1)?.content).toBeUndefined();
		expect(scheduler.running).toBe(false);
		expect(() => controller.dispose(ctx)).not.toThrow();
	});

	it("dispose resets the ledger — session reset on both session_switch and session_shutdown wiring", () => {
		const controller = new CacheMeterController({ scheduler: manualScheduler() });
		const { ctx } = controllerContext();
		controller.onMessageEnd(assistantMessageEnd("anthropic", "claude", { cacheRead: 100 }), ctx);
		expect(controller.state.snapshot().requestCount).toBe(1);

		controller.dispose(ctx);
		expect(controller.state.snapshot()).toMatchObject({ requestCount: 0, groups: [] });
	});

	it("dispose before any mount is a safe no-op that still clears the widget key", () => {
		const controller = new CacheMeterController({ scheduler: manualScheduler() });
		const { ctx, calls } = controllerContext();
		expect(() => controller.dispose(ctx)).not.toThrow();
		expect(calls.at(-1)).toEqual({ key: WIDGET_KEY, content: undefined });
	});

	it("panel() renders the full session breakdown through the shared renderer", () => {
		const controller = new CacheMeterController({ scheduler: manualScheduler() });
		const { ctx } = controllerContext();
		controller.onMessageEnd(
			assistantMessageEnd("anthropic", "claude", { input: 400, cacheRead: 600, cacheWrite: 200 }),
			ctx,
		);

		const lines = controller.panel(ctx);
		expect(lines[0]).toContain("cache meter");
		expect(lines.some(line => line.includes("anthropic/claude"))).toBe(true);
		expect(lines.at(-1)).toContain("invalidations 0");
	});
});

describe("cache meter controller — event attribution handlers", () => {
	/** Same warm-then-cold shape as the state-level attribution tests, driven through the controller's own state. */
	function warmThenCold(controller: CacheMeterController, atMsWarm: number, atMsCold: number) {
		controller.state.recordUsage(usageSample("anthropic", "claude", { cacheRead: 6_000 }), atMsWarm);
		return controller.state.recordUsage(
			usageSample("anthropic", "claude", { input: 6_000, cacheWrite: 6_000 }),
			atMsCold,
		);
	}

	it("onSessionCompact records a compact event at the scheduler's current time", () => {
		const scheduler = manualScheduler();
		const controller = new CacheMeterController({ scheduler });
		const { ctx } = controllerContext();
		scheduler.advance(1_000);

		controller.onSessionCompact(ctx);
		warmThenCold(controller, 500, 1_050);
		expect(controller.state.snapshot().invalidations[0]?.cause).toBe("compact");
	});

	it("onAutoCompactionStart records auto-compact, distinct from a manual compact", () => {
		const scheduler = manualScheduler();
		const controller = new CacheMeterController({ scheduler });
		const { ctx } = controllerContext();
		scheduler.advance(2_000);

		controller.onAutoCompactionStart(
			{ type: "auto_compaction_start", reason: "threshold", action: "context-full" },
			ctx,
		);
		warmThenCold(controller, 1_500, 2_050);
		expect(controller.state.snapshot().invalidations[0]?.cause).toBe("auto-compact");
	});

	it("onSessionSwitch records session-switch when called directly, but is not wired to the session_switch event — dispose() owns that (see its doc comment)", () => {
		const scheduler = manualScheduler();
		const controller = new CacheMeterController({ scheduler });
		const { ctx } = controllerContext();
		scheduler.advance(3_000);

		controller.onSessionSwitch({ type: "session_switch", reason: "resume", previousSessionFile: undefined }, ctx);
		warmThenCold(controller, 2_950, 3_050);
		expect(controller.state.snapshot().invalidations[0]?.cause).toBe("session-switch");
	});

	it("stays dormant with no UI surface: none of the three handlers record an event", () => {
		const scheduler = manualScheduler();
		const controller = new CacheMeterController({ scheduler });
		const { ctx } = controllerContext({ hasUI: false });

		controller.onSessionCompact(ctx);
		controller.onAutoCompactionStart(
			{ type: "auto_compaction_start", reason: "threshold", action: "context-full" },
			ctx,
		);
		controller.onSessionSwitch({ type: "session_switch", reason: "resume", previousSessionFile: undefined }, ctx);
		warmThenCold(controller, 0, 10);
		expect(controller.state.snapshot().invalidations[0]?.cause).toBe("unattributed");
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// Extension wiring (message_end / session_compact / auto_compaction_start / session_switch / session_shutdown / /cache)
// ═══════════════════════════════════════════════════════════════════════════

type Handler = (event: unknown, ctx: unknown) => unknown;
type CommandOptions = {
	description?: string;
	handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
};

function mountExtension(options: CacheMeterExtensionOptions = {}) {
	const handlers = new Map<string, Handler[]>();
	const commands = new Map<string, CommandOptions>();
	const api = {
		on: (event: string, handler: Handler) => {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		},
		registerCommand: (name: string, commandOptions: CommandOptions) => {
			commands.set(name, commandOptions);
		},
		logger: { error() {}, warn() {}, debug() {}, info() {} },
	} as unknown as ExtensionAPI;

	createCacheMeterExtension(options)(api);

	const command = commands.get(CACHE_METER_COMMAND);
	if (command === undefined) throw new Error(`/${CACHE_METER_COMMAND} was never registered`);

	return {
		events: [...handlers.keys()],
		commands: [...commands.keys()],
		command,
		emit(event: string, payload: unknown, ctx: ExtensionContext): void {
			for (const handler of handlers.get(event) ?? []) handler(payload, ctx);
		},
	};
}

function extensionRecordingContext(overrides: Partial<ExtensionContext> = {}) {
	const widgets: Array<{ key: string; content: unknown }> = [];
	const notes: Array<{ message: string; type: string | undefined }> = [];
	const ctx = {
		hasUI: true,
		ui: {
			theme: { ...idTheme, getSymbolPreset: () => "unicode" as const },
			setWidget: (key: string, content: unknown) => widgets.push({ key, content }),
			notify: (message: string, type?: string) => notes.push({ message, type }),
		},
		...overrides,
	} as unknown as ExtensionContext;
	return { ctx, widgets, notes };
}

function lastNote(notes: Array<{ message: string; type: string | undefined }>) {
	const note = notes.at(-1);
	if (note === undefined) throw new Error("nothing was notified");
	return note;
}

describe("cache meter extension — wiring", () => {
	it("subscribes to message_end/session_compact/auto_compaction_start/session_switch/session_shutdown and registers /cache", () => {
		const mounted = mountExtension();
		expect(mounted.events.sort()).toEqual([
			"auto_compaction_start",
			"message_end",
			"session_compact",
			"session_shutdown",
			"session_switch",
		]);
		expect(mounted.commands).toEqual([CACHE_METER_COMMAND]);
	});

	it("feeds message_end into the ledger and /cache reports it", async () => {
		const mounted = mountExtension();
		const { ctx, notes } = extensionRecordingContext();

		mounted.emit(
			"message_end",
			assistantMessageEnd("anthropic", "claude", { input: 400, cacheRead: 600, cacheWrite: 200 }),
			ctx,
		);
		await mounted.command.handler("", ctx as ExtensionCommandContext);

		const note = lastNote(notes);
		expect(note.type).toBe("info");
		expect(note.message).toContain("anthropic/claude");
		expect(note.message).toContain("READ 600");
	});

	it("stays completely dormant without a UI surface", async () => {
		const mounted = mountExtension();
		const headless = extensionRecordingContext({ hasUI: false });

		mounted.emit("message_end", assistantMessageEnd("anthropic", "claude", { cacheRead: 100 }), headless.ctx);
		await mounted.command.handler("", headless.ctx as ExtensionCommandContext);

		expect(headless.widgets).toEqual([]);
		expect(headless.notes).toEqual([]);

		// Nothing was recorded behind the scenes either.
		const visible = extensionRecordingContext();
		await mounted.command.handler("", visible.ctx as ExtensionCommandContext);
		expect(lastNote(visible.notes).message).toContain("0 requests");
	});

	it("clears the widget and resets the ledger on session shutdown", () => {
		const mounted = mountExtension();
		const { ctx, widgets } = extensionRecordingContext();

		mounted.emit("message_end", assistantMessageEnd("anthropic", "claude", { cacheRead: 100 }), ctx);
		expect(widgets.some(entry => entry.key === WIDGET_KEY)).toBe(true);

		mounted.emit("session_shutdown", {}, ctx);
		expect(widgets.at(-1)).toEqual({ key: WIDGET_KEY, content: undefined });
	});

	it("also resets the ledger on session_switch", () => {
		const mounted = mountExtension();
		const { ctx, widgets } = extensionRecordingContext();

		mounted.emit("message_end", assistantMessageEnd("anthropic", "claude", { cacheRead: 100 }), ctx);
		mounted.emit("session_switch", {}, ctx);
		expect(widgets.at(-1)).toEqual({ key: WIDGET_KEY, content: undefined });
	});

	it("feeds session_compact into event attribution, surfaced as a cause on /cache's totals line", async () => {
		const mounted = mountExtension();
		const { ctx, notes } = extensionRecordingContext();

		mounted.emit("session_compact", { type: "session_compact", compactionEntry: {}, fromExtension: false }, ctx);
		mounted.emit("message_end", assistantMessageEnd("anthropic", "claude", { cacheRead: 6_000 }), ctx);
		mounted.emit("message_end", assistantMessageEnd("anthropic", "claude", { input: 6_000, cacheWrite: 6_000 }), ctx);
		await mounted.command.handler("", ctx as ExtensionCommandContext);

		expect(lastNote(notes).message).toContain("compact ×1");
	});

	it("session_compact/auto_compaction_start stay dormant without a UI surface", () => {
		const mounted = mountExtension();
		const headless = extensionRecordingContext({ hasUI: false });

		expect(() =>
			mounted.emit(
				"session_compact",
				{ type: "session_compact", compactionEntry: {}, fromExtension: false },
				headless.ctx,
			),
		).not.toThrow();
		expect(() =>
			mounted.emit(
				"auto_compaction_start",
				{ type: "auto_compaction_start", reason: "threshold", action: "context-full" },
				headless.ctx,
			),
		).not.toThrow();
	});

	it("threads the host's live ctx.ui.theme.getSymbolPreset() into the mounted off-tier badge glyph — not just the config field", () => {
		// `motionSetting: "off"` makes the mounted content a deterministic static
		// line regardless of the test process's ambient TTY state.
		const mounted = mountExtension({ motionSetting: "off" });
		const widgets: Array<{ key: string; content: unknown }> = [];
		const ctx = {
			hasUI: true,
			ui: {
				theme: { ...idTheme, getSymbolPreset: () => "ascii" as const },
				setWidget: (key: string, content: unknown) => widgets.push({ key, content }),
				notify: () => {},
			},
		} as unknown as ExtensionContext;

		mounted.emit("message_end", assistantMessageEnd("anthropic", "claude", { cacheRead: 100 }), ctx);

		const content = widgets.at(-1)?.content as readonly string[] | undefined;
		const line = content?.[0];
		expect(line).toContain(badgeGlyph("ascii"));
		expect(line).not.toContain(badgeGlyph("unicode"));
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// Registrar / appearance wiring
// ═══════════════════════════════════════════════════════════════════════════

describe("cache meter — registrar/appearance wiring", () => {
	it("is a registered ANIMATIONS entry, titled and placed as documented", () => {
		const entry = ANIMATIONS.find(a => a.id === "cacheMeter");
		expect(entry).toBeDefined();
		expect(entry?.title).toBe("Cache Meter");
		expect(entry?.defaultPlacement).toBe("aboveEditor");
	});

	it("derives its manifest/env keys the same way every other animation does", () => {
		expect(animationsEnvKey("cacheMeter")).toBe("OMP_ANIMATIONS_CACHE_METER");
		expect(placementKey("cacheMeter")).toBe("cacheMeterPlacement");
		expect(accentColorKey("cacheMeter")).toBe("cacheMeterAccentColor");
	});

	it("ships matching package.json#omp.settings entries", async () => {
		const pkg = await Bun.file(path.join(import.meta.dir, "..", "package.json")).json();
		const settings = pkg.omp.settings as Record<
			string,
			{ type?: string; default?: unknown; values?: readonly string[]; env?: string }
		>;
		expect(settings.cacheMeter).toMatchObject({ type: "boolean", default: true, env: "OMP_ANIMATIONS_CACHE_METER" });
		expect(settings.cacheMeterPlacement).toMatchObject({
			type: "enum",
			default: "aboveEditor",
			env: "OMP_ANIMATIONS_CACHE_METER_PLACEMENT",
		});
		expect(settings.cacheMeterAccentColor).toMatchObject({
			type: "enum",
			default: "default",
			env: "OMP_ANIMATIONS_CACHE_METER_ACCENT_COLOR",
		});
	});

	it("mounts message_end/session_switch/session_shutdown and /cache when enabled alone through the registrar", () => {
		const events: string[] = [];
		const commands: string[] = [];
		const api = {
			on: (event: string) => {
				events.push(event);
			},
			setLabel: () => {},
			registerCommand: (name: string) => {
				commands.push(name);
			},
			logger: { error() {}, warn() {}, debug() {}, info() {} },
		} as unknown as ExtensionAPI;
		const only = Object.fromEntries(ANIMATIONS.map(a => [a.id, a.id === "cacheMeter"]));

		// `display: "rows"` — Cache Meter is a box-migrated animation (Plan 017), so the
		// default `display: "box"` would suppress its standalone mount entirely.
		createAnimationsPlugin({
			settings: { display: "rows", ...only },
			env: {},
			readPluginSettings: async () => ({}),
		})(api);

		expect(events.sort()).toEqual([
			"auto_compaction_start",
			"message_end",
			"session_compact",
			"session_shutdown",
			"session_switch",
		]);
		expect(commands).toEqual([CACHE_METER_COMMAND]);
	});
});
