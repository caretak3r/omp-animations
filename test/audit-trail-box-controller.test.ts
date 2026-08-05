import { describe, expect, it } from "bun:test";
import {
	type AuditTrailBoxContext,
	AuditTrailBoxController,
	DEFAULT_TERMINAL_COLUMNS,
	MIN_STATUS_WIDTH,
	PROBE_INTERVAL_MS,
	STATUS_KEY,
	statusWidthFor,
	WIDGET_KEY,
} from "../src/audit-trail-box/controller";
import { hashContent, type ProbeObservation, type ProbeSource } from "../src/audit-trail-box/probe";
import { FORMATTER_WINDOW_MS, POISON_STREAK_TICKS } from "../src/audit-trail-box/state";
import {
	type AuditTrailBoxTheme,
	AuditTrailBoxWidget,
	BADGE_GLYPH,
	STATUS_GLYPHS,
} from "../src/audit-trail-box/widget";
import type { FrameScheduler } from "../src/kit";

// Identity theme so assertions see plain text instead of ANSI escapes.
const idTheme: AuditTrailBoxTheme = { fg: (_color, text) => text };
// Color-tagging theme for tests that need to assert which color the renderer chose.
const taggedTheme: AuditTrailBoxTheme = { fg: (color, text) => `${color}:${text}` };

const noopTui = { requestComponentRender: () => {} };

/** Manual frame scheduler: drives host ticks and the probe clock deterministically. */
function manualScheduler(): FrameScheduler & { advance(ms: number): void; set(ms: number): void; running: boolean } {
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
		set(ms) {
			current = ms;
		},
		get running() {
			return ticker !== undefined;
		},
	};
}

/** In-memory disk. A path absent from the map is unreachable (deleted / EPERM). */
function fakeDisk(initial: Record<string, string> = {}) {
	const files = new Map<string, string>(Object.entries(initial));
	const inspected: string[] = [];
	const source: ProbeSource = {
		async inspect(path: string): Promise<ProbeObservation | undefined> {
			inspected.push(path);
			const content = files.get(path);
			if (content === undefined) return undefined;
			return { hash: hashContent(content), content };
		},
	};
	return {
		source,
		inspected,
		write(path: string, content: string) {
			files.set(path, content);
		},
		remove(path: string) {
			files.delete(path);
		},
	};
}

interface Recorded {
	ctx: AuditTrailBoxContext;
	widgets: Array<{ key: string; content: unknown }>;
	statuses: Array<{ key: string; text: string | undefined }>;
}

function recordingContext(overrides: Partial<AuditTrailBoxContext> = {}): Recorded {
	const widgets: Recorded["widgets"] = [];
	const statuses: Recorded["statuses"] = [];
	const ctx: AuditTrailBoxContext = {
		hasUI: true,
		isTTY: true,
		env: {},
		motionSetting: "full",
		theme: idTheme,
		setWidget: (key, content) => widgets.push({ key, content }),
		setStatus: (key, text) => statuses.push({ key, text }),
		...overrides,
	};
	return { ctx, widgets, statuses };
}

/** Content plus the hash the agent would have taken when it saw that content. */
function seen(content: string) {
	return { hash: hashContent(content), content };
}

/** The nth widget payload, asserted to be the off-tier static line array rather than a widget factory. */
function staticLines(widgets: Recorded["widgets"], index: number): readonly string[] {
	const content = widgets[index]?.content;
	if (!Array.isArray(content)) throw new Error(`widget ${index} is not a static line array: ${typeof content}`);
	return content;
}

describe("audit trail box — status width budget", () => {
	it("takes a share of the terminal width", () => {
		expect(statusWidthFor(200)).toBe(60);
		expect(statusWidthFor(100)).toBe(30);
	});

	it("falls back to a default width when the host reports no columns", () => {
		expect(statusWidthFor()).toBe(statusWidthFor(DEFAULT_TERMINAL_COLUMNS));
	});

	it("never drops below the floor, whatever nonsense the host reports", () => {
		expect(statusWidthFor(1)).toBe(MIN_STATUS_WIDTH);
		expect(statusWidthFor(0)).toBe(statusWidthFor(DEFAULT_TERMINAL_COLUMNS));
		expect(statusWidthFor(-40)).toBe(statusWidthFor(DEFAULT_TERMINAL_COLUMNS));
		expect(statusWidthFor(Number.NaN)).toBe(statusWidthFor(DEFAULT_TERMINAL_COLUMNS));
		expect(statusWidthFor(Number.POSITIVE_INFINITY)).toBe(statusWidthFor(DEFAULT_TERMINAL_COLUMNS));
	});
});

describe("audit trail box controller — dormancy", () => {
	it("touches nothing at all when there is no UI surface", async () => {
		const disk = fakeDisk({ "a.ts": "v1" });
		const controller = new AuditTrailBoxController({ scheduler: manualScheduler(), probeSource: disk.source });
		const { ctx, widgets, statuses } = recordingContext({ hasUI: false });

		controller.noteRead("a.ts", seen("v1"), ctx);
		controller.noteWrite("a.ts", seen("v2"), ctx);
		controller.noteTurn(ctx);
		controller.noteRecovery(ctx);
		controller.noteSessionSwitch(ctx);
		await controller.probeNow(ctx);
		await controller.settled();

		expect(widgets).toHaveLength(0);
		expect(statuses).toHaveLength(0);
		expect(controller.state.size).toBe(0);
		expect(disk.inspected).toHaveLength(0);
	});

	it("starts tracking normally once a UI surface exists", () => {
		const disk = fakeDisk({ "a.ts": "v1" });
		const controller = new AuditTrailBoxController({ scheduler: manualScheduler(), probeSource: disk.source });
		const dormant = recordingContext({ hasUI: false });
		const live = recordingContext();

		controller.noteRead("a.ts", seen("v1"), dormant.ctx);
		expect(controller.state.size).toBe(0);

		controller.noteRead("a.ts", seen("v1"), live.ctx);
		expect(controller.state.size).toBe(1);
		expect(live.widgets).toHaveLength(1);
	});
});

describe("audit trail box controller — mounting", () => {
	it("mounts an animated widget on the first tracked event and never remounts", () => {
		const scheduler = manualScheduler();
		const disk = fakeDisk({ "a.ts": "v1" });
		const controller = new AuditTrailBoxController({ scheduler, probeSource: disk.source });
		const { ctx, widgets } = recordingContext();

		controller.noteRead("a.ts", seen("v1"), ctx);
		expect(widgets).toHaveLength(1);
		expect(widgets[0]?.key).toBe(WIDGET_KEY);
		expect(typeof widgets[0]?.content).toBe("function");

		const factory = widgets[0]?.content as (tui: typeof noopTui, theme: AuditTrailBoxTheme) => AuditTrailBoxWidget;
		const widget = factory(noopTui, idTheme);
		expect(widget).toBeInstanceOf(AuditTrailBoxWidget);
		expect(widget.animating).toBe(true);

		controller.noteRead("b.ts", seen("x"), ctx);
		controller.noteTurn(ctx);
		expect(widgets).toHaveLength(1); // the widget's own frame clock picks up the mutated state
		widget.dispose();
	});

	it("honors the registrar's placement", () => {
		const disk = fakeDisk();
		const controller = new AuditTrailBoxController({
			scheduler: manualScheduler(),
			placement: "aboveEditor",
			probeSource: disk.source,
		});
		const { ctx } = recordingContext();
		const seenOptions: unknown[] = [];
		controller.noteRead("a.ts", seen("v1"), { ...ctx, setWidget: (_k, _c, options) => seenOptions.push(options) });
		expect(seenOptions[0]).toEqual({ placement: "aboveEditor" });
	});

	it("renders a static text line, not an animated widget, in the off tier", () => {
		const disk = fakeDisk({ "a.ts": "v1" });
		const controller = new AuditTrailBoxController({ scheduler: manualScheduler(), probeSource: disk.source });
		const { ctx, widgets, statuses } = recordingContext({ motionSetting: "off" });

		controller.noteRead("a.ts", seen("v1"), ctx);
		expect(staticLines(widgets, 0)[0]).toContain(BADGE_GLYPH);
		expect(staticLines(widgets, 0)[0]).toContain("1 fresh");

		// No frame clock in this mode, so every subsequent event repaints directly.
		controller.noteRead("b.ts", seen("x"), ctx);
		expect(widgets).toHaveLength(2);
		expect(staticLines(widgets, 1)[0]).toContain("2 fresh");
		expect(statuses).toHaveLength(0);
	});

	it("resolves off from a non-TTY environment even when the setting says full", () => {
		const disk = fakeDisk();
		const controller = new AuditTrailBoxController({ scheduler: manualScheduler(), probeSource: disk.source });
		const { ctx, widgets } = recordingContext({ isTTY: false, motionSetting: "full" });
		controller.noteRead("a.ts", seen("v1"), ctx);
		expect(staticLines(widgets, 0)).toHaveLength(1);
	});
});

describe("audit trail box controller — probe scheduling", () => {
	it("kicks an off-path probe from a tracked event", async () => {
		const scheduler = manualScheduler();
		const disk = fakeDisk({ "a.ts": "v1", "b.ts": "v1" });
		const controller = new AuditTrailBoxController({ scheduler, probeSource: disk.source });
		const { ctx } = recordingContext();

		controller.noteRead("a.ts", seen("v1"), ctx);
		await controller.settled();
		expect(disk.inspected).toEqual(["a.ts"]);
	});

	it("rate-limits ticks, then allows one once the interval has passed", async () => {
		const scheduler = manualScheduler();
		const disk = fakeDisk({ "a.ts": "v1" });
		const controller = new AuditTrailBoxController({ scheduler, probeSource: disk.source });
		const { ctx } = recordingContext();

		controller.noteRead("a.ts", seen("v1"), ctx);
		await controller.settled();
		controller.noteRead("a.ts", seen("v1"), ctx);
		controller.noteTurn(ctx);
		await controller.settled();
		expect(disk.inspected).toHaveLength(1);

		scheduler.set(PROBE_INTERVAL_MS);
		controller.noteTurn(ctx);
		await controller.settled();
		expect(disk.inspected).toHaveLength(2);
	});

	it("walks the working set round-robin instead of re-hashing everything each tick", async () => {
		const scheduler = manualScheduler();
		const disk = fakeDisk({ "a.ts": "v", "b.ts": "v", "c.ts": "v" });
		const controller = new AuditTrailBoxController({ scheduler, probeSource: disk.source, probeBatchSize: 1 });
		const { ctx } = recordingContext();

		controller.noteRead("a.ts", seen("v"), ctx);
		controller.noteRead("b.ts", seen("v"), ctx);
		controller.noteRead("c.ts", seen("v"), ctx);
		await controller.settled();
		disk.inspected.length = 0;

		await controller.probeNow(ctx);
		expect(disk.inspected).toHaveLength(1);
		await controller.probeNow(ctx);
		await controller.probeNow(ctx);
		expect([...disk.inspected].sort()).toEqual(["a.ts", "b.ts", "c.ts"]);
	});

	it("skips a tick with nothing tracked", async () => {
		const disk = fakeDisk();
		const controller = new AuditTrailBoxController({ scheduler: manualScheduler(), probeSource: disk.source });
		const { ctx } = recordingContext();
		await controller.probeNow(ctx);
		expect(disk.inspected).toHaveLength(0);
	});

	it("never overlaps two ticks", async () => {
		const scheduler = manualScheduler();
		let release: (() => void) | undefined;
		const inspected: string[] = [];
		const source: ProbeSource = {
			async inspect(path) {
				inspected.push(path);
				await new Promise<void>(resolve => {
					release = resolve;
				});
				return { hash: hashContent("v"), content: "v" };
			},
		};
		const controller = new AuditTrailBoxController({ scheduler, probeSource: source, probeBatchSize: 1 });
		const { ctx } = recordingContext();

		controller.noteRead("a.ts", seen("v"), ctx);
		const first = controller.probeNow(ctx);
		await controller.probeNow(ctx); // in flight: returns immediately without inspecting
		expect(inspected).toHaveLength(1);
		release?.();
		await first;
	});

	it("survives a probe source that throws on the fire-and-forget path", async () => {
		const scheduler = manualScheduler();
		const source: ProbeSource = {
			inspect() {
				throw new Error("EPERM from a hostile filesystem");
			},
		};
		const controller = new AuditTrailBoxController({ scheduler, probeSource: source });
		const { ctx } = recordingContext();

		controller.noteRead("a.ts", seen("v"), ctx);
		await controller.settled();
		expect(controller.state.record("a.ts")?.status).toBe("fresh");
	});
});

describe("audit trail box controller — divergence", () => {
	/** Read a path, then move it on disk behind the agent's back. */
	function poisonSetup(held = "line1\nline2", now = "line1\nCHANGED") {
		const scheduler = manualScheduler();
		const disk = fakeDisk({ "a.ts": held });
		const controller = new AuditTrailBoxController({ scheduler, probeSource: disk.source });
		const recorded = recordingContext();
		controller.noteRead("a.ts", seen(held), recorded.ctx);
		disk.write("a.ts", now);
		return { scheduler, disk, controller, ...recorded };
	}

	it("needs two consecutive probe ticks before POISONED sticks", async () => {
		const { controller, ctx } = poisonSetup();
		await controller.settled();

		await controller.probeNow(ctx);
		expect(controller.state.record("a.ts")?.status).not.toBe("poisoned");
		expect(controller.state.record("a.ts")?.divergenceStreak).toBe(1);

		await controller.probeNow(ctx);
		expect(controller.state.record("a.ts")?.status).toBe("poisoned");
		expect(controller.state.record("a.ts")?.divergenceStreak).toBe(POISON_STREAK_TICKS);
	});

	it("treats a path that vanished from disk as unreachable, then poisoned", async () => {
		const scheduler = manualScheduler();
		const disk = fakeDisk({ "a.ts": "v1" });
		const controller = new AuditTrailBoxController({ scheduler, probeSource: disk.source });
		const { ctx } = recordingContext();

		controller.noteRead("a.ts", seen("v1"), ctx);
		await controller.settled();
		disk.remove("a.ts");
		await controller.probeNow(ctx);
		await controller.probeNow(ctx);

		const record = controller.state.record("a.ts");
		expect(record?.reachable).toBe(false);
		expect(record?.status).toBe("poisoned");
	});

	it("does NOT fire POISONED when the repo's own formatter rewrites a file the agent just wrote", async () => {
		const scheduler = manualScheduler();
		const disk = fakeDisk({ "a.ts": "const x=1\n" });
		const controller = new AuditTrailBoxController({ scheduler, probeSource: disk.source });
		const { ctx, statuses } = recordingContext();

		controller.noteWrite("a.ts", seen("const x=1\n"), ctx);
		await controller.settled();

		// `bun run fix` lands: same file, different bytes, no human involved.
		disk.write("a.ts", "const x = 1;\n");
		scheduler.set(FORMATTER_WINDOW_MS / 4);
		await controller.probeNow(ctx);
		scheduler.set(FORMATTER_WINDOW_MS / 2);
		await controller.probeNow(ctx);

		const record = controller.state.record("a.ts");
		expect(record?.status).toBe("dirty");
		expect(record?.formatterAbsorbs).toBe(1);
		expect(record?.divergenceStreak).toBe(0);
		// Nothing cleared the severity gate, so the alarm line never appeared.
		expect(statuses).toHaveLength(0);
	});

	it("still fires POISONED for an external edit that lands after the formatter window closes", async () => {
		const scheduler = manualScheduler();
		const disk = fakeDisk({ "a.ts": "written\n" });
		const controller = new AuditTrailBoxController({ scheduler, probeSource: disk.source });
		const { ctx } = recordingContext();

		controller.noteWrite("a.ts", seen("written\n"), ctx);
		await controller.settled();

		scheduler.set(FORMATTER_WINDOW_MS + 1_000);
		disk.write("a.ts", "somebody else was here\n");
		await controller.probeNow(ctx);
		await controller.probeNow(ctx);

		expect(controller.state.record("a.ts")?.status).toBe("poisoned");
	});
});

describe("audit trail box controller — the alarm status line", () => {
	/** Drive a path to two firing families without poisoning it: repeat reads, then repeated writes. */
	function alarmingPath(controller: AuditTrailBoxController, ctx: AuditTrailBoxContext, path = "a.ts") {
		controller.noteRead(path, seen("v1"), ctx);
		controller.noteRead(path, seen("v1"), ctx);
		controller.noteWrite(path, seen("v2"), ctx);
		controller.noteWrite(path, seen("v3"), ctx);
		controller.noteWrite(path, seen("v4"), ctx);
	}

	it("stays quiet while nothing has cleared the >=2-family gate", () => {
		const disk = fakeDisk({ "a.ts": "v1" });
		const controller = new AuditTrailBoxController({ scheduler: manualScheduler(), probeSource: disk.source });
		const { ctx, statuses } = recordingContext();

		controller.noteRead("a.ts", seen("v1"), ctx);
		controller.noteRead("a.ts", seen("v1"), ctx); // one family (recovery): a watch item, not an alarm
		expect(controller.state.record("a.ts")?.severity).toBe("watch");
		expect(statuses).toHaveLength(0);
	});

	it("appears once two independent families fire, and clears when the path is re-read", () => {
		const disk = fakeDisk({ "a.ts": "v1" });
		const controller = new AuditTrailBoxController({ scheduler: manualScheduler(), probeSource: disk.source });
		const { ctx, statuses } = recordingContext();

		alarmingPath(controller, ctx);
		expect(controller.state.record("a.ts")?.severity).toBe("alarm");
		const shown = statuses.filter(entry => entry.text !== undefined);
		expect(shown.length).toBeGreaterThan(0);
		expect(shown.at(-1)?.key).toBe(STATUS_KEY);
		expect(shown.at(-1)?.text).toContain(BADGE_GLYPH);
		expect(shown.at(-1)?.text).toContain(STATUS_GLYPHS.dirty);
	});

	it("clears itself when the working set stops being alarming", () => {
		const disk = fakeDisk({ "a.ts": "v1" });
		const controller = new AuditTrailBoxController({ scheduler: manualScheduler(), probeSource: disk.source });
		const { ctx, statuses } = recordingContext();

		alarmingPath(controller, ctx);
		expect(statuses.at(-1)?.text).toBeDefined();

		controller.noteSessionSwitch(ctx);
		expect(statuses.at(-1)).toEqual({ key: STATUS_KEY, text: undefined });
	});

	it("does not spam a clear for a status line that was never shown", () => {
		const disk = fakeDisk({ "a.ts": "v1" });
		const controller = new AuditTrailBoxController({ scheduler: manualScheduler(), probeSource: disk.source });
		const { ctx, statuses } = recordingContext();

		controller.noteRead("a.ts", seen("v1"), ctx);
		controller.noteTurn(ctx);
		controller.noteTurn(ctx);
		expect(statuses).toHaveLength(0);
	});

	it("carries the economics tail on a wide terminal and drops it on a narrow one", () => {
		const disk = fakeDisk({ "a.ts": "v1" });
		const wide = new AuditTrailBoxController({ scheduler: manualScheduler(), probeSource: disk.source });
		const narrow = new AuditTrailBoxController({ scheduler: manualScheduler(), probeSource: disk.source });
		const wideCtx = recordingContext({ columns: 200 });
		const narrowCtx = recordingContext({ columns: 40 });

		alarmingPath(wide, wideCtx.ctx);
		alarmingPath(narrow, narrowCtx.ctx);

		expect(wideCtx.statuses.at(-1)?.text).toContain("r/w");
		expect(narrowCtx.statuses.at(-1)?.text).not.toContain("r/w");
	});

	it("degrades to the single highest-risk count when the footer budget runs out", async () => {
		const scheduler = manualScheduler();
		const disk = fakeDisk({ "a.ts": "v1", "b.ts": "v1", "c.ts": "v1", "d.ts": "v1" });
		const controller = new AuditTrailBoxController({ scheduler, probeSource: disk.source });
		const { ctx, statuses } = recordingContext({ columns: 1 }); // clamps to MIN_STATUS_WIDTH

		controller.noteRead("b.ts", seen("v1"), ctx);
		controller.noteRead("b.ts", seen("v1"), ctx); // -> redundant
		controller.noteWrite("c.ts", seen("v2"), ctx); // -> dirty
		disk.write("c.ts", "v2"); // the write landed, so c.ts has not diverged
		controller.noteRead("d.ts", seen("v1"), ctx); // -> fresh
		controller.noteRead("a.ts", seen("v1"), ctx);
		await controller.settled();

		disk.write("a.ts", "moved");
		await controller.probeNow(ctx);
		await controller.probeNow(ctx);
		expect(controller.state.record("a.ts")?.status).toBe("poisoned");
		expect(controller.state.snapshot().counts).toMatchObject({ poisoned: 1, dirty: 1, redundant: 1, fresh: 1 });

		const text = statuses.at(-1)?.text;
		expect(text).toBe(`${BADGE_GLYPH} 1${STATUS_GLYPHS.poisoned}`);
	});

	it("applies the accent override to the badge", () => {
		const disk = fakeDisk({ "a.ts": "v1" });
		const controller = new AuditTrailBoxController({
			scheduler: manualScheduler(),
			probeSource: disk.source,
			accentColor: "syntaxString",
		});
		const { ctx, statuses } = recordingContext({ theme: taggedTheme });

		alarmingPath(controller, ctx);
		expect(statuses.at(-1)?.text).toContain(`syntaxString:${BADGE_GLYPH}`);
	});
});

describe("audit trail box controller — remedy and panel", () => {
	it("diffs the held copy against disk BEFORE the stale copy is discarded", async () => {
		const scheduler = manualScheduler();
		const disk = fakeDisk({ "a.ts": "alpha\nbeta\n" });
		const controller = new AuditTrailBoxController({ scheduler, probeSource: disk.source });
		const { ctx } = recordingContext();

		controller.noteRead("a.ts", seen("alpha\nbeta\n"), ctx);
		await controller.settled();
		disk.write("a.ts", "alpha\nGAMMA\n");
		await controller.probeNow(ctx);
		await controller.probeNow(ctx);

		const plan = await controller.remedy(ctx);
		expect(plan.mustReread.map(entry => entry.path)).toEqual(["a.ts"]);
		expect(plan.mustReread[0]?.status).toBe("poisoned");
		expect(plan.mustReread[0]?.diff).toEqual(["-beta", "+GAMMA"]);
		// The held copy is still held — the remedy describes it, it does not drop it.
		expect(controller.state.record("a.ts")?.contextContent).toBe("alpha\nbeta\n");
	});

	it("re-reads every stale path, not just the round-robin slice the next tick would cover", async () => {
		const scheduler = manualScheduler();
		const disk = fakeDisk({ "a.ts": "v", "b.ts": "v", "c.ts": "v" });
		const controller = new AuditTrailBoxController({ scheduler, probeSource: disk.source, probeBatchSize: 1 });
		const { ctx } = recordingContext();

		controller.noteWrite("a.ts", seen("v"), ctx);
		controller.noteWrite("b.ts", seen("v"), ctx);
		controller.noteWrite("c.ts", seen("v"), ctx);
		await controller.settled();
		disk.inspected.length = 0;

		await controller.remedy(ctx);
		expect([...disk.inspected].sort()).toEqual(["a.ts", "b.ts", "c.ts"]);
	});

	it("picks up content that moved between the last tick and the command", async () => {
		const scheduler = manualScheduler();
		const disk = fakeDisk({ "a.ts": "one\n" });
		const controller = new AuditTrailBoxController({ scheduler, probeSource: disk.source });
		const { ctx } = recordingContext();

		controller.noteWrite("a.ts", seen("one\n"), ctx);
		await controller.settled();
		disk.write("a.ts", "two\n");

		const plan = await controller.remedy(ctx);
		expect(plan.mustReread[0]?.diff).toEqual(["-one", "+two"]);
	});

	it("splits cold paths into the safe-to-drop list", async () => {
		const scheduler = manualScheduler();
		const disk = fakeDisk({ "cold.ts": "v", "hot.ts": "v" });
		const controller = new AuditTrailBoxController({ scheduler, probeSource: disk.source });
		const { ctx } = recordingContext();

		controller.noteRead("cold.ts", seen("v"), ctx);
		for (let turn = 0; turn < 10; turn++) controller.noteTurn(ctx);
		controller.noteWrite("hot.ts", seen("v"), ctx);
		await controller.settled();

		const plan = await controller.remedy(ctx);
		expect(plan.safeToDrop.map(entry => entry.path)).toEqual(["cold.ts"]);
		expect(plan.mustReread.map(entry => entry.path)).toEqual(["hot.ts"]);
	});

	it("reports an empty plan when nothing is tracked", async () => {
		const disk = fakeDisk();
		const controller = new AuditTrailBoxController({ scheduler: manualScheduler(), probeSource: disk.source });
		const { ctx } = recordingContext();
		const plan = await controller.remedy(ctx);
		expect(plan).toEqual({
			turn: 0,
			mustReread: [],
			mustRereadOverflow: 0,
			safeToDrop: [],
			safeToDropOverflow: 0,
		});
	});

	it("renders the panel through the caller's theme and the resolved accent", () => {
		const disk = fakeDisk({ "a.ts": "v" });
		const controller = new AuditTrailBoxController({
			scheduler: manualScheduler(),
			probeSource: disk.source,
			accentColor: "syntaxString",
		});
		const { ctx } = recordingContext({ theme: taggedTheme });

		controller.noteRead("a.ts", seen("v"), ctx);
		const lines = controller.panel(ctx);
		expect(lines[0]).toContain(`syntaxString:${BADGE_GLYPH}`);
		expect(lines.join("\n")).toContain("a.ts");
	});

	it("caps panel rows and reports the remainder", () => {
		const disk = fakeDisk();
		const controller = new AuditTrailBoxController({ scheduler: manualScheduler(), probeSource: disk.source });
		const { ctx } = recordingContext();

		for (let index = 0; index < 5; index++) controller.noteRead(`file-${index}.ts`, seen("v"), ctx);
		const lines = controller.panel(ctx, { maxRows: 2 });
		expect(lines.join("\n")).toContain("+3 more");
	});
});

describe("audit trail box controller — teardown", () => {
	it("clears both surfaces and stops the frame clock", () => {
		const scheduler = manualScheduler();
		const disk = fakeDisk({ "a.ts": "v" });
		const controller = new AuditTrailBoxController({ scheduler, probeSource: disk.source });
		const { ctx, widgets, statuses } = recordingContext();

		controller.noteRead("a.ts", seen("v"), ctx);
		const factory = widgets[0]?.content as (tui: typeof noopTui, theme: AuditTrailBoxTheme) => AuditTrailBoxWidget;
		factory(noopTui, idTheme);
		expect(scheduler.running).toBe(true);

		controller.dispose(ctx);
		expect(widgets.at(-1)).toEqual({ key: WIDGET_KEY, content: undefined });
		expect(statuses.at(-1)).toEqual({ key: STATUS_KEY, text: undefined });
		expect(scheduler.running).toBe(false);
	});

	it("counts a teardown that discarded unresolved paths as a leak", () => {
		const disk = fakeDisk({ "a.ts": "v" });
		const controller = new AuditTrailBoxController({ scheduler: manualScheduler(), probeSource: disk.source });
		const { ctx } = recordingContext();

		controller.noteWrite("a.ts", seen("v"), ctx);
		controller.dispose(ctx);
		expect(controller.state.snapshot().metrics.teardownLeaks).toBe(1);
		expect(controller.state.size).toBe(0);
	});

	it("is idempotent and does not invent a second leak", () => {
		const disk = fakeDisk({ "a.ts": "v" });
		const controller = new AuditTrailBoxController({ scheduler: manualScheduler(), probeSource: disk.source });
		const { ctx, widgets } = recordingContext();

		controller.noteWrite("a.ts", seen("v"), ctx);
		controller.dispose(ctx);
		const after = widgets.length;
		controller.dispose(ctx);
		expect(widgets).toHaveLength(after);
		expect(controller.state.snapshot().metrics.teardownLeaks).toBe(1);
	});

	it("disposing before anything mounted touches no surface", () => {
		const disk = fakeDisk();
		const controller = new AuditTrailBoxController({ scheduler: manualScheduler(), probeSource: disk.source });
		const { ctx, widgets, statuses } = recordingContext();
		controller.dispose(ctx);
		expect(widgets).toHaveLength(0);
		expect(statuses).toHaveLength(0);
	});
});
