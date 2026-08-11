import { describe, expect, it } from "bun:test";
import type { ToolCallEvent } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { visibleWidth } from "@oh-my-pi/pi-tui";
import { resolveStarGlyphRamp } from "../src/glyph-presets";
import { AnimationHost, type FrameScheduler, MotionPolicy } from "../src/kit";
import { categorizeTool, categoryIcon } from "../src/tool-constellation/categories";
import { type ToolConstellationContext, ToolConstellationController } from "../src/tool-constellation/controller";
import {
	assignCell,
	cometGlyph,
	emptyGlyph,
	GRID_CELLS,
	GRID_COLS,
	hashCell,
	isTwinkling,
	starBrightness,
	starGlyph,
} from "../src/tool-constellation/sky";
import { ConstellationState } from "../src/tool-constellation/state";
import {
	type ConstellationTheme,
	renderConstellationGrid,
	renderConstellationTally,
	ToolConstellationWidget,
} from "../src/tool-constellation/widget";

// Identity theme so assertions see plain text instead of ANSI escapes.
const idTheme: ConstellationTheme = { fg: (_color, text) => text };

// Unicode-tier glyphs, resolved once — every renderer call below defaults to `"unicode"`.
const STAR_GLYPHS = resolveStarGlyphRamp("unicode");
const CATEGORY_ICON = categoryIcon("unicode");

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

/** Mutable fake `tui` for backpressure tests: `renderUnderPressure` can be flipped live. */
class PressureTui {
	renderUnderPressure = false;
	requestComponentRender(): void {}
}
const fullEnv = { hasUI: true, isTTY: true, env: {} as Record<string, string | undefined> };

function toolCallEvent(toolName: string, toolCallId = "1"): ToolCallEvent {
	return { type: "tool_call", toolCallId, toolName, input: {} } as ToolCallEvent;
}

describe("tool constellation glyphs (preset-aware)", () => {
	it("categoryIcon/starGlyph/cometGlyph/emptyGlyph default to unicode; ambiguous-presentation glyphs carry VS15", () => {
		expect(categoryIcon()).toEqual({
			read: "⛏\uFE0E",
			write: "✎\uFE0E",
			bash: "↯",
			search: "◈",
			agent: "◆",
			mcp: "⬡",
			other: "∘",
		});
		expect(starGlyph(0)).toBe("·");
		expect(starGlyph(1)).toBe("✹\uFE0E");
		expect(cometGlyph()).toBe("☄\uFE0E");
		expect(emptyGlyph()).toBe("·");
	});

	it("ascii substitutes are exact one-column values", () => {
		expect(categoryIcon("ascii")).toEqual({
			read: "^",
			write: "/",
			bash: "!",
			search: "<",
			agent: "#",
			mcp: "o",
			other: ".",
		});
		expect(starGlyph(0, "ascii")).toBe(".");
		expect(starGlyph(1, "ascii")).toBe("#");
		expect(cometGlyph("ascii")).toBe("@");
		expect(emptyGlyph("ascii")).toBe(".");
		for (const glyph of [...Object.values(categoryIcon("ascii")), cometGlyph("ascii"), emptyGlyph("ascii")]) {
			expect(glyph).toHaveLength(1);
			expect(glyph.charCodeAt(0)).toBeLessThan(128);
		}
	});

	it("every category icon is distinct from every other in ascii too", () => {
		const icons = Object.values(categoryIcon("ascii"));
		expect(new Set(icons).size).toBe(icons.length);
	});

	it("nerd aliases unicode exactly", () => {
		expect(categoryIcon("nerd")).toEqual(categoryIcon("unicode"));
		expect(starGlyph(0.5, "nerd")).toBe(starGlyph(0.5, "unicode"));
		expect(cometGlyph("nerd")).toBe(cometGlyph("unicode"));
		expect(emptyGlyph("nerd")).toBe(emptyGlyph("unicode"));
	});
});

describe("tool constellation category classification", () => {
	it("maps builtin tool names, legacy aliases, and mcp bridge names to the bead's palette buckets", () => {
		expect(categorizeTool("read")).toBe("read");
		expect(categorizeTool("edit")).toBe("write");
		expect(categorizeTool("write")).toBe("write");
		expect(categorizeTool("bash")).toBe("bash");
		expect(categorizeTool("grep")).toBe("search");
		expect(categorizeTool("glob")).toBe("search");
		expect(categorizeTool("search")).toBe("search"); // legacy alias -> grep
		expect(categorizeTool("find")).toBe("search"); // legacy alias -> glob
		expect(categorizeTool("task")).toBe("agent");
		expect(categorizeTool("mcp__puppeteer_screenshot")).toBe("mcp");
		expect(categorizeTool("some_custom_tool")).toBe("other");
	});

	it("gives every category a distinct static-tally icon", () => {
		const icons = Object.values(CATEGORY_ICON);
		expect(new Set(icons).size).toBe(icons.length);
	});
});

describe("tool constellation grid math", () => {
	it("hashCell is a deterministic pure function of the tool name", () => {
		expect(hashCell("bash")).toBe(hashCell("bash"));
		expect(hashCell("bash", GRID_CELLS)).toBeGreaterThanOrEqual(0);
		expect(hashCell("bash", GRID_CELLS)).toBeLessThan(GRID_CELLS);
	});

	it("assignCell linear-probes past occupied cells to the next free one, deterministically", () => {
		const hash = hashCell("bash", 4);
		const occupied = new Set([hash]);
		const assigned = assignCell("bash", occupied, 4);
		expect(assigned).not.toBe(hash);
		expect(occupied.has(assigned)).toBe(false);
		// Re-running with the same occupancy set yields the same probe result.
		expect(assignCell("bash", occupied, 4)).toBe(assigned);
	});

	it("assignCell returns the raw hash slot immediately when it is free", () => {
		const assigned = assignCell("read", new Set(), GRID_CELLS);
		expect(assigned).toBe(hashCell("read", GRID_CELLS));
	});

	it("starBrightness decays monotonically with elapsed and a fresh fire resets to max", () => {
		expect(starBrightness(0)).toBe(1);
		expect(starBrightness(260)).toBe(1); // still within the flare hold window
		const samples = [260, 500, 1000, 2000, 5000, Number.POSITIVE_INFINITY].map(starBrightness);
		for (let i = 1; i < samples.length; i++) {
			expect(samples[i]).toBeLessThanOrEqual(samples[i - 1]);
		}
		expect(starBrightness(Number.POSITIVE_INFINITY)).toBeCloseTo(0.12, 5); // settles at the floor, never fired
		expect(starBrightness(0)).toBeGreaterThan(starBrightness(5000)); // fresh fire is brighter than a stale one
	});

	it("starGlyph is monotonic non-decreasing along the brightness ramp", () => {
		const glyphIndices = [0, 0.2, 0.4, 0.6, 0.8, 1].map(b =>
			STAR_GLYPHS.indexOf(starGlyph(b) as (typeof STAR_GLYPHS)[number]),
		);
		const sorted = [...glyphIndices].sort((a, b) => a - b);
		expect(glyphIndices).toEqual(sorted);
		expect(starGlyph(0)).toBe(STAR_GLYPHS[0]);
		expect(starGlyph(1)).toBe(STAR_GLYPHS[STAR_GLYPHS.length - 1]);
	});

	it("isTwinkling fires a short periodic blip per cell, offset by cell index", () => {
		expect(isTwinkling(0, 0)).toBe(true);
		expect(isTwinkling(0, 139)).toBe(true);
		expect(isTwinkling(0, 200)).toBe(false);
		// Cell 1 is phase-shifted: at a moment cell 0 is mid-blip, cell 1 already is not.
		expect(isTwinkling(0, 138)).toBe(true);
		expect(isTwinkling(1, 138)).toBe(false);
	});
});

describe("tool constellation grid rendering (pure)", () => {
	it("is byte-stable across repeated calls with the same snapshot and elapsed time", () => {
		const snapshot = {
			stars: [
				{ toolName: "bash", category: "bash" as const, cell: 2, lastFireAt: 1000, fireCount: 3 },
				{ toolName: "read", category: "read" as const, cell: 5, lastFireAt: 1000, fireCount: 1 },
			],
			lastFired: "read",
			previousFired: "bash",
		};
		const first = renderConstellationGrid(snapshot, 1600, idTheme, "full");
		const second = renderConstellationGrid(snapshot, 1600, idTheme, "full");
		expect(first).toEqual(second);
		expect(first).toHaveLength(3); // GRID_ROWS
	});

	it("renders the newest fired star as a comet head within the comet window", () => {
		const snapshot = {
			stars: [{ toolName: "bash", category: "bash" as const, cell: 0, lastFireAt: 1000, fireCount: 1 }],
			lastFired: "bash",
			previousFired: undefined,
		};
		const rows = renderConstellationGrid(snapshot, 1200, idTheme, "full"); // 200ms since fire, inside the 500ms comet window
		expect(rows[0]?.startsWith("☄")).toBe(true);
	});

	it("threads a live preset into the comet and empty-cell glyphs — not just the default", () => {
		const snapshot = {
			stars: [{ toolName: "bash", category: "bash" as const, cell: 0, lastFireAt: 1000, fireCount: 1 }],
			lastFired: "bash",
			previousFired: undefined,
		};
		const rows = renderConstellationGrid(snapshot, 1200, idTheme, "full", "ascii");
		expect(rows[0]?.startsWith(cometGlyph("ascii"))).toBe(true);
		expect(rows.join("")).toContain(emptyGlyph("ascii"));
		expect(rows.join("")).not.toContain(cometGlyph("unicode"));
	});

	it("terminal-width safety: every grid row has equal visibleWidth, including a comet frame (regression guard for AESTHETIC-01)", () => {
		const snapshot = {
			stars: [
				{ toolName: "bash", category: "bash" as const, cell: 0, lastFireAt: 1000, fireCount: 1 }, // comet head
				{ toolName: "read", category: "read" as const, cell: 5, lastFireAt: 900, fireCount: 1 }, // flare-ramp star
			],
			lastFired: "bash",
			previousFired: "read",
		};
		const rows = renderConstellationGrid(snapshot, 1200, idTheme, "full"); // 200ms since bash fired: within the comet window
		expect(rows).toHaveLength(3);
		const widths = rows.map(row => visibleWidth(row));
		expect(widths.every(w => w === widths[0])).toBe(true);
		// GRID_COLS glyphs, one visible column apart (" " separator), no glyph in this ramp is wide.
		expect(widths[0]).toBe(GRID_COLS * 2 - 1);
	});

	it("renders a non-comet recently-fired star at the top of the flare ramp", () => {
		const snapshot = {
			stars: [
				{ toolName: "bash", category: "bash" as const, cell: 0, lastFireAt: 1000, fireCount: 1 },
				{ toolName: "read", category: "read" as const, cell: 1, lastFireAt: 1000, fireCount: 1 },
			],
			lastFired: "read", // bash is the *other* star, not the comet head
			previousFired: undefined,
		};
		const rows = renderConstellationGrid(snapshot, 1200, idTheme, "full");
		expect(rows[0]?.startsWith(STAR_GLYPHS[STAR_GLYPHS.length - 1])).toBe(true);
	});

	it("decays a long-idle star down to the dim background glyph", () => {
		const snapshot = {
			stars: [{ toolName: "bash", category: "bash" as const, cell: 0, lastFireAt: 0, fireCount: 1 }],
			lastFired: "bash",
			previousFired: undefined,
		};
		const rows = renderConstellationGrid(snapshot, 500_000, idTheme, "full");
		expect(rows[0]?.startsWith(STAR_GLYPHS[0])).toBe(true);
	});

	it("draws a ley-line only between the last two distinct fired stars sharing a grid row", () => {
		const sameRow = renderConstellationGrid(
			{
				stars: [
					{ toolName: "a", category: "read" as const, cell: 2, lastFireAt: 0, fireCount: 1 },
					{ toolName: "b", category: "bash" as const, cell: 5, lastFireAt: 0, fireCount: 1 },
				],
				lastFired: "b",
				previousFired: "a",
			},
			600, // past the comet window so glyph choice doesn't obscure the connector cells
			idTheme,
			"full",
		);
		expect(sameRow[0]).toContain("─");

		const differentRow = renderConstellationGrid(
			{
				stars: [
					{ toolName: "a", category: "read" as const, cell: 2, lastFireAt: 0, fireCount: 1 },
					{ toolName: "b", category: "bash" as const, cell: 15, lastFireAt: 0, fireCount: 1 },
				],
				lastFired: "b",
				previousFired: "a",
			},
			600,
			idTheme,
			"full",
		);
		expect(differentRow.join("")).not.toContain("─");
	});

	it("subtle tier renders binary brighten-on-fire dots with no comet, twinkle, or ley-line", () => {
		const rows = renderConstellationGrid(
			{
				stars: [
					{ toolName: "a", category: "read" as const, cell: 2, lastFireAt: 0, fireCount: 1 },
					{ toolName: "b", category: "bash" as const, cell: 5, lastFireAt: 0, fireCount: 1 },
				],
				lastFired: "b",
				previousFired: "a",
			},
			0,
			idTheme,
			"subtle",
		);
		expect(rows.join("")).not.toContain("☄");
		expect(rows.join("")).not.toContain("─");
	});
});

describe("tool constellation static tally", () => {
	it("formats one segment per category with a nonzero count, in a fixed order", () => {
		const counts = new Map([
			["bash" as const, 3],
			["read" as const, 12],
		]);
		const line = renderConstellationTally(counts, idTheme);
		expect(line).toBe(`${CATEGORY_ICON.read} 12 · ${CATEGORY_ICON.bash} 3`);
	});

	it("falls back to a placeholder when nothing has fired yet", () => {
		expect(renderConstellationTally(new Map(), idTheme)).toContain("no tool activity");
	});

	it("threads a live preset into every category icon — not just the default", () => {
		const counts = new Map([
			["bash" as const, 3],
			["read" as const, 12],
		]);
		const line = renderConstellationTally(counts, idTheme, "ascii");
		const icons = categoryIcon("ascii");
		expect(line).toBe(`${icons.read} 12 · ${icons.bash} 3`);
		expect(line).not.toContain(CATEGORY_ICON.read);
	});
});

describe("tool constellation widget lifecycle", () => {
	it("subscribes on mount, reflects the shared clock, and leaves no subscription on dispose", () => {
		const scheduler = manualScheduler();
		const policy = new MotionPolicy(fullEnv, "full");
		const host = new AnimationHost({ policy, scheduler });
		const state = new ConstellationState();
		state.recordFire("bash", scheduler.now());
		const widget = new ToolConstellationWidget({
			tui: noopTui,
			host,
			policy,
			state,
			theme: idTheme,
			clock: scheduler,
		});

		expect(host.subscriberCount).toBe(1);
		expect(widget.animating).toBe(true);
		expect(host.running).toBe(true);

		const initial = widget.render(80);
		scheduler.advance(5000); // well past the flare/comet window
		const decayed = widget.render(80);
		expect(decayed).not.toEqual(initial); // frame clock drove the decay

		widget.dispose();
		expect(host.subscriberCount).toBe(0);
		expect(host.running).toBe(false);
		expect(scheduler.running).toBe(false);
	});

	it("off tier renders one static frame and never subscribes", () => {
		const scheduler = manualScheduler();
		const policy = new MotionPolicy(fullEnv, "off");
		const host = new AnimationHost({ policy, scheduler });
		const state = new ConstellationState();
		state.recordFire("bash", scheduler.now());
		const widget = new ToolConstellationWidget({
			tui: noopTui,
			host,
			policy,
			state,
			theme: idTheme,
			clock: scheduler,
		});

		expect(widget.animating).toBe(false);
		expect(host.subscriberCount).toBe(0);
		// off tier resolves through the widget's subtle branch: a bright dot, never a comet/ley-line.
		expect(widget.render(80).join("")).toContain("•");
		expect(widget.render(80).join("")).not.toContain("☄");
	});
});

describe("tool constellation frame-content memo (PERF-03)", () => {
	it("returns the exact same rows array back-to-back when nothing about the frame changed", () => {
		const scheduler = manualScheduler();
		const policy = new MotionPolicy(fullEnv, "full");
		const host = new AnimationHost({ policy, scheduler });
		const state = new ConstellationState();
		state.recordFire("bash", scheduler.now());
		const widget = new ToolConstellationWidget({
			tui: noopTui,
			host,
			policy,
			state,
			theme: idTheme,
			clock: scheduler,
		});

		// Calling renderFrame directly (bypassing AnimatedWidget.render's width cache) exercises the
		// memo itself: with no fire and no clock advance in between, a second call must be a cache hit.
		const first = widget.renderFrame(80);
		const second = widget.renderFrame(80);
		expect(second).toBe(first); // reference equality: proves the memo short-circuited, not just equal content

		widget.dispose();
	});

	it("keeps re-rendering across a twinkle period with no new fires, proving the twinkle bucket is in the memo key", () => {
		const scheduler = manualScheduler();
		const policy = new MotionPolicy(fullEnv, "full");
		const host = new AnimationHost({ policy, scheduler });
		const state = new ConstellationState();
		state.recordFire("bash", 0);
		const cell = state.snapshot().stars[0]?.cell ?? 0;
		const widget = new ToolConstellationWidget({
			tui: noopTui,
			host,
			policy,
			state,
			theme: idTheme,
			clock: scheduler,
		});

		// Past the comet/flare window so the only remaining source of change is this cell's twinkle blip.
		let quietAt = 5000;
		while (isTwinkling(cell, quietAt)) quietAt++;
		scheduler.advance(quietAt);
		const settled = widget.renderFrame(80);

		let twinkleAt = quietAt + 1;
		while (!isTwinkling(cell, twinkleAt)) twinkleAt++;
		scheduler.advance(twinkleAt - quietAt);
		const twinkling = widget.renderFrame(80);
		expect(twinkling).not.toEqual(settled); // the memo did not freeze mid-twinkle

		let quietAgainAt = twinkleAt + 1;
		while (isTwinkling(cell, quietAgainAt)) quietAgainAt++;
		scheduler.advance(quietAgainAt - twinkleAt);
		const afterBlip = widget.renderFrame(80);
		expect(afterBlip).toEqual(settled); // and reverts once the blip ends, round-tripping cleanly

		widget.dispose();
	});
});

describe("tool constellation edge cases", () => {
	it("shares a cell without crashing once distinct tool names exceed the grid capacity", () => {
		const state = new ConstellationState();
		// GRID_CELLS names always land on free cells; the (GRID_CELLS + 1)th must share.
		for (let i = 0; i <= GRID_CELLS; i++) {
			state.recordFire(`tool-${i}`, i * 10);
		}
		const snapshot = state.snapshot();
		expect(snapshot.stars).toHaveLength(GRID_CELLS + 1);
		const cells = snapshot.stars.map(s => s.cell);
		const distinctCells = new Set(cells);
		expect(distinctCells.size).toBeLessThanOrEqual(GRID_CELLS); // at least one collision forced
		// Rendering a saturated field must not throw, and stays exactly 3 rows.
		const rows = renderConstellationGrid(snapshot, GRID_CELLS * 10, idTheme, "full");
		expect(rows).toHaveLength(3);
	});

	it("hashCell and categorizeTool tolerate an empty tool name without throwing", () => {
		expect(() => hashCell("")).not.toThrow();
		expect(hashCell("")).toBeGreaterThanOrEqual(0);
		expect(hashCell("")).toBeLessThan(GRID_CELLS);
		expect(categorizeTool("")).toBe("other");
	});

	it("starBrightness treats a negative msSinceFire (clock skew) as still within the flare hold", () => {
		expect(starBrightness(-50)).toBe(1);
	});

	it("renderConstellationGrid on a never-fired empty snapshot draws an all-dim field with no comet/ley-line", () => {
		const rows = renderConstellationGrid(
			{ stars: [], lastFired: undefined, previousFired: undefined },
			0,
			idTheme,
			"full",
		);
		expect(rows).toHaveLength(3);
		expect(rows.join("")).not.toContain("☄");
		expect(rows.join("")).not.toContain("─");
	});

	it("controller dispose is idempotent: a second call is a no-op, not a double clear", () => {
		const scheduler = manualScheduler();
		const controller = new ToolConstellationController({ scheduler });
		const calls: Array<{ key: string; content: unknown }> = [];
		const ctx: ToolConstellationContext = {
			hasUI: true,
			isTTY: true,
			env: {},
			motionSetting: "full",
			theme: idTheme,
			glyphPreset: "unicode",
			setWidget: (key, content) => calls.push({ key, content }),
		};
		controller.onToolCall(toolCallEvent("bash"), ctx);
		controller.dispose(ctx);
		const callsAfterFirstDispose = calls.length;
		controller.dispose(ctx); // must not throw, and must not emit another setWidget clear
		expect(calls).toHaveLength(callsAfterFirstDispose);
	});
});

describe("tool constellation controller", () => {
	function recordingContext(
		_scheduler: FrameScheduler,
		overrides: Partial<ToolConstellationContext> = {},
	): { ctx: ToolConstellationContext; calls: Array<{ key: string; content: unknown }> } {
		const calls: Array<{ key: string; content: unknown }> = [];
		const ctx: ToolConstellationContext = {
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

	it("mounts an animated widget on the first tool_call and mutates state in place afterward", () => {
		const scheduler = manualScheduler();
		const controller = new ToolConstellationController({ scheduler });
		const { ctx, calls } = recordingContext(scheduler);

		controller.onToolCall(toolCallEvent("bash"), ctx);
		expect(calls).toHaveLength(1);
		expect(typeof calls[0].content).toBe("function");

		const factory = calls[0].content as (tui: typeof noopTui, theme: ConstellationTheme) => ToolConstellationWidget;
		const widget = factory(noopTui, idTheme);
		expect(widget.animating).toBe(true);
		expect(scheduler.running).toBe(true);

		controller.onToolCall(toolCallEvent("read"), ctx);
		expect(calls).toHaveLength(1); // no remount; the widget's own frame clock picks up the mutated state
		expect(controller.state.categoryCounts().get("bash")).toBe(1);
		expect(controller.state.categoryCounts().get("read")).toBe(1);
	});

	it("renders and updates a static tally for the off tier with zero frame-clock subscriptions", () => {
		const scheduler = manualScheduler();
		const controller = new ToolConstellationController({ scheduler });
		const { ctx, calls } = recordingContext(scheduler, { motionSetting: "off" });

		controller.onToolCall(toolCallEvent("bash"), ctx);
		expect(Array.isArray(calls[0].content)).toBe(true);
		expect((calls[0].content as string[])[0]).toContain(CATEGORY_ICON.bash);
		expect(scheduler.running).toBe(false); // static tier never starts the shared frame clock

		controller.onToolCall(toolCallEvent("bash"), ctx);
		expect((calls[1].content as string[])[0]).toContain("2"); // second fire bumps the tally in place
	});

	it("falls back to a static line outside a TTY even when animations are on", () => {
		const scheduler = manualScheduler();
		const controller = new ToolConstellationController({ scheduler });
		const { ctx, calls } = recordingContext(scheduler, { isTTY: false, motionSetting: "full" });

		controller.onToolCall(toolCallEvent("bash"), ctx);
		expect(Array.isArray(calls[0].content)).toBe(true);
	});

	it("stays dormant when there is no UI surface", () => {
		const scheduler = manualScheduler();
		const controller = new ToolConstellationController({ scheduler });
		const { ctx, calls } = recordingContext(scheduler, { hasUI: false });

		controller.onToolCall(toolCallEvent("bash"), ctx);
		expect(calls).toHaveLength(0);
	});

	it("wires host-level backpressure into the mounted widget: frame emission is skipped while the tui reports render pressure", () => {
		const scheduler = manualScheduler();
		const controller = new ToolConstellationController({ scheduler });
		const { ctx, calls } = recordingContext(scheduler);

		controller.onToolCall(toolCallEvent("bash"), ctx);
		const factory = calls[0].content as (tui: PressureTui, theme: ConstellationTheme) => ToolConstellationWidget;
		const tui = new PressureTui();
		const widget = factory(tui, idTheme);
		expect(widget.animating).toBe(true);

		scheduler.advance(16);
		const elapsedBeforePressure = widget.elapsedMs;

		tui.renderUnderPressure = true;
		scheduler.advance(16);
		scheduler.advance(16);
		expect(widget.elapsedMs).toBe(elapsedBeforePressure);
		expect(widget.animating).toBe(true);

		tui.renderUnderPressure = false;
		scheduler.advance(16);
		expect(widget.elapsedMs).toBeGreaterThan(elapsedBeforePressure);
		widget.dispose();
	});

	it("dispose tears down the animated host with no leaked subscription or timer", () => {
		const scheduler = manualScheduler();
		const controller = new ToolConstellationController({ scheduler });
		const { ctx, calls } = recordingContext(scheduler);

		controller.onToolCall(toolCallEvent("bash"), ctx);
		const factory = calls[0].content as (tui: typeof noopTui, theme: ConstellationTheme) => ToolConstellationWidget;
		factory(noopTui, idTheme);
		expect(scheduler.running).toBe(true);

		controller.dispose(ctx);
		expect(calls[calls.length - 1].content).toBeUndefined();
		expect(scheduler.running).toBe(false);
	});
});
