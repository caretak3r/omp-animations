import { describe, expect, it } from "bun:test";
import { renderLegend } from "../src/animations-box/legend";
import { OPTIONAL_SEGMENT_REGISTRY, REQUIRED_SEGMENT_REGISTRY, SEGMENT_REGISTRY } from "../src/animations-box/segments";

// The legend documents the status-line grammar: the dot vocabulary, required
// summaries, and optional animations.

describe("SEGMENT_REGISTRY — metadata contract", () => {
	it("every segment has a non-empty id, label, and description", () => {
		for (const segment of SEGMENT_REGISTRY) {
			expect(segment.id).toBeTruthy();
			expect(typeof segment.id).toBe("string");
			expect(segment.label).toBeTruthy();
			expect(typeof segment.label).toBe("string");
			expect(segment.description).toBeTruthy();
			expect(segment.description.length).toBeGreaterThan(10); // Real description, not stub
		}
	});
});

describe("renderLegend", () => {
	it("opens with D2's four-row dot table in escalation order (unicode)", () => {
		const lines = renderLegend("unicode");
		expect(lines.slice(0, 4)).toEqual([
			"○ idle — nothing yet, or metric not available here",
			"● live — healthy",
			"◐ notable — worth a glance",
			"● alert — act",
		]);
	});

	it("resolves the dot glyphs through the preset (ascii)", () => {
		const lines = renderLegend("ascii");
		expect(lines.slice(0, 4)).toEqual([
			". idle — nothing yet, or metric not available here",
			"* live — healthy",
			"! notable — worth a glance",
			"! alert — act",
		]);
	});

	it("separates the dot table from the segment rows with one blank line", () => {
		expect(renderLegend("unicode")[4]).toBe("");
	});

	it("lists required summaries in canonical order, then optional animations after one blank separator", () => {
		const lines = renderLegend("unicode");
		const requiredStart = 5;
		const optionalSeparator = requiredStart + REQUIRED_SEGMENT_REGISTRY.length;
		expect(lines.slice(requiredStart, optionalSeparator)).toEqual(
			REQUIRED_SEGMENT_REGISTRY.map(segment => `${segment.label} — ${segment.description}`),
		);
		expect(lines[optionalSeparator]).toBe("");
		expect(lines.slice(optionalSeparator + 1)).toEqual(
			OPTIONAL_SEGMENT_REGISTRY.map(segment => `${segment.label} — ${segment.description}`),
		);
	});

	it("derives one row from each live registry entry", () => {
		expect(renderLegend("unicode")).toHaveLength(
			4 + 1 + REQUIRED_SEGMENT_REGISTRY.length + 1 + OPTIONAL_SEGMENT_REGISTRY.length,
		);
		expect(SEGMENT_REGISTRY).toEqual([...REQUIRED_SEGMENT_REGISTRY, ...OPTIONAL_SEGMENT_REGISTRY]);
	});

	it("segment rows are preset-independent — only the dot glyphs vary", () => {
		expect(renderLegend("unicode").slice(4)).toEqual(renderLegend("ascii").slice(4));
	});
});
