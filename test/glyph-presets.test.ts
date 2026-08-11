import { describe, expect, it } from "bun:test";
import {
	type GlyphKey,
	resolveGlyph,
	resolveGlyphRamp,
	resolveRingGlyphRamp,
	resolveStarGlyphRamp,
} from "../src/glyph-presets";

const ALL_KEYS: readonly GlyphKey[] = [
	"border.ramp.0",
	"border.ramp.1",
	"border.ramp.2",
	"border.ramp.3",
	"box.limits",
	"box.files",
	"box.reflect",
	"box.bar.filled",
	"box.bar.empty",
	"box.bar.eighths.1",
	"box.bar.eighths.2",
	"box.bar.eighths.3",
	"box.bar.eighths.4",
	"box.bar.eighths.5",
	"box.bar.eighths.6",
	"box.bar.eighths.7",
	"cacheMeter.badge",
	"cacheMeter.badgePulse",
	"cacheMeter.invalidation",
	"auditTrail.badge",
	"auditTrail.badgePulse",
	"auditTrail.status.poisoned",
	"auditTrail.status.dirty",
	"auditTrail.status.redundant",
	"auditTrail.status.cold",
	"auditTrail.status.fresh",
	"toolConstellation.star.0",
	"toolConstellation.star.1",
	"toolConstellation.star.2",
	"toolConstellation.star.3",
	"toolConstellation.comet",
	"toolConstellation.empty",
	"toolConstellation.category.read",
	"toolConstellation.category.write",
	"toolConstellation.category.bash",
	"toolConstellation.category.search",
	"toolConstellation.category.agent",
	"toolConstellation.category.mcp",
	"toolConstellation.category.other",
	"rateLimitTidepool.water",
	"rateLimitTidepool.waterShimmer",
	"rateLimitTidepool.pebble",
	"rateLimitTidepool.sand",
	"reflectionRipple.ring.0",
	"reflectionRipple.ring.1",
	"reflectionRipple.ring.2",
	"reflectionRipple.ring.3",
	"reflectionRipple.ring.4",
];

describe("resolveGlyph — unicode preset (default, byte-identical to today's hardcoded literals)", () => {
	it("matches every original hardcoded glyph exactly", () => {
		expect(resolveGlyph("border.ramp.0", "unicode")).toBe("·");
		expect(resolveGlyph("border.ramp.1", "unicode")).toBe("─");
		expect(resolveGlyph("border.ramp.2", "unicode")).toBe("━");
		expect(resolveGlyph("border.ramp.3", "unicode")).toBe("█");
		expect(resolveGlyph("box.limits", "unicode")).toBe("◗");
		expect(resolveGlyph("box.files", "unicode")).toBe("▓");
		expect(resolveGlyph("box.reflect", "unicode")).toBe("○");
		expect(resolveGlyph("box.bar.filled", "unicode")).toBe("█");
		expect(resolveGlyph("box.bar.empty", "unicode")).toBe("░");
		expect(resolveGlyph("cacheMeter.badge", "unicode")).toBe("▤");
		expect(resolveGlyph("cacheMeter.badgePulse", "unicode")).toBe("▥");
		expect(resolveGlyph("cacheMeter.invalidation", "unicode")).toBe("⊘");
		expect(resolveGlyph("auditTrail.badge", "unicode")).toBe("▣");
		expect(resolveGlyph("auditTrail.badgePulse", "unicode")).toBe("▢");
		expect(resolveGlyph("auditTrail.status.poisoned", "unicode")).toBe("⊘");
		expect(resolveGlyph("auditTrail.status.dirty", "unicode")).toBe("✎\uFE0E");
		expect(resolveGlyph("auditTrail.status.redundant", "unicode")).toBe("⟳");
		expect(resolveGlyph("auditTrail.status.cold", "unicode")).toBe("❄\uFE0E");
		expect(resolveGlyph("auditTrail.status.fresh", "unicode")).toBe("✓\uFE0E");
		expect(resolveGlyph("toolConstellation.star.0", "unicode")).toBe("·");
		expect(resolveGlyph("toolConstellation.star.1", "unicode")).toBe("•");
		expect(resolveGlyph("toolConstellation.star.2", "unicode")).toBe("✦\uFE0E");
		expect(resolveGlyph("toolConstellation.star.3", "unicode")).toBe("✹\uFE0E");
		expect(resolveGlyph("toolConstellation.comet", "unicode")).toBe("☄\uFE0E");
		expect(resolveGlyph("toolConstellation.empty", "unicode")).toBe("·");
		expect(resolveGlyph("toolConstellation.category.read", "unicode")).toBe("⛏\uFE0E");
		expect(resolveGlyph("toolConstellation.category.write", "unicode")).toBe("✎\uFE0E");
		expect(resolveGlyph("toolConstellation.category.bash", "unicode")).toBe("↯");
		expect(resolveGlyph("toolConstellation.category.search", "unicode")).toBe("◈");
		expect(resolveGlyph("toolConstellation.category.agent", "unicode")).toBe("◆");
		expect(resolveGlyph("toolConstellation.category.mcp", "unicode")).toBe("⬡");
		expect(resolveGlyph("toolConstellation.category.other", "unicode")).toBe("∘");
		expect(resolveGlyph("rateLimitTidepool.water", "unicode")).toBe("≈");
		expect(resolveGlyph("rateLimitTidepool.waterShimmer", "unicode")).toBe("~");
		expect(resolveGlyph("rateLimitTidepool.pebble", "unicode")).toBe("∘");
		expect(resolveGlyph("rateLimitTidepool.sand", "unicode")).toBe("·");
		expect(resolveGlyph("reflectionRipple.ring.0", "unicode")).toBe(" ");
		expect(resolveGlyph("reflectionRipple.ring.1", "unicode")).toBe("·");
		expect(resolveGlyph("reflectionRipple.ring.2", "unicode")).toBe("∘");
		expect(resolveGlyph("reflectionRipple.ring.3", "unicode")).toBe("○");
		expect(resolveGlyph("reflectionRipple.ring.4", "unicode")).toBe("◉");
	});
});

describe("resolveGlyph — ascii preset (exact 1-column substitutes, non-negotiable)", () => {
	it("matches every documented substitute exactly, one column each", () => {
		expect(resolveGlyph("border.ramp.0", "ascii")).toBe(".");
		expect(resolveGlyph("border.ramp.1", "ascii")).toBe("-");
		expect(resolveGlyph("border.ramp.2", "ascii")).toBe("=");
		expect(resolveGlyph("border.ramp.3", "ascii")).toBe("#");
		expect(resolveGlyph("box.limits", "ascii")).toBe(")");
		expect(resolveGlyph("box.files", "ascii")).toBe("%");
		expect(resolveGlyph("box.reflect", "ascii")).toBe("o");
		expect(resolveGlyph("box.bar.filled", "ascii")).toBe("#");
		expect(resolveGlyph("box.bar.empty", "ascii")).toBe("-");
		expect(resolveGlyph("cacheMeter.badge", "ascii")).toBe("#");
		expect(resolveGlyph("cacheMeter.badgePulse", "ascii")).toBe("*");
		expect(resolveGlyph("cacheMeter.invalidation", "ascii")).toBe("x");
		expect(resolveGlyph("auditTrail.badge", "ascii")).toBe("@");
		expect(resolveGlyph("auditTrail.badgePulse", "ascii")).toBe("+");
		expect(resolveGlyph("auditTrail.status.poisoned", "ascii")).toBe("x");
		expect(resolveGlyph("auditTrail.status.dirty", "ascii")).toBe("/");
		expect(resolveGlyph("auditTrail.status.redundant", "ascii")).toBe("~");
		expect(resolveGlyph("auditTrail.status.cold", "ascii")).toBe("o");
		expect(resolveGlyph("auditTrail.status.fresh", "ascii")).toBe("v");
		expect(resolveGlyph("toolConstellation.star.0", "ascii")).toBe(".");
		expect(resolveGlyph("toolConstellation.star.1", "ascii")).toBe(",");
		expect(resolveGlyph("toolConstellation.star.2", "ascii")).toBe("*");
		expect(resolveGlyph("toolConstellation.star.3", "ascii")).toBe("#");
		expect(resolveGlyph("toolConstellation.comet", "ascii")).toBe("@");
		expect(resolveGlyph("toolConstellation.empty", "ascii")).toBe(".");
		expect(resolveGlyph("toolConstellation.category.read", "ascii")).toBe("^");
		expect(resolveGlyph("toolConstellation.category.write", "ascii")).toBe("/");
		expect(resolveGlyph("toolConstellation.category.bash", "ascii")).toBe("!");
		expect(resolveGlyph("toolConstellation.category.search", "ascii")).toBe("<");
		expect(resolveGlyph("toolConstellation.category.agent", "ascii")).toBe("#");
		expect(resolveGlyph("toolConstellation.category.mcp", "ascii")).toBe("o");
		expect(resolveGlyph("toolConstellation.category.other", "ascii")).toBe(".");
		expect(resolveGlyph("rateLimitTidepool.water", "ascii")).toBe("~");
		expect(resolveGlyph("rateLimitTidepool.waterShimmer", "ascii")).toBe("-");
		expect(resolveGlyph("rateLimitTidepool.pebble", "ascii")).toBe(".");
		expect(resolveGlyph("rateLimitTidepool.sand", "ascii")).toBe(",");
		expect(resolveGlyph("reflectionRipple.ring.0", "ascii")).toBe(" ");
		expect(resolveGlyph("reflectionRipple.ring.1", "ascii")).toBe(".");
		expect(resolveGlyph("reflectionRipple.ring.2", "ascii")).toBe(",");
		expect(resolveGlyph("reflectionRipple.ring.3", "ascii")).toBe("o");
		expect(resolveGlyph("reflectionRipple.ring.4", "ascii")).toBe("@");
	});

	it("every ascii substitute is exactly one 7-bit-clean column", () => {
		for (const key of ALL_KEYS) {
			const glyph = resolveGlyph(key, "ascii");
			expect(glyph).toHaveLength(1);
			expect(glyph.charCodeAt(0)).toBeLessThan(128);
		}
	});

	/**
	 * Per-widget within-surface collision guard: every distinct semantic glyph a single
	 * widget can render side by side (e.g. Audit Trail's badge + all five status cells in
	 * one row, or Tool Constellation's own star ramp + comet, or its own category-icon
	 * tally) must stay visually distinct in ascii too — see `../src/glyph-presets.ts`'s
	 * `ASCII_GLYPHS` doc for the cross-widget exception (identical unicode glyphs, or
	 * glyphs from widgets that never render together, may share a column).
	 */
	it("keeps every glyph a single widget renders simultaneously visually distinct in ascii", () => {
		const distinctAsciiCount = (keys: readonly GlyphKey[]) =>
			new Set(keys.map(key => resolveGlyph(key, "ascii"))).size;

		const cacheMeterKeys: readonly GlyphKey[] = [
			"cacheMeter.badge",
			"cacheMeter.badgePulse",
			"cacheMeter.invalidation",
		];
		expect(distinctAsciiCount(cacheMeterKeys)).toBe(cacheMeterKeys.length);

		const auditTrailKeys: readonly GlyphKey[] = [
			"auditTrail.badge",
			"auditTrail.badgePulse",
			"auditTrail.status.poisoned",
			"auditTrail.status.dirty",
			"auditTrail.status.redundant",
			"auditTrail.status.cold",
			"auditTrail.status.fresh",
		];
		expect(distinctAsciiCount(auditTrailKeys)).toBe(auditTrailKeys.length);

		// The star ramp + comet head render together in the grid; `empty` shares star.0's
		// column deliberately (identical unicode glyph already, see module doc) so it is
		// excluded from this particular distinctness check.
		const starRampAndCometKeys: readonly GlyphKey[] = [
			"toolConstellation.star.0",
			"toolConstellation.star.1",
			"toolConstellation.star.2",
			"toolConstellation.star.3",
			"toolConstellation.comet",
		];
		expect(distinctAsciiCount(starRampAndCometKeys)).toBe(starRampAndCometKeys.length);

		const categoryIconKeys: readonly GlyphKey[] = [
			"toolConstellation.category.read",
			"toolConstellation.category.write",
			"toolConstellation.category.bash",
			"toolConstellation.category.search",
			"toolConstellation.category.agent",
			"toolConstellation.category.mcp",
			"toolConstellation.category.other",
		];
		expect(distinctAsciiCount(categoryIconKeys)).toBe(categoryIconKeys.length);

		const tidepoolKeys: readonly GlyphKey[] = [
			"rateLimitTidepool.water",
			"rateLimitTidepool.waterShimmer",
			"rateLimitTidepool.pebble",
			"rateLimitTidepool.sand",
		];
		expect(distinctAsciiCount(tidepoolKeys)).toBe(tidepoolKeys.length);

		const ringRampKeys: readonly GlyphKey[] = [
			"reflectionRipple.ring.0",
			"reflectionRipple.ring.1",
			"reflectionRipple.ring.2",
			"reflectionRipple.ring.3",
			"reflectionRipple.ring.4",
		];
		expect(distinctAsciiCount(ringRampKeys)).toBe(ringRampKeys.length);
	});
});

describe("resolveGlyph — nerd preset (v1: aliases unicode exactly)", () => {
	it("resolves the identical value to unicode for every key", () => {
		for (const key of ALL_KEYS) {
			expect(resolveGlyph(key, "nerd")).toBe(resolveGlyph(key, "unicode"));
		}
	});
});

describe("resolveGlyphRamp", () => {
	it("returns the unicode border ramp in dimmest-to-heaviest order by default", () => {
		expect(resolveGlyphRamp("unicode")).toEqual(["·", "─", "━", "█"]);
	});

	it("returns the ascii border ramp in the same order", () => {
		expect(resolveGlyphRamp("ascii")).toEqual([".", "-", "=", "#"]);
	});

	it("nerd's ramp is identical to unicode's", () => {
		expect(resolveGlyphRamp("nerd")).toEqual(resolveGlyphRamp("unicode"));
	});
});

describe("resolveStarGlyphRamp", () => {
	it("returns the unicode star ramp, dimmest to brightest, excluding the comet glyph", () => {
		expect(resolveStarGlyphRamp("unicode")).toEqual(["·", "•", "✦\uFE0E", "✹\uFE0E"]);
	});

	it("returns the ascii star ramp in the same order, every entry one 7-bit column", () => {
		const ramp = resolveStarGlyphRamp("ascii");
		expect(ramp).toEqual([".", ",", "*", "#"]);
		for (const glyph of ramp) {
			expect(glyph).toHaveLength(1);
			expect(glyph.charCodeAt(0)).toBeLessThan(128);
		}
	});

	it("nerd's ramp is identical to unicode's", () => {
		expect(resolveStarGlyphRamp("nerd")).toEqual(resolveStarGlyphRamp("unicode"));
	});
});

describe("resolveRingGlyphRamp", () => {
	it("returns the unicode ring ramp, faintest to brightest", () => {
		expect(resolveRingGlyphRamp("unicode")).toEqual([" ", "·", "∘", "○", "◉"]);
	});

	it("returns the ascii ring ramp in the same order, every entry one 7-bit column", () => {
		const ramp = resolveRingGlyphRamp("ascii");
		expect(ramp).toEqual([" ", ".", ",", "o", "@"]);
		for (const glyph of ramp) {
			expect(glyph).toHaveLength(1);
			expect(glyph.charCodeAt(0)).toBeLessThan(128);
		}
	});

	it("nerd's ramp is identical to unicode's", () => {
		expect(resolveRingGlyphRamp("nerd")).toEqual(resolveRingGlyphRamp("unicode"));
	});
});

describe("glyph column width (VS15 audit — every glyph must measure exactly 1 column)", () => {
	const presets = ["unicode", "nerd", "ascii"] as const;
	const expectedWidth = 1;

	for (const preset of presets) {
		it(`${preset} tier: all glyphs measure exactly 1 column`, () => {
			const violations = ALL_KEYS.filter(key => Bun.stringWidth(resolveGlyph(key, preset)) !== expectedWidth).map(
				key =>
					`${preset}.${key} = "${resolveGlyph(key, preset)}" measures ${Bun.stringWidth(resolveGlyph(key, preset))} columns`,
			);
			expect(violations).toEqual([]);
		});
	}
});
