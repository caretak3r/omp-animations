import { describe, expect, it } from "bun:test";
import type { EditToolResultEvent, TurnEndEvent } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { AnimationHost, type FrameScheduler, MotionPolicy } from "../src/kit";
import { type PalimpsestContext, PalimpsestController } from "../src/palimpsest/controller";
import {
	EMBER_PULSE_HOT_MS,
	EMBER_PULSE_PERIOD_MS,
	FADE_AFTER_TURNS,
	GLOW_THRESHOLD,
	IntervalSet,
	isEmberHot,
	parseHunkSpans,
	regionGlow,
} from "../src/palimpsest/spans";
import { PalimpsestState } from "../src/palimpsest/state";
import { MAX_ROWS_SHOWN, type PalimpsestTheme, PalimpsestWidget, renderPalimpsestRows } from "../src/palimpsest/widget";

// Identity theme so assertions see plain text instead of ANSI escapes.
const idTheme: PalimpsestTheme = { fg: (_color, text) => text, underline: text => text, bold: text => text };
// Tagging theme for tests that need to assert which token/style the renderer chose.
const taggedTheme: PalimpsestTheme = {
	fg: (color, text) => `${color}:${text}`,
	underline: text => `U(${text})`,
	bold: text => `B(${text})`,
};

/** Manual frame scheduler: drives host ticks deterministically. */
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

const fullEnv = { hasUI: true, isTTY: true, env: {} as Record<string, string | undefined> };

/** Records every `setWidget` call for assertion, with sensible full-motion defaults. */
function recordingContext(overrides: Partial<PalimpsestContext> = {}): {
	ctx: PalimpsestContext;
	calls: Array<{ key: string; content: unknown }>;
} {
	const calls: Array<{ key: string; content: unknown }> = [];
	const ctx: PalimpsestContext = {
		hasUI: true,
		isTTY: true,
		env: {},
		motionSetting: "full",
		theme: idTheme,
		setWidget: (key, content) => calls.push({ key, content }),
		...overrides,
	};
	return { ctx, calls };
}

class ToggleTui {
	renderUnderPressure = false;
	requestComponentRender(): void {}
}

/** A unified diff with a single hunk header touching new-file lines `[start, end]`. */
function hunkDiff(start: number, end: number = start): string {
	const count = end - start + 1;
	const lines = Array.from({ length: count }, (_, i) => `+line ${start + i}`);
	return [`@@ -${start},${count} +${start},${count} @@`, ...lines].join("\n");
}

interface PerFileTouch {
	path: string;
	diff: string;
	sourcePath?: string;
	op?: "create" | "delete" | "update";
	snapshotsPruned?: boolean;
	isError?: boolean;
}

/** Build a minimal `edit` `tool_result` event with the given diff (single-file) or per-file entries (multi-file). */
function editResult(
	diff: string,
	opts: {
		path?: string;
		sourcePath?: string;
		op?: "create" | "delete" | "update";
		snapshotsPruned?: boolean;
		perFileResults?: PerFileTouch[];
		isError?: boolean;
	} = {},
): EditToolResultEvent {
	return {
		type: "tool_result",
		toolName: "edit",
		toolCallId: "call-1",
		input: { path: opts.path ?? "a.ts" },
		content: [{ type: "text", text: "ok" }],
		isError: opts.isError ?? false,
		details: opts.perFileResults
			? { diff, perFileResults: opts.perFileResults }
			: {
					diff,
					path: opts.path ?? "a.ts",
					sourcePath: opts.sourcePath,
					op: opts.op,
					snapshotsPruned: opts.snapshotsPruned,
				},
	};
}

function turnEnd(turnIndex: number): TurnEndEvent {
	return { type: "turn_end", turnIndex, message: {} as never, toolResults: [] };
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

describe("regionGlow / isEmberHot", () => {
	it("classifies overlap counts into the four glow tiers at the documented thresholds", () => {
		expect(regionGlow(0)).toBe("hidden");
		expect(regionGlow(1)).toBe("hidden");
		expect(regionGlow(2)).toBe("underline");
		expect(regionGlow(3)).toBe("amber");
		expect(regionGlow(4)).toBe("ember");
		expect(regionGlow(9)).toBe("ember");
		expect(GLOW_THRESHOLD).toBe(2);
	});

	it("isEmberHot pulses hot for the first EMBER_PULSE_HOT_MS of each EMBER_PULSE_PERIOD_MS period, then cools", () => {
		expect(isEmberHot(0)).toBe(true);
		expect(isEmberHot(EMBER_PULSE_HOT_MS - 1)).toBe(true);
		expect(isEmberHot(EMBER_PULSE_HOT_MS)).toBe(false);
		expect(isEmberHot(EMBER_PULSE_PERIOD_MS - 1)).toBe(false);
		expect(isEmberHot(EMBER_PULSE_PERIOD_MS)).toBe(true); // wraps to the next period's hot window
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

describe("renderPalimpsestRows", () => {
	const row = (over: Partial<Parameters<typeof renderPalimpsestRows>[0]["rows"][number]>) => ({
		path: "a.ts",
		start: 1,
		end: 1,
		overlapCount: 2,
		lastTouchedTurn: 0,
		...over,
	});

	it("renders nothing when every row is below the glow threshold — healthy forward progress is invisible", () => {
		const snapshot = { rows: [row({ overlapCount: 1 }), row({ overlapCount: 0 })] };
		expect(renderPalimpsestRows(snapshot, 0, idTheme, "full")).toEqual([]);
	});

	it("underline tier wraps the label in the underline style at the dim token", () => {
		const snapshot = { rows: [row({ overlapCount: 2, path: "a.ts", start: 10, end: 12 })] };
		expect(renderPalimpsestRows(snapshot, 0, taggedTheme, "full")).toEqual(["dim:U(a.ts:10-12)"]);
	});

	it("amber tier renders the plain label at the warning token, no style wrapping", () => {
		const snapshot = { rows: [row({ overlapCount: 3, path: "a.ts", start: 5, end: 5 })] };
		expect(renderPalimpsestRows(snapshot, 0, taggedTheme, "full")).toEqual(["warning:a.ts:5"]);
	});

	it("ember tier bolds only during the hot pulse window on the full tier", () => {
		const snapshot = { rows: [row({ overlapCount: 4 })] };
		expect(renderPalimpsestRows(snapshot, 0, taggedTheme, "full")).toEqual(["error:B(a.ts:1)"]);
		expect(renderPalimpsestRows(snapshot, EMBER_PULSE_HOT_MS, taggedTheme, "full")).toEqual(["error:a.ts:1"]);
	});

	it("subtle tier renders the ember row statically — never bolded, regardless of elapsed time", () => {
		const snapshot = { rows: [row({ overlapCount: 5 })] };
		expect(renderPalimpsestRows(snapshot, 0, taggedTheme, "subtle")).toEqual(["error:a.ts:1"]);
		expect(renderPalimpsestRows(snapshot, EMBER_PULSE_PERIOD_MS * 3, taggedTheme, "subtle")).toEqual([
			"error:a.ts:1",
		]);
	});

	it("a degraded (path-level) row renders the bare path with no line numbers", () => {
		const snapshot = { rows: [row({ overlapCount: 3, path: "a.ts", start: undefined, end: undefined })] };
		expect(renderPalimpsestRows(snapshot, 0, taggedTheme, "full")).toEqual(["warning:a.ts"]);
	});

	it(`caps at ${MAX_ROWS_SHOWN} rows, keeping the highest overlap counts first and breaking ties by path`, () => {
		const snapshot = {
			rows: [
				row({ path: "a.ts", overlapCount: 4 }),
				row({ path: "b.ts", overlapCount: 3 }),
				row({ path: "d.ts", overlapCount: 2 }),
				row({ path: "c.ts", overlapCount: 2 }),
			],
		};
		const rendered = renderPalimpsestRows(snapshot, 0, idTheme, "full");
		expect(rendered).toEqual(["a.ts:1", "b.ts:1", "c.ts:1"]); // d.ts loses the overlapCount-2 tiebreak to c.ts
	});

	it("more recently re-touched rows are preferred over older ones at equal overlap count", () => {
		const snapshot = {
			rows: [
				row({ path: "old.ts", overlapCount: 2, lastTouchedTurn: 0 }),
				row({ path: "new.ts", overlapCount: 2, lastTouchedTurn: 5 }),
			],
		};
		const rendered = renderPalimpsestRows(snapshot, 0, idTheme, "full");
		expect(rendered).toEqual(["new.ts:1", "old.ts:1"]);
	});
});

describe("PalimpsestWidget", () => {
	it("off tier never subscribes to the frame clock, regardless of content", () => {
		const scheduler = manualScheduler();
		const policy = new MotionPolicy(fullEnv, "off");
		const host = new AnimationHost({ policy, scheduler });
		const state = new PalimpsestState();
		state.applySpans("a.ts", [{ start: 1, end: 1 }]);
		state.applySpans("a.ts", [{ start: 1, end: 1 }]);
		const widget = new PalimpsestWidget({ tui: new ToggleTui(), host, policy, state, theme: idTheme });

		expect(widget.animating).toBe(false);
		expect(host.subscriberCount).toBe(0);
	});

	it("off tier renders the same static rows as subtle when something is visible", () => {
		const scheduler = manualScheduler();
		const policy = new MotionPolicy(fullEnv, "off");
		const host = new AnimationHost({ policy, scheduler });
		const state = new PalimpsestState();
		state.applySpans("a.ts", [{ start: 1, end: 1 }]);
		state.applySpans("a.ts", [{ start: 1, end: 1 }]);
		const widget = new PalimpsestWidget({ tui: new ToggleTui(), host, policy, state, theme: idTheme });

		expect(widget.render(40)).toEqual(["a.ts:1"]);
	});

	it("off tier renders nothing when nothing is above the glow threshold", () => {
		const scheduler = manualScheduler();
		const policy = new MotionPolicy(fullEnv, "off");
		const host = new AnimationHost({ policy, scheduler });
		const state = new PalimpsestState();
		state.applySpans("a.ts", [{ start: 1, end: 1 }]); // a single touch: overlap count 1, below threshold
		const widget = new PalimpsestWidget({ tui: new ToggleTui(), host, policy, state, theme: idTheme });

		expect(widget.render(40)).toEqual([]);
	});

	it("renders the current ledger's visible rows at construction", () => {
		const scheduler = manualScheduler();
		const policy = new MotionPolicy(fullEnv, "full");
		const host = new AnimationHost({ policy, scheduler });
		const state = new PalimpsestState();
		state.applySpans("a.ts", [{ start: 3, end: 3 }]);
		state.applySpans("a.ts", [{ start: 3, end: 3 }]);
		const widget = new PalimpsestWidget({ tui: new ToggleTui(), host, policy, state, theme: idTheme });

		expect(widget.render(40)).toEqual(["a.ts:3"]);
		widget.dispose();
	});

	it("an accent override recolors only the ember tier, leaving underline/amber on their fixed tokens", () => {
		const scheduler = manualScheduler();
		const policy = new MotionPolicy(fullEnv, "full");
		const host = new AnimationHost({ policy, scheduler });
		const state = new PalimpsestState();
		state.applyDegradedTouch("a.ts");
		state.applyDegradedTouch("a.ts");
		state.applyDegradedTouch("a.ts");
		state.applyDegradedTouch("a.ts"); // overlapCount 4 -> ember
		const widget = new PalimpsestWidget({
			tui: new ToggleTui(),
			host,
			policy,
			state,
			theme: taggedTheme,
			accentColor: "accent",
		});
		expect(widget.render(40)).toEqual(["accent:B(a.ts)"]);
		widget.dispose();
	});
});

describe("PalimpsestController", () => {
	it("a single touch (overlap count 1) mounts nothing — no repeated edit, no signal", () => {
		const controller = new PalimpsestController();
		const { ctx, calls } = recordingContext();
		controller.onToolResult(editResult(hunkDiff(10, 12), { path: "a.ts" }), ctx);
		expect(calls).toHaveLength(0);
	});

	it("crosses the underline/amber/ember thresholds at 2/3/4 overlapping touches to the same span", () => {
		const scheduler = manualScheduler();
		const controller = new PalimpsestController({ scheduler });
		const { ctx, calls } = recordingContext();

		controller.onToolResult(editResult(hunkDiff(10, 12), { path: "a.ts" }), ctx); // overlap 1: still nothing
		expect(calls).toHaveLength(0);

		controller.onToolResult(editResult(hunkDiff(10, 12), { path: "a.ts" }), ctx); // overlap 2: mounts
		expect(calls).toHaveLength(1);
		const factory = calls[0].content as (tui: ToggleTui, theme: PalimpsestTheme) => PalimpsestWidget;
		const widget = factory(new ToggleTui(), taggedTheme);
		expect(widget.render(40)).toEqual(["dim:U(a.ts:10-12)"]);

		controller.onToolResult(editResult(hunkDiff(10, 12), { path: "a.ts" }), ctx); // overlap 3
		expect(calls).toHaveLength(1); // no remount — same animated mount re-renders
		widget.markDirty();
		expect(widget.render(40)).toEqual(["warning:a.ts:10-12"]);

		controller.onToolResult(editResult(hunkDiff(10, 12), { path: "a.ts" }), ctx); // overlap 4
		widget.markDirty();
		expect(widget.render(40)).toEqual(["error:B(a.ts:10-12)"]);
		widget.dispose();
	});

	it("a rename migrates the ledger to the new path, preserving the accumulated overlap count", () => {
		const controller = new PalimpsestController();
		const { ctx, calls } = recordingContext();

		controller.onToolResult(editResult(hunkDiff(1, 1), { path: "old.ts" }), ctx);
		controller.onToolResult(editResult(hunkDiff(1, 1), { path: "old.ts" }), ctx); // overlap 2, mounted
		expect(calls).toHaveLength(1);

		// A move-only edit: real diff, `sourcePath` set, landing at the new path.
		controller.onToolResult(editResult(hunkDiff(1, 1), { path: "new.ts", sourcePath: "old.ts" }), ctx);
		const rows = controller.state.snapshot().rows;
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ path: "new.ts", overlapCount: 3 });
	});

	it("op: delete clears the ledger entry and tears the widget all the way down", () => {
		const scheduler = manualScheduler();
		const controller = new PalimpsestController({ scheduler });
		const { ctx, calls } = recordingContext();

		controller.onToolResult(editResult(hunkDiff(1, 1), { path: "a.ts" }), ctx);
		controller.onToolResult(editResult(hunkDiff(1, 1), { path: "a.ts" }), ctx);
		expect(calls).toHaveLength(1);
		const factory = calls[0].content as (tui: ToggleTui, theme: PalimpsestTheme) => PalimpsestWidget;
		factory(new ToggleTui(), idTheme).render(40);
		expect(scheduler.running).toBe(true);

		controller.onToolResult(editResult("", { path: "a.ts", op: "delete" }), ctx);
		expect(controller.state.isEmpty).toBe(true);
		expect(calls[calls.length - 1].content).toBeUndefined(); // widget removed entirely
		expect(scheduler.running).toBe(false);
	});

	it("snapshotsPruned degrades the touch to path-level counting instead of guessing a span", () => {
		const controller = new PalimpsestController();
		const { ctx, calls } = recordingContext();

		controller.onToolResult(editResult(hunkDiff(1, 1), { path: "a.ts", snapshotsPruned: true }), ctx);
		controller.onToolResult(editResult(hunkDiff(50, 60), { path: "a.ts", snapshotsPruned: true }), ctx);
		expect(calls).toHaveLength(1);

		const rows = controller.state.snapshot().rows;
		expect(rows).toEqual([{ path: "a.ts", start: undefined, end: undefined, overlapCount: 2, lastTouchedTurn: 0 }]);
	});

	it("a real diff with no parseable hunk header also degrades to path-level counting rather than guessing", () => {
		const controller = new PalimpsestController();
		const { ctx } = recordingContext();

		// No `@@` header at all, but real +/- content, so getDiffStats sees a genuine change.
		controller.onToolResult(editResult("+added with no header", { path: "a.ts" }), ctx);
		controller.onToolResult(editResult("+added with no header", { path: "a.ts" }), ctx);
		const rows = controller.state.snapshot().rows;
		expect(rows).toEqual([{ path: "a.ts", start: undefined, end: undefined, overlapCount: 2, lastTouchedTurn: 0 }]);
	});

	it("a multi-file edit's perFileResults entry missing spans degrades only that file to path-level counting", () => {
		const controller = new PalimpsestController();
		const { ctx } = recordingContext();

		const multiTouch = () =>
			controller.onToolResult(
				editResult("", {
					perFileResults: [
						{ path: "precise.ts", diff: hunkDiff(1, 1) },
						{ path: "degraded.ts", diff: "+content but no hunk header" },
					],
				}),
				ctx,
			);
		multiTouch();
		multiTouch();

		const rows = controller.state.snapshot().rows;
		const precise = rows.find(r => r.path === "precise.ts");
		const degraded = rows.find(r => r.path === "degraded.ts");
		expect(precise).toMatchObject({ start: 1, end: 1, overlapCount: 2 });
		expect(degraded).toMatchObject({ start: undefined, end: undefined, overlapCount: 2 });
	});

	it("caps the rendered strip at 3 rows even with more files thrashing", () => {
		const controller = new PalimpsestController();
		const { ctx, calls } = recordingContext();

		for (const path of ["a.ts", "b.ts", "c.ts", "d.ts"]) {
			controller.onToolResult(editResult(hunkDiff(1, 1), { path }), ctx);
			controller.onToolResult(editResult(hunkDiff(1, 1), { path }), ctx);
		}
		const factory = calls[0].content as (tui: ToggleTui, theme: PalimpsestTheme) => PalimpsestWidget;
		const widget = factory(new ToggleTui(), idTheme);
		expect(widget.render(40)).toHaveLength(3);
		widget.dispose();
	});

	it(`unmounts entirely once every region has faded after ${FADE_AFTER_TURNS} turns without a re-touch`, () => {
		const scheduler = manualScheduler();
		const controller = new PalimpsestController({ scheduler });
		const { ctx, calls } = recordingContext();

		controller.onToolResult(editResult(hunkDiff(1, 1), { path: "a.ts" }), ctx);
		controller.onToolResult(editResult(hunkDiff(1, 1), { path: "a.ts" }), ctx);
		expect(calls).toHaveLength(1);
		const factory = calls[0].content as (tui: ToggleTui, theme: PalimpsestTheme) => PalimpsestWidget;
		factory(new ToggleTui(), idTheme).render(40);
		expect(scheduler.running).toBe(true);

		for (let turn = 1; turn < FADE_AFTER_TURNS; turn++) {
			controller.onTurnEnd(turnEnd(turn), ctx);
			expect(scheduler.running).toBe(true); // still visible
		}
		controller.onTurnEnd(turnEnd(FADE_AFTER_TURNS), ctx);
		expect(controller.state.isEmpty).toBe(true);
		expect(scheduler.running).toBe(false);
		expect(calls[calls.length - 1].content).toBeUndefined();

		// A fresh re-touch after the fade remounts cleanly.
		controller.onToolResult(editResult(hunkDiff(1, 1), { path: "a.ts" }), ctx);
		controller.onToolResult(editResult(hunkDiff(1, 1), { path: "a.ts" }), ctx);
		expect(typeof calls[calls.length - 1].content).toBe("function");
	});

	it("the off tier mounts nothing when nothing crosses the glow threshold", () => {
		const controller = new PalimpsestController();
		const { ctx, calls } = recordingContext({ motionSetting: "off" });

		controller.onToolResult(editResult(hunkDiff(1, 1), { path: "a.ts" }), ctx); // overlap 1
		expect(calls).toHaveLength(0);
	});

	it("the off tier mounts static content — the same rows/sort/cap as any other tier — once something is visible", () => {
		const controller = new PalimpsestController();
		const { ctx, calls } = recordingContext({ motionSetting: "off" });

		controller.onToolResult(editResult(hunkDiff(1, 1), { path: "a.ts" }), ctx); // overlap 1: still nothing
		controller.onToolResult(editResult(hunkDiff(1, 1), { path: "a.ts" }), ctx); // overlap 2: mounts
		expect(calls).toHaveLength(1);
		expect(Array.isArray(calls[0].content)).toBe(true); // plain content, not a widget factory
		expect(calls[0].content).toEqual(["a.ts:1"]);
	});

	it("the off tier's static content refreshes directly on every subsequent touch — there's no frame clock to pick it up on its own", () => {
		const controller = new PalimpsestController();
		const { ctx, calls } = recordingContext({ motionSetting: "off" });

		controller.onToolResult(editResult(hunkDiff(1, 1), { path: "a.ts" }), ctx);
		controller.onToolResult(editResult(hunkDiff(1, 1), { path: "a.ts" }), ctx); // overlap 2, mounts
		expect(calls).toHaveLength(1);

		controller.onToolResult(editResult(hunkDiff(1, 1), { path: "a.ts" }), ctx); // overlap 3
		expect(calls).toHaveLength(2); // re-pushed, not left stale at the overlap-2 content
		expect(calls[1].content).toEqual(["a.ts:1"]); // same row — only the (untagged) glow tier changed
	});

	it("the off tier tears all the way down (setWidget(undefined)) once every region has faded, same as the animated path", () => {
		const scheduler = manualScheduler();
		const controller = new PalimpsestController({ scheduler });
		const { ctx, calls } = recordingContext({ motionSetting: "off" });

		controller.onToolResult(editResult(hunkDiff(1, 1), { path: "a.ts" }), ctx);
		controller.onToolResult(editResult(hunkDiff(1, 1), { path: "a.ts" }), ctx);
		expect(calls).toHaveLength(1);

		for (let turn = 1; turn <= FADE_AFTER_TURNS; turn++) controller.onTurnEnd(turnEnd(turn), ctx);
		expect(controller.state.isEmpty).toBe(true);
		expect(calls[calls.length - 1].content).toBeUndefined();
	});

	it("ignores non-edit tool results and results with no details", () => {
		const controller = new PalimpsestController();
		const { ctx, calls } = recordingContext();

		controller.onToolResult(
			{
				type: "tool_result",
				toolName: "bash",
				toolCallId: "c1",
				input: {},
				content: [],
				isError: false,
				details: undefined,
			},
			ctx,
		);
		controller.onToolResult(
			{
				type: "tool_result",
				toolName: "edit",
				toolCallId: "c1",
				input: {},
				content: [],
				isError: true,
				details: undefined,
			},
			ctx,
		);
		expect(calls).toHaveLength(0);
	});

	it("stays dormant when there is no UI surface, for both tool_result and turn_end", () => {
		const controller = new PalimpsestController();
		const { ctx, calls } = recordingContext({ hasUI: false });

		controller.onToolResult(editResult(hunkDiff(1, 1), { path: "a.ts" }), ctx);
		controller.onTurnEnd(turnEnd(1), ctx);
		expect(calls).toHaveLength(0);
		expect(controller.state.isEmpty).toBe(true);
	});

	it("dispose() is idempotent and a safe no-op with no prior mount", () => {
		const controller = new PalimpsestController();
		const { ctx, calls } = recordingContext();
		expect(() => controller.dispose(ctx)).not.toThrow();

		controller.onToolResult(editResult(hunkDiff(1, 1), { path: "a.ts" }), ctx);
		controller.onToolResult(editResult(hunkDiff(1, 1), { path: "a.ts" }), ctx);
		controller.dispose(ctx);
		const callsAfterFirstDispose = calls.length;
		controller.dispose(ctx);
		expect(calls).toHaveLength(callsAfterFirstDispose);
		expect(calls).not.toHaveLength(0);
	});
});
