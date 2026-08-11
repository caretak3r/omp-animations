import { describe, expect, it } from "bun:test";
import { renderLegend } from "../src/animations-box/legend";
import {
	AUDIT_TRAIL_SEGMENT,
	CACHE_METER_SEGMENT,
	CADENCE_EQUALIZER_SEGMENT,
	PALIMPSEST_SEGMENT,
	RATE_LIMIT_TIDEPOOL_SEGMENT,
	REFLECTION_RIPPLE_SEGMENT,
	SEGMENT_REGISTRY,
	TOOL_CONSTELLATION_SEGMENT,
} from "../src/animations-box/segments";
import { resolveGlyph } from "../src/glyph-presets";

describe("SEGMENT_REGISTRY", () => {
	it("contains all 7 segments in priority order", () => {
		expect(SEGMENT_REGISTRY).toEqual([
			CACHE_METER_SEGMENT,
			CADENCE_EQUALIZER_SEGMENT,
			AUDIT_TRAIL_SEGMENT,
			RATE_LIMIT_TIDEPOOL_SEGMENT,
			TOOL_CONSTELLATION_SEGMENT,
			PALIMPSEST_SEGMENT,
			REFLECTION_RIPPLE_SEGMENT,
		]);
	});

	it("every segment has a non-empty id, label, description, and glyphKey", () => {
		for (const segment of SEGMENT_REGISTRY) {
			expect(segment.id).toBeTruthy();
			expect(typeof segment.id).toBe("string");
			expect(segment.label).toBeTruthy();
			expect(typeof segment.label).toBe("string");
			expect(segment.description).toBeTruthy();
			expect(typeof segment.description).toBe("string");
			expect(segment.description.length).toBeGreaterThan(10); // Real description, not stub
			expect(segment.glyphKey).toBeTruthy();
			expect(typeof segment.glyphKey).toBe("string");
		}
	});

	it("every segment has unique id", () => {
		const ids = SEGMENT_REGISTRY.map(s => s.id);
		const uniqueIds = new Set(ids);
		expect(uniqueIds.size).toBe(SEGMENT_REGISTRY.length);
	});

	it("every segment has unique label", () => {
		const labels = SEGMENT_REGISTRY.map(s => s.label);
		const uniqueLabels = new Set(labels);
		expect(uniqueLabels.size).toBe(SEGMENT_REGISTRY.length);
	});
});

describe("renderLegend", () => {
	it("returns one line per segment in the registry", () => {
		const lines = renderLegend("unicode");
		expect(lines).toHaveLength(SEGMENT_REGISTRY.length);
		expect(lines).toHaveLength(7); // Explicit count assertion
	});

	it("each line contains the segment's resolved glyph, label, and description", () => {
		const preset = "unicode";
		const lines = renderLegend(preset);

		for (let i = 0; i < SEGMENT_REGISTRY.length; i++) {
			const segment = SEGMENT_REGISTRY[i];
			const line = lines[i];
			const expectedGlyph = resolveGlyph(segment.glyphKey, preset);

			expect(line).toContain(expectedGlyph);
			expect(line).toContain(segment.label);
			expect(line).toContain(segment.description);
			expect(line).toBe(`${expectedGlyph} ${segment.label} — ${segment.description}`);
		}
	});

	it("renders cache meter segment correctly (unicode)", () => {
		const lines = renderLegend("unicode");
		const cacheLine = lines[0]; // First in priority order
		const expectedGlyph = resolveGlyph(CACHE_METER_SEGMENT.glyphKey, "unicode");

		expect(cacheLine).toBe(`${expectedGlyph} cache — Prompt cache hit rate and cost savings`);
	});

	it("renders cache meter segment correctly (ascii)", () => {
		const lines = renderLegend("ascii");
		const cacheLine = lines[0];
		const expectedGlyph = resolveGlyph(CACHE_METER_SEGMENT.glyphKey, "ascii");

		expect(cacheLine).toBe(`${expectedGlyph} cache — Prompt cache hit rate and cost savings`);
	});

	it("respects preset for glyph resolution (unicode vs ascii)", () => {
		const unicodeLines = renderLegend("unicode");
		const asciiLines = renderLegend("ascii");

		expect(unicodeLines).toHaveLength(asciiLines.length);

		// Glyphs should differ for at least some segments
		const unicodeGlyphs = unicodeLines.map(line => line.split(" ")[0]);
		const asciiGlyphs = asciiLines.map(line => line.split(" ")[0]);

		// At least one glyph should differ between presets
		const hasDifference = unicodeGlyphs.some((glyph, i) => glyph !== asciiGlyphs[i]);
		expect(hasDifference).toBe(true);
	});

	it("all segments appear exactly once in legend output", () => {
		const lines = renderLegend("unicode");
		const seenSegments = new Set<string>();

		for (const line of lines) {
			// Extract label from "glyph label — description" format
			const match = line.match(/^(.)\s+(\S+)\s+—/);
			expect(match).toBeTruthy();
			const label = match![2]; // Group 2 is the label

			expect(seenSegments.has(label)).toBe(false); // No duplicates
			seenSegments.add(label);
		}

		expect(seenSegments.size).toBe(SEGMENT_REGISTRY.length);

		// Verify all expected labels are present
		for (const segment of SEGMENT_REGISTRY) {
			expect(seenSegments.has(segment.label)).toBe(true);
		}
	});

	it("preserves priority order from SEGMENT_REGISTRY", () => {
		const lines = renderLegend("unicode");

		// Extract labels in order
		const labels = lines.map(line => {
			const match = line.match(/^(.)\s+(\S+)\s+—/);
			return match![2];
		});

		const expectedLabels = SEGMENT_REGISTRY.map(s => s.label);
		expect(labels).toEqual(expectedLabels);
	});

	it("builds legend from LIVE registry (adding a hypothetical segment would appear)", () => {
		// This test documents that renderLegend iterates the ACTUAL SEGMENT_REGISTRY,
		// not a hand-copied list. If a new segment is added to SEGMENT_REGISTRY,
		// renderLegend will automatically include it.

		const lineCount = renderLegend("unicode").length;
		const registryCount = SEGMENT_REGISTRY.length;

		expect(lineCount).toBe(registryCount);
		// This assertion would fail if renderLegend used a stale hardcoded list
	});
});
