import { describe, expect, it } from "bun:test";
import { FADE_AFTER_TURNS, GLOW_THRESHOLD, IntervalSet, parseHunkSpans } from "../src/palimpsest/spans";
import { PalimpsestState } from "../src/palimpsest/state";

/** A unified diff with a single hunk header touching new-file lines `[start, end]`. */
function hunkDiff(start: number, end: number = start): string {
	const count = end - start + 1;
	const lines = Array.from({ length: count }, (_, i) => `+line ${start + i}`);
	return [`@@ -${start},${count} +${start},${count} @@`, ...lines].join("\n");
}

describe("parseHunkSpans", () => {
	it("parses a single hunk header into its new-file line span", () => {
		expect(parseHunkSpans(hunkDiff(10, 12))).toEqual([{ start: 10, end: 12 }]);
	});

	it("defaults the count to 1 when the header omits it", () => {
		expect(parseHunkSpans("@@ -5 +5 @@\n+x")).toEqual([{ start: 5, end: 5 }]);
	});

	it("parses every hunk header in a multi-hunk diff", () => {
		const diff = `${hunkDiff(1, 2)}\n${hunkDiff(50, 51)}`;
		expect(parseHunkSpans(diff)).toEqual([
			{ start: 1, end: 2 },
			{ start: 50, end: 51 },
		]);
	});

	it("a pure-deletion hunk (new-file count 0) still yields a single-line anchor at the new-file start", () => {
		expect(parseHunkSpans("@@ -10,3 +10,0 @@\n-a\n-b\n-c")).toEqual([{ start: 10, end: 10 }]);
	});

	it("ignores non-header lines and returns an empty array for a diff with no hunks", () => {
		expect(parseHunkSpans("+not a header\n-neither is this")).toEqual([]);
		expect(parseHunkSpans("")).toEqual([]);
	});

	it("tolerates extra whitespace and trailing function-context text after the closing @@", () => {
		expect(parseHunkSpans("@@  -3,1  +3,1  @@ function foo() {\n+x")).toEqual([{ start: 3, end: 3 }]);
	});
});

describe("IntervalSet", () => {
	it("a single span starts at overlap count 1", () => {
		const set = new IntervalSet();
		set.addSpan({ start: 10, end: 12 }, 0);
		expect(set.regions).toEqual([{ start: 10, end: 12, overlapCount: 1, lastTouchedTurn: 0 }]);
	});

	it("the same span touched twice merges into one region at overlap count 2", () => {
		const set = new IntervalSet();
		set.addSpan({ start: 10, end: 12 }, 0);
		set.addSpan({ start: 10, end: 12 }, 1);
		expect(set.regions).toEqual([{ start: 10, end: 12, overlapCount: 2, lastTouchedTurn: 1 }]);
	});

	it("a partially-overlapping second span splits into three sub-regions with the correct counts", () => {
		const set = new IntervalSet();
		set.addSpan({ start: 10, end: 20 }, 0);
		set.addSpan({ start: 15, end: 25 }, 1);
		expect(set.regions).toEqual([
			{ start: 10, end: 14, overlapCount: 1, lastTouchedTurn: 0 },
			{ start: 15, end: 20, overlapCount: 2, lastTouchedTurn: 1 },
			{ start: 21, end: 25, overlapCount: 1, lastTouchedTurn: 1 },
		]);
	});

	it("pruneStale drops only regions whose last touch is maxAge turns old or older, and reports whether anything changed", () => {
		const set = new IntervalSet();
		set.addSpan({ start: 1, end: 1 }, 0);
		set.addSpan({ start: 5, end: 5 }, 2);
		expect(set.pruneStale(2, 3)).toBe(false); // 2 - 0 = 2 < 3, neither region is stale yet
		expect(set.pruneStale(3, 3)).toBe(true); // 3 - 0 = 3, the turn-0 region ages out
		expect(set.regions).toEqual([{ start: 5, end: 5, overlapCount: 1, lastTouchedTurn: 2 }]);
	});

	it("an out-of-order span (end < start) is a no-op", () => {
		const set = new IntervalSet();
		set.addSpan({ start: 10, end: 5 }, 0);
		expect(set.isEmpty).toBe(true);
	});
});

describe("GLOW_THRESHOLD", () => {
	it("is the second touch — a region below it is not thrashing yet", () => {
		expect(GLOW_THRESHOLD).toBe(2);
	});
});

describe("PalimpsestState", () => {
	it("applySpans accumulates overlap counts across repeated touches to the same span", () => {
		const state = new PalimpsestState();
		state.applySpans("a.ts", [{ start: 10, end: 12 }]);
		state.applySpans("a.ts", [{ start: 10, end: 12 }]);
		expect(state.snapshot().rows).toEqual([
			{ path: "a.ts", start: 10, end: 12, overlapCount: 2, lastTouchedTurn: 0 },
		]);
	});

	it("onCreate resets any stale prior ledger entry for the path", () => {
		const state = new PalimpsestState();
		state.applySpans("a.ts", [{ start: 1, end: 1 }]);
		state.applySpans("a.ts", [{ start: 1, end: 1 }]);
		expect(state.snapshot().rows).toHaveLength(1);
		state.onCreate("a.ts");
		expect(state.snapshot().rows).toEqual([]);
		expect(state.isEmpty).toBe(false); // an empty-but-tracked entry still exists
	});

	it("onDelete clears the path entirely", () => {
		const state = new PalimpsestState();
		state.applySpans("a.ts", [{ start: 1, end: 1 }]);
		state.onDelete("a.ts");
		expect(state.isEmpty).toBe(true);
	});

	it("onRename migrates the ledger key so history follows the file", () => {
		const state = new PalimpsestState();
		state.applySpans("old.ts", [{ start: 1, end: 1 }]);
		state.applySpans("old.ts", [{ start: 1, end: 1 }]);
		state.onRename("old.ts", "new.ts");
		const rows = state.snapshot().rows;
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ path: "new.ts", overlapCount: 2 });
	});

	it("onRename onto an already-tracked destination replaces the destination's history", () => {
		const state = new PalimpsestState();
		state.applySpans("old.ts", [{ start: 1, end: 1 }]);
		state.applySpans("new.ts", [{ start: 99, end: 99 }]);
		state.onRename("old.ts", "new.ts");
		expect(state.snapshot().rows).toEqual([
			{ path: "new.ts", start: 1, end: 1, overlapCount: 1, lastTouchedTurn: 0 },
		]);
	});

	it("applyDegradedTouch counts at path level and never invents a line span", () => {
		const state = new PalimpsestState();
		state.applyDegradedTouch("a.ts");
		state.applyDegradedTouch("a.ts");
		expect(state.snapshot().rows).toEqual([
			{ path: "a.ts", start: undefined, end: undefined, overlapCount: 2, lastTouchedTurn: 0 },
		]);
	});

	it("once degraded, a path stays degraded even if a later touch carries real spans", () => {
		const state = new PalimpsestState();
		state.applyDegradedTouch("a.ts");
		state.applySpans("a.ts", [{ start: 10, end: 12 }]);
		const rows = state.snapshot().rows;
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ path: "a.ts", start: undefined, overlapCount: 2 });
	});

	it("advanceTurn ignores a turnIndex at or behind the current one", () => {
		const state = new PalimpsestState();
		expect(state.advanceTurn(0)).toBe(false);
		state.advanceTurn(5);
		expect(state.turn).toBe(5);
		expect(state.advanceTurn(5)).toBe(false);
		expect(state.advanceTurn(3)).toBe(false);
		expect(state.turn).toBe(5);
	});

	it(`advanceTurn ages a region out after ${FADE_AFTER_TURNS} turns without a re-touch, and empties the path from the ledger`, () => {
		const state = new PalimpsestState();
		state.applySpans("a.ts", [{ start: 1, end: 1 }]);
		for (let turn = 1; turn < FADE_AFTER_TURNS; turn++) {
			expect(state.advanceTurn(turn)).toBe(false);
			expect(state.isEmpty).toBe(false);
		}
		expect(state.advanceTurn(FADE_AFTER_TURNS)).toBe(true);
		expect(state.isEmpty).toBe(true);
	});

	it("advanceTurn ages a degraded entry out the same way", () => {
		const state = new PalimpsestState();
		state.applyDegradedTouch("a.ts");
		expect(state.advanceTurn(FADE_AFTER_TURNS)).toBe(true);
		expect(state.isEmpty).toBe(true);
	});
});
