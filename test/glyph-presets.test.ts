import { describe, expect, it } from "bun:test";
import { type GlyphKey, resolveGlyph, resolveGlyphRamp } from "../src/glyph-presets";

const ALL_KEYS: readonly GlyphKey[] = [
	"border.ramp.0",
	"border.ramp.1",
	"border.ramp.2",
	"border.ramp.3",
	"box.limits",
	"box.files",
	"box.reflect",
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
	});

	it("every ascii substitute is exactly one 7-bit-clean column", () => {
		for (const key of ALL_KEYS) {
			const glyph = resolveGlyph(key, "ascii");
			expect(glyph).toHaveLength(1);
			expect(glyph.charCodeAt(0)).toBeLessThan(128);
		}
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
