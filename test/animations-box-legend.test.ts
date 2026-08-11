import { describe, expect, it } from "bun:test";
import { renderLegend } from "../src/animations-box/legend";
import {
	AUDIT_TRAIL_SEGMENT,
	CACHE_METER_SEGMENT,
	PALIMPSEST_SEGMENT,
	RATE_LIMIT_TIDEPOOL_SEGMENT,
	SEGMENT_REGISTRY,
	TOOL_CONSTELLATION_SEGMENT,
} from "../src/animations-box/segments";
import { BOX_SEGMENT_DEFAULT_VISIBLE } from "../src/animations-box/settings";

// D8: the legend documents the status-line grammar — D2's four-dot table plus
// the default-visible rows — not a per-segment glyph vocabulary (there is none).

const DEFAULT_VISIBLE_SEGMENTS = [
	CACHE_METER_SEGMENT,
	AUDIT_TRAIL_SEGMENT,
	RATE_LIMIT_TIDEPOOL_SEGMENT,
	TOOL_CONSTELLATION_SEGMENT,
	PALIMPSEST_SEGMENT,
] as const;

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

	it("lists exactly the default-visible segments as `label — description`, in priority order (D7 cut rows absent)", () => {
		const rows = renderLegend("unicode").slice(5);
		expect(rows).toEqual(DEFAULT_VISIBLE_SEGMENTS.map(s => `${s.label} — ${s.description}`));
		expect(rows.some(row => row.startsWith("cadence "))).toBe(false);
		expect(rows.some(row => row.startsWith("reflect "))).toBe(false);
	});

	it("derives its rows from the LIVE registry and visibility map — one row per default-visible registry entry", () => {
		const expected = SEGMENT_REGISTRY.filter(s => BOX_SEGMENT_DEFAULT_VISIBLE[s.id]).length;
		expect(renderLegend("unicode")).toHaveLength(4 + 1 + expected);
	});

	it("segment rows are preset-independent — only the dot glyphs vary", () => {
		expect(renderLegend("unicode").slice(4)).toEqual(renderLegend("ascii").slice(4));
	});
});
