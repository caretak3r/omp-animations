import { describe, expect, it } from "bun:test";
import { composeSegments, SEGMENT_SEPARATOR, segment } from "../../src/kit";

describe("segment() — minWidth derivation", () => {
	it("derives minWidth from the narrowest (last) variant, not the widest", () => {
		const s = segment("x", 1, ["XXXXXXXXXX", "XXXXX", "X"]);
		expect(s).toMatchObject({ id: "x", priority: 1, minWidth: 1, variants: ["XXXXXXXXXX", "XXXXX", "X"] });
	});

	it("is 0 for a single empty-string variant, and for no variants at all", () => {
		expect(segment("empty", 1, [""]).minWidth).toBe(0);
		expect(segment("none", 1, []).minWidth).toBe(0);
	});
});

describe("composeSegments — priority-ranked, width-budgeted composition", () => {
	/** Two narrow-to-wide segments: priority 1 survives longest, priority 2 drops first. */
	function fixtures() {
		const x = segment("x", 1, ["XXXXXXXXXX", "XXXXX", "X"]); // widths 10 / 5 / 1
		const y = segment("y", 2, ["YYYYYYYYYY", "YYYYY", "Y"]); // widths 10 / 5 / 1
		return [x, y];
	}

	it("keeps every segment at its narrowest variant when the budget exactly fits", () => {
		// 1 + 3 (separator) + 1 = 5
		const { row, keptIds } = composeSegments(fixtures(), 5);
		expect(row).toBe(`X${SEGMENT_SEPARATOR}Y`);
		expect(keptIds).toEqual(["x", "y"]);
	});

	it("upgrades one step at a time, in priority order, spending only the budget it can afford", () => {
		// leftover 6 after the narrowest fit (5): x's mid variant costs +4 (fits, 9<=11),
		// y's mid variant would cost +4 more (9+4=13>11, does not fit) — x upgrades, y doesn't.
		const { row, keptIds } = composeSegments(fixtures(), 11);
		expect(row).toBe(`XXXXX${SEGMENT_SEPARATOR}Y`);
		expect(keptIds).toEqual(["x", "y"]);
	});

	it("jumps a segment straight to its widest affordable variant rather than creeping through the ladder", () => {
		// leftover after narrowest fit (5) is 9: x's widest variant costs +9 (5+9=14<=14) —
		// straight to the widest, skipping the mid variant entirely.
		const { row, keptIds } = composeSegments(fixtures(), 14);
		expect(row).toBe(`XXXXXXXXXX${SEGMENT_SEPARATOR}Y`);
		expect(keptIds).toEqual(["x", "y"]);
	});

	it("drops the lowest-priority segment first once even both narrowest variants don't fit", () => {
		// Both narrowest (5) don't fit budget 4 — y (priority 2, the higher number) drops first.
		const { row, keptIds } = composeSegments(fixtures(), 4);
		expect(row).toBe("X");
		expect(keptIds).toEqual(["x"]);
	});

	it("returns an empty row once even the sole remaining segment's narrowest variant doesn't fit", () => {
		expect(composeSegments(fixtures(), 0)).toEqual({ row: "", keptIds: [] });
		expect(composeSegments([], 100)).toEqual({ row: "", keptIds: [] });
	});

	it("drops a segment with zero variants before ranking, regardless of budget", () => {
		const empty = segment("empty", 1, []);
		const { row, keptIds } = composeSegments([empty, ...fixtures()], 100);
		expect(keptIds).not.toContain("empty");
		expect(row).toBe(`XXXXXXXXXX${SEGMENT_SEPARATOR}YYYYYYYYYY`);
	});

	it("sorts keptIds by ascending priority regardless of input order", () => {
		const [x, y] = fixtures();
		expect(composeSegments([y, x], 100).keptIds).toEqual(["x", "y"]);
	});

	it("holds an exact golden composition at width 69 minus the box's 4 border columns (65) — the maintainer's real pane", () => {
		const a = segment("a", 1, ["A".repeat(30), "A".repeat(10)]);
		const b = segment("b", 2, ["B".repeat(30), "B".repeat(10)]);
		const c = segment("c", 3, ["C".repeat(30), "C".repeat(10)]);
		// Narrowest total: 10+10+10 + 2 separators (3 each) = 36; leftover 29.
		// a upgrades to its widest (+20, 36+20=56<=65); b's widest would need +20 more
		// (56+20=76>65) — doesn't fit, and neither does c's after that. Only a upgrades.
		const { row, keptIds } = composeSegments([a, b, c], 65);
		expect(row).toBe(`${"A".repeat(30)}${SEGMENT_SEPARATOR}${"B".repeat(10)}${SEGMENT_SEPARATOR}${"C".repeat(10)}`);
		expect(row.length).toBe(56);
		expect(row.length).toBeLessThanOrEqual(65);
		expect(keptIds).toEqual(["a", "b", "c"]);
	});
});
