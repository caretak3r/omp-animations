import { describe, expect, it } from "bun:test";
import {
	pebbleGlyph,
	renderTidepoolRow,
	SHIMMER_PERIOD_MS,
	sandGlyph,
	shimmerBeat,
	type TidepoolTheme,
	waterGlyph,
	waterShimmerGlyph,
} from "../src/rate-limit-tidepool/render";
import { RateLimitTidepoolState } from "../src/rate-limit-tidepool/state";
import {
	familyForProvider,
	POOL_CALM_THRESHOLD,
	POOL_SAND_THRESHOLD,
	parseGoDurationMs,
	poolFilledCells,
	poolTier,
	readRateLimitHeaders,
	refillLevel,
} from "../src/rate-limit-tidepool/tidepool";

// Identity theme so assertions see plain text instead of ANSI escapes.
const idTheme: TidepoolTheme = { fg: (_color, text) => text };
// Color-tagging theme for tests that need to assert which token the renderer chose.
const taggedTheme: TidepoolTheme = { fg: (color, text) => `${color}:${text}` };

const anthropicHeaders = {
	"anthropic-ratelimit-requests-limit": "50",
	"anthropic-ratelimit-requests-remaining": "45",
	"anthropic-ratelimit-requests-reset": "2026-08-03T18:31:00Z",
	"anthropic-ratelimit-tokens-limit": "40000",
	"anthropic-ratelimit-tokens-remaining": "12000",
	"anthropic-ratelimit-tokens-reset": "2026-08-03T18:30:30Z",
};

const openaiHeaders = {
	"x-ratelimit-limit-requests": "3000",
	"x-ratelimit-remaining-requests": "2999",
	"x-ratelimit-reset-requests": "6m0s",
	"x-ratelimit-limit-tokens": "60000",
	"x-ratelimit-remaining-tokens": "5000",
	"x-ratelimit-reset-tokens": "1s",
};

// ═══════════════════════════════════════════════════════════════════════════
// Glyph presets
// ═══════════════════════════════════════════════════════════════════════════

describe("rate-limit tidepool glyphs (preset-aware)", () => {
	it("waterGlyph/waterShimmerGlyph/pebbleGlyph/sandGlyph default to unicode, byte-identical to the original hardcoded values", () => {
		expect(waterGlyph()).toBe("≈");
		expect(waterShimmerGlyph()).toBe("~");
		expect(pebbleGlyph()).toBe("∘");
		expect(sandGlyph()).toBe("·");
	});

	it("ascii substitutes are exact one-column values, all four distinct from one another", () => {
		expect(waterGlyph("ascii")).toBe("~");
		expect(waterShimmerGlyph("ascii")).toBe("-");
		expect(pebbleGlyph("ascii")).toBe(".");
		expect(sandGlyph("ascii")).toBe(",");
		const glyphs = [waterGlyph("ascii"), waterShimmerGlyph("ascii"), pebbleGlyph("ascii"), sandGlyph("ascii")];
		expect(new Set(glyphs).size).toBe(glyphs.length);
		for (const glyph of glyphs) {
			expect(glyph).toHaveLength(1);
			expect(glyph.charCodeAt(0)).toBeLessThan(128);
		}
	});

	it("nerd aliases unicode exactly", () => {
		expect(waterGlyph("nerd")).toBe(waterGlyph("unicode"));
		expect(waterShimmerGlyph("nerd")).toBe(waterShimmerGlyph("unicode"));
		expect(pebbleGlyph("nerd")).toBe(pebbleGlyph("unicode"));
		expect(sandGlyph("nerd")).toBe(sandGlyph("unicode"));
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// Pure math (tidepool.ts) — header parsing and the family whitelist
// ═══════════════════════════════════════════════════════════════════════════

describe("familyForProvider — the whitelist", () => {
	it("recognizes exactly anthropic and openai", () => {
		expect(familyForProvider("anthropic")).toBe("anthropic");
		expect(familyForProvider("openai")).toBe("openai");
	});

	it("does not recognize openrouter or any other gateway — an OpenRouter call to an Anthropic model is not guessed at", () => {
		expect(familyForProvider("openrouter")).toBeUndefined();
		expect(familyForProvider("google")).toBeUndefined();
		expect(familyForProvider("bedrock")).toBeUndefined();
	});
});

describe("readRateLimitHeaders — anthropic family", () => {
	it("parses the anthropic-ratelimit-{resource}-{field} shape and takes the min across recognized buckets", () => {
		const reading = readRateLimitHeaders("anthropic", anthropicHeaders, 1_000);
		// tokens (12000/40000 = 0.3) is more depleted than requests (45/50 = 0.9) — tokens binds.
		expect(reading?.level).toBeCloseTo(0.3, 10);
		expect(reading?.resetAtMs).toBe(Date.parse("2026-08-03T18:30:30Z"));
	});

	it("headers arrive lowercased on the real path — this is the contract the parser is built against", () => {
		const lowercased = Object.fromEntries(Object.entries(anthropicHeaders).map(([k, v]) => [k.toLowerCase(), v]));
		expect(readRateLimitHeaders("anthropic", lowercased, 1_000)?.level).toBeCloseTo(0.3, 10);
	});

	it("still parses mixed-case headers defensively — mocks and non-HTTP transports bypass the real normalizer", () => {
		const mixedCase = {
			"Anthropic-Ratelimit-Requests-Limit": "50",
			"Anthropic-Ratelimit-Requests-Remaining": "45",
		};
		expect(readRateLimitHeaders("anthropic", mixedCase, 1_000)?.level).toBeCloseTo(0.9, 10);
	});

	it("absent headers ({}) parse to undefined — unmounted", () => {
		expect(readRateLimitHeaders("anthropic", {}, 1_000)).toBeUndefined();
	});

	it("unrecognized headers (no anthropic-ratelimit-* keys at all) parse to undefined — invisible, never guessed", () => {
		expect(readRateLimitHeaders("anthropic", { "x-request-id": "abc" }, 1_000)).toBeUndefined();
	});

	it("a resource missing either limit or remaining is skipped, not fabricated", () => {
		const partial = { "anthropic-ratelimit-requests-limit": "50" }; // no remaining
		expect(readRateLimitHeaders("anthropic", partial, 1_000)).toBeUndefined();
	});

	it("a bucket with no reset header still counts — reset is independently optional", () => {
		const noReset = { "anthropic-ratelimit-requests-limit": "50", "anthropic-ratelimit-requests-remaining": "10" };
		const reading = readRateLimitHeaders("anthropic", noReset, 1_000);
		expect(reading?.level).toBeCloseTo(0.2, 10);
		expect(reading?.resetAtMs).toBeUndefined();
	});
});

describe("readRateLimitHeaders — openai family", () => {
	it("parses the x-ratelimit-{field}-{resource} shape (reversed word order) and normalizes the duration reset to an absolute epoch", () => {
		const reading = readRateLimitHeaders("openai", openaiHeaders, 1_000);
		// tokens (5000/60000 ≈ 0.083) is more depleted than requests (2999/3000) — tokens binds.
		expect(reading?.level).toBeCloseTo(5000 / 60000, 10);
		expect(reading?.resetAtMs).toBe(1_000 + 1_000); // "1s" reset, relative to the injected nowMs
	});

	it("absent headers ({}) parse to undefined — unmounted", () => {
		expect(readRateLimitHeaders("openai", {}, 1_000)).toBeUndefined();
	});
});

describe("both reset formats normalize to the same absolute-epoch representation", () => {
	it("anthropic's RFC3339 timestamp and openai's Go-style duration both resolve to a plain absolute epoch ms number", () => {
		const anthropicReading = readRateLimitHeaders("anthropic", anthropicHeaders, 5_000);
		const openaiReading = readRateLimitHeaders("openai", openaiHeaders, 5_000);
		expect(typeof anthropicReading?.resetAtMs).toBe("number");
		expect(typeof openaiReading?.resetAtMs).toBe("number");
		// The anthropic reset is an absolute wall-clock timestamp independent of nowMs...
		expect(readRateLimitHeaders("anthropic", anthropicHeaders, 999_999)?.resetAtMs).toBe(
			readRateLimitHeaders("anthropic", anthropicHeaders, 5_000)?.resetAtMs,
		);
		// ...while openai's is relative to the injected nowMs (a duration), so it shifts with it.
		expect(readRateLimitHeaders("openai", openaiHeaders, 999_999)?.resetAtMs).toBe(999_999 + 1_000);
	});
});

describe("parseGoDurationMs", () => {
	it("parses simple single-unit durations", () => {
		expect(parseGoDurationMs("1s")).toBe(1_000);
		expect(parseGoDurationMs("180ms")).toBe(180);
		expect(parseGoDurationMs("0s")).toBe(0);
	});

	it("parses compound durations by summing every token", () => {
		expect(parseGoDurationMs("6m0s")).toBe(360_000);
		expect(parseGoDurationMs("1h2m3s")).toBe(3_600_000 + 120_000 + 3_000);
	});

	it("rejects malformed or partially-unparseable strings rather than returning a partial duration", () => {
		expect(parseGoDurationMs("")).toBeUndefined();
		expect(parseGoDurationMs("abc")).toBeUndefined();
		expect(parseGoDurationMs("-5s")).toBeUndefined();
		expect(parseGoDurationMs("5x")).toBeUndefined();
		expect(parseGoDurationMs("5s!")).toBeUndefined();
	});
});

describe("refillLevel — renderer stays pure given injected nowMs", () => {
	it("holds the observed level at the observed instant and eases to full by the reset instant", () => {
		expect(refillLevel(0.2, 1_000, 1_000, 2_000)).toBe(0.2);
		expect(refillLevel(0.2, 1_500, 1_000, 2_000)).toBeCloseTo(0.6, 10);
		expect(refillLevel(0.2, 2_000, 1_000, 2_000)).toBe(1);
	});

	it("never exceeds full once nowMs passes the reset", () => {
		expect(refillLevel(0.2, 5_000, 1_000, 2_000)).toBe(1);
	});

	it("holds the raw observed level forever when the binding bucket reported no reset", () => {
		expect(refillLevel(0.2, 999_999, 1_000, undefined)).toBe(0.2);
	});

	it("holds the raw observed level for a non-positive reset window (malformed data)", () => {
		expect(refillLevel(0.2, 1_500, 1_000, 1_000)).toBe(0.2);
		expect(refillLevel(0.2, 1_500, 1_000, 500)).toBe(0.2);
	});

	it("is a pure function of its four numeric inputs — same inputs, same output, regardless of call order", () => {
		const a = refillLevel(0.4, 1_700, 1_000, 2_000);
		const b = refillLevel(0.4, 1_700, 1_000, 2_000);
		expect(a).toBe(b);
	});
});

describe("poolTier — NaN-safe, calm-biased like Drift Buoy's driftTier", () => {
	it("reads calm at/above the calm threshold", () => {
		expect(poolTier(1)).toBe("calm");
		expect(poolTier(POOL_CALM_THRESHOLD)).toBe("calm");
	});

	it("reads pebbles between the two thresholds", () => {
		expect(poolTier(POOL_CALM_THRESHOLD - 0.01)).toBe("pebbles");
		expect(poolTier(POOL_SAND_THRESHOLD)).toBe("pebbles");
	});

	it("reads sand strictly below the sand threshold", () => {
		expect(poolTier(POOL_SAND_THRESHOLD - 0.01)).toBe("sand");
		expect(poolTier(0)).toBe("sand");
	});

	it("reads non-finite/negative levels as the calm, unalarming default rather than propagating NaN", () => {
		expect(poolTier(Number.NaN)).toBe("calm");
		expect(poolTier(Number.POSITIVE_INFINITY)).toBe("calm");
	});
});

describe("poolFilledCells", () => {
	it("scales linearly with level and rounds to whole cells", () => {
		expect(poolFilledCells(1, 10)).toBe(10);
		expect(poolFilledCells(0.5, 10)).toBe(5);
		expect(poolFilledCells(0, 10)).toBe(0);
	});

	it("clamps a level above 1 to a full bar rather than overflowing", () => {
		expect(poolFilledCells(1.5, 10)).toBe(10);
	});

	it("is 0 for non-finite/negative levels or a non-positive cell budget", () => {
		expect(poolFilledCells(Number.NaN, 10)).toBe(0);
		expect(poolFilledCells(-1, 10)).toBe(0);
		expect(poolFilledCells(1, 0)).toBe(0);
	});
});

describe("shimmerBeat", () => {
	it("flips exactly once per period", () => {
		expect(shimmerBeat(0)).toBe(true);
		expect(shimmerBeat(SHIMMER_PERIOD_MS / 2 - 1)).toBe(true);
		expect(shimmerBeat(SHIMMER_PERIOD_MS / 2)).toBe(false);
		expect(shimmerBeat(SHIMMER_PERIOD_MS)).toBe(true); // wraps to a new period
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// Pure rendering (render.ts)
// ═══════════════════════════════════════════════════════════════════════════

describe("rate-limit tidepool pure rendering — width tiers at 69 columns", () => {
	it("renders a calm, full pool at 69 columns", () => {
		const row = renderTidepoolRow(1, "anthropic", 0, 69, idTheme, "subtle");
		expect(row).toBe("≈≈≈≈≈≈≈≈≈≈ 100% anthropic");
		expect(row.length).toBeLessThanOrEqual(69);
	});

	it("renders a draining pool showing pebbles at 69 columns", () => {
		const row = renderTidepoolRow(0.5, "openai", 0, 69, idTheme, "subtle");
		expect(row).toBe("≈≈≈≈≈∘∘∘∘∘ 50% openai");
		expect(row.length).toBeLessThanOrEqual(69);
	});

	it("renders a near-empty pool showing wet sand at 69 columns", () => {
		const row = renderTidepoolRow(0.1, "anthropic", 0, 69, idTheme, "subtle");
		expect(row).toBe("≈········· 10% anthropic");
		expect(row.length).toBeLessThanOrEqual(69);
	});

	it("every width from 1 to 69 stays inside its own budget across every tier", () => {
		for (const level of [1, 0.5, 0.1, 0]) {
			for (let width = 1; width <= 69; width++) {
				const row = renderTidepoolRow(level, "anthropic", 0, width, idTheme, "subtle");
				expect(row.length).toBeLessThanOrEqual(width);
			}
		}
	});

	it("threads a live preset into the bar's water/pebble glyphs — not just the default", () => {
		const row = renderTidepoolRow(0.5, "openai", 0, 69, idTheme, "subtle", undefined, "ascii");
		expect(row).toBe("~~~~~..... 50% openai");
		expect(row).not.toContain(waterGlyph("unicode"));
		expect(row).not.toContain(pebbleGlyph("unicode"));
	});
});

describe("rate-limit tidepool pure rendering — width degradation", () => {
	it("drops the bar first, keeping the honest 'NN% provider' label", () => {
		const plain = renderTidepoolRow(0.5, "openai", 0, 15, idTheme, "subtle");
		expect(plain).toBe("50% openai");
	});

	it("drops the provider name next, keeping just the percentage", () => {
		const bare = renderTidepoolRow(0.5, "openai", 0, 5, idTheme, "subtle");
		expect(bare).toBe("50%");
	});

	it("degrades to a single tier glyph at width 1", () => {
		expect(renderTidepoolRow(1, "anthropic", 0, 1, idTheme, "subtle")).toBe("≈");
		expect(renderTidepoolRow(0.5, "anthropic", 0, 1, idTheme, "subtle")).toBe("∘");
		expect(renderTidepoolRow(0, "anthropic", 0, 1, idTheme, "subtle")).toBe("·");
	});

	it("renders nothing at zero or negative width", () => {
		expect(renderTidepoolRow(0.5, "openai", 0, 0, idTheme, "subtle")).toBe("");
		expect(renderTidepoolRow(0.5, "openai", 0, -5, idTheme, "subtle")).toBe("");
	});
});

describe("rate-limit tidepool pure rendering — shimmer and coloring", () => {
	it("the full motion tier shimmers the edge cell on a slow beat; subtle never shimmers", () => {
		const fullOnBeat = renderTidepoolRow(0.5, "openai", 0, 69, idTheme, "full");
		const fullOffBeat = renderTidepoolRow(0.5, "openai", SHIMMER_PERIOD_MS / 2, 69, idTheme, "full");
		expect(fullOnBeat).not.toBe(fullOffBeat);
		const subtleOnBeat = renderTidepoolRow(0.5, "openai", 0, 69, idTheme, "subtle");
		const subtleOffBeat = renderTidepoolRow(0.5, "openai", SHIMMER_PERIOD_MS / 2, 69, idTheme, "subtle");
		expect(subtleOnBeat).toBe(subtleOffBeat);
	});

	it("the sand tier never shimmers, even in the full motion tier", () => {
		const a = renderTidepoolRow(0.05, "anthropic", 0, 69, idTheme, "full");
		const b = renderTidepoolRow(0.05, "anthropic", SHIMMER_PERIOD_MS / 2, 69, idTheme, "full");
		expect(a).toBe(b);
	});

	it("the sand tier colors the exposed cells with the fixed alarm color, not the accent slot", () => {
		// level 0 fills zero cells, so every cell is exposed — the only way to
		// assert the fixed alarm color without a rounded-up water cell (at 10
		// cells, anything below 0.05 already rounds to at least one filled cell).
		const row = renderTidepoolRow(0, "anthropic", 0, 69, taggedTheme, "subtle", {
			water: "syntaxString",
			pebble: "dim",
			sand: "warning",
			label: "dim",
		});
		expect(row).toContain("warning:·");
		expect(row).not.toContain("syntaxString:");
	});

	it("an accent override recolors only the water glyph, never the fixed sand alarm", () => {
		const colors = {
			water: "syntaxString" as const,
			pebble: "dim" as const,
			sand: "warning" as const,
			label: "dim" as const,
		};
		const calm = renderTidepoolRow(1, "anthropic", 0, 69, taggedTheme, "subtle", colors);
		expect(calm).toContain("syntaxString:≈");
		const sand = renderTidepoolRow(0, "anthropic", 0, 69, taggedTheme, "subtle", colors);
		expect(sand).toContain("warning:·");
		expect(sand).not.toContain("syntaxString:");
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// RateLimitTidepoolState
// ═══════════════════════════════════════════════════════════════════════════

describe("RateLimitTidepoolState", () => {
	it("starts with no snapshot", () => {
		const state = new RateLimitTidepoolState();
		expect(state.snapshot()).toBeUndefined();
	});

	it("applySample replaces the whole snapshot, never merges", () => {
		const state = new RateLimitTidepoolState();
		state.applySample({
			provider: "anthropic",
			family: "anthropic",
			level: 0.9,
			resetAtMs: undefined,
			observedAtMs: 0,
		});
		state.applySample({ provider: "openai", family: "openai", level: 0.2, resetAtMs: 5_000, observedAtMs: 1_000 });
		expect(state.snapshot()).toEqual({
			provider: "openai",
			family: "openai",
			level: 0.2,
			resetAtMs: 5_000,
			observedAtMs: 1_000,
		});
	});
});
