import { describe, expect, it } from "bun:test";
import { visibleWidth } from "@oh-my-pi/pi-tui";
import type { AgentBonsaiCaches, AgentBonsaiRef, AgentBonsaiSnapshot } from "../src/agent-bonsai";
import { buildAgentBonsai, MAX_BONSAI_ROWS } from "../src/agent-bonsai";
import { type AnimationsBoxContext, AnimationsBoxController } from "../src/animations-box/controller";
import type { SegmentSample } from "../src/animations-box/segments";
import { resolveAnimationsBoxConfig } from "../src/animations-box/settings";
import {
	type AnimationsBoxBorderFrame,
	AnimationsBoxWidget,
	BOX_BORDER_COLS,
	BOX_BORDER_ROWS,
} from "../src/animations-box/widget";
import type { AccentColor } from "../src/appearance";
import { BREATHING_BORDER_COLORS, EXHALE_DURATION_MS } from "../src/breathing-border";
import { AnimationHost, type FrameScheduler, MotionPolicy } from "../src/kit";

// Identity theme so most assertions see plain text instead of ANSI escapes.
const idTheme = { fg: (_color: string, text: string) => text };
// Color-tagging theme for tests that need to assert which token the border chose.
const taggedTheme = { fg: (color: string, text: string) => `${color}:${text}` };
const cellTaggedTheme = { fg: (color: string, text: string) => `<${color}>${text}</${color}>` };
const noopTui = { requestComponentRender: () => {} };
const fullEnv = { hasUI: true, isTTY: true, env: {} as Record<string, string | undefined> };

function staticBorderFrame(brightness: number): AnimationsBoxBorderFrame {
	return { phase: "active", brightness, glossProgress: 0, glossStrength: 0 };
}

/** Manual frame scheduler: drives host ticks and the shared clock deterministically. */
function manualScheduler(): FrameScheduler & {
	advance(ms: number): void;
	spend(ms: number): void;
	readonly running: boolean;
	readonly cadenceMs: number;
} {
	let current = 0;
	let ticker: (() => void) | undefined;
	let cadenceMs = 0;
	return {
		now: () => current,
		start(intervalMs, tick) {
			cadenceMs = intervalMs;
			ticker = tick;
			return () => {
				ticker = undefined;
				cadenceMs = 0;
			};
		},
		advance(ms) {
			current += ms;
			ticker?.();
		},
		spend(ms) {
			current += ms;
		},
		get cadenceMs() {
			return cadenceMs;
		},
		get running() {
			return ticker !== undefined;
		},
	};
}

const RESTING: SegmentSample = {
	id: "cacheMeter",
	priority: 1,
	active: false,
	variants: [],
	line: { dot: "idle", label: "cache", accent: "dim", spans: [{ key: "idle", text: "—", tone: "dim" }] },
};

const ACTIVE: SegmentSample = {
	id: "cacheMeter",
	priority: 1,
	active: true,
	variants: ["ACTIVE WIDE", "AW"],
	line: {
		dot: "live",
		label: "cache",
		accent: "dim",
		spans: [
			{ key: "pct", text: "62.4%" },
			{ key: "saved", text: "saved $0.41" },
			{ key: "tokens", text: "r 12K · w 2K", wideOnly: true },
		],
	},
};

const OPTIONAL_A: SegmentSample = {
	...ACTIVE,
	id: "optionalA",
	priority: 6,
	line: { ...ACTIVE.line, label: "opt-a" },
};

const OPTIONAL_B: SegmentSample = {
	...ACTIVE,
	id: "optionalB",
	priority: 7,
	line: { ...ACTIVE.line, label: "opt-b" },
};

const MAIN_ONLY_BONSAI: AgentBonsaiSnapshot = {
	visible: false,
	hiddenCount: 0,
	nodes: [
		{
			id: "Main",
			cohortLabel: "M",
			name: "Main",
			depth: 0,
			isLast: true,
			ancestorsLast: [],
			status: "running",
			loadedSkills: [],
		},
	],
};

const ACTIVE_BONSAI: AgentBonsaiSnapshot = {
	visible: true,
	hiddenCount: 0,
	nodes: [
		...MAIN_ONLY_BONSAI.nodes,
		{
			id: "worker",
			cohortLabel: "A1",
			name: "worker",
			depth: 1,
			isLast: true,
			ancestorsLast: [],
			status: "running",
			model: "anthropic/sonnet",
			loadedSkills: [],
			gist: "read src/a.ts 12",
		},
	],
};

const SKILL_BONSAI: AgentBonsaiSnapshot = {
	visible: true,
	hiddenCount: 0,
	nodes: [
		...MAIN_ONLY_BONSAI.nodes,
		{
			id: "worker",
			cohortLabel: "A1",
			name: "worker",
			depth: 1,
			isLast: true,
			ancestorsLast: [],
			status: "running",
			model: "anthropic/sonnet",
			activeSkill: { name: "tdd", path: "/skills/tdd/SKILL.md" },
			loadedSkills: [{ name: "tdd", path: "/skills/tdd/SKILL.md" }],
		},
	],
};

const UNIFORM_MODEL_BONSAI: AgentBonsaiSnapshot = {
	visible: true,
	hiddenCount: 0,
	nodes: [
		{ ...MAIN_ONLY_BONSAI.nodes[0], model: "openai-codex/gpt-5.6-sol:high" },
		{
			id: "worker",
			cohortLabel: "A1",
			name: "worker",
			depth: 1,
			isLast: false,
			ancestorsLast: [],
			status: "running",
			model: "openai-codex/gpt-5.6-sol:high",
			loadedSkills: [],
			gist: "Verifying boundary contract",
		},
		{
			id: "peer",
			cohortLabel: "A2",
			name: "peer",
			depth: 1,
			isLast: true,
			ancestorsLast: [],
			status: "running",
			model: "openai-codex/gpt-5.6-sol:high",
			loadedSkills: [],
			gist: "Checking status",
		},
	],
};

function makeWidget(opts: {
	samples: readonly SegmentSample[];
	optionalSamples?: readonly SegmentSample[];
	detail?: "simple" | "detailed";
	onTick?: (now: number) => void;
	scheduler?: FrameScheduler;
	motionSetting?: "off" | "subtle" | "full";
	reducedMotion?: boolean;
	theme?: { fg: (color: string, text: string) => string };
	getBorderFrame?: (now: number) => AnimationsBoxBorderFrame | undefined;
	getCollisionDiffraction?: (now: number, width: number) => string | undefined;
	getBorderAlert?: () => boolean;
	accentColor?: AccentColor;
	agentBonsai?: AgentBonsaiSnapshot;
	hyperlinks?: boolean;
}): AnimationsBoxWidget {
	const scheduler = opts.scheduler ?? manualScheduler();
	const policy = new MotionPolicy(
		{
			...fullEnv,
			env: opts.reducedMotion ? { OMP_ANIMATIONS_REDUCED_MOTION: "1" } : {},
		},
		opts.motionSetting ?? "full",
	);
	const host = new AnimationHost({ policy, scheduler });
	return new AnimationsBoxWidget({
		tui: noopTui,
		host,
		policy,
		theme: opts.theme ?? idTheme,
		clock: scheduler,
		onTick: opts.onTick ?? (() => {}),
		buildSampleGroups: () => ({ required: opts.samples, optional: opts.optionalSamples ?? [] }),
		getDetail: () => opts.detail ?? "detailed",
		// `undefined` is the plain, pre-dxi.5 chrome — the sensible default for every
		// test above that doesn't care about border coloring.
		getBorderFrame: opts.getBorderFrame ?? (() => undefined),
		getCollisionDiffraction: opts.getCollisionDiffraction,
		getBorderAlert: opts.getBorderAlert,
		accentColor: opts.accentColor,
		getAgentBonsai: () => opts.agentBonsai ?? MAIN_ONLY_BONSAI,
		// Pinned off by default so golden rows never vary with the terminal running the suite.
		hyperlinks: opts.hyperlinks ?? false,
	});
}

describe("AnimationsBoxWidget — border chrome and empty/zero-width guards", () => {
	it("renders nothing at all at zero or negative width", () => {
		const widget = makeWidget({ samples: [ACTIVE] });
		expect(widget.render(0)).toEqual([]);
		expect(widget.render(-5)).toEqual([]);
	});

	it("renders nothing when the enabled set is entirely empty — no segments, no border either", () => {
		const widget = makeWidget({ samples: [] });
		expect(widget.render(69)).toEqual([]);
	});

	it("border cost is documented as 2 rows / 4 columns", () => {
		expect(BOX_BORDER_ROWS).toBe(2);
		expect(BOX_BORDER_COLS).toBe(4);
	});
});

describe("AnimationsBoxWidget — detailed grouped rows", () => {
	it("renders exactly 3 rows (2 border + 1 content) for one enabled segment, regardless of activity", () => {
		expect(makeWidget({ samples: [RESTING], detail: "detailed" }).render(40)).toHaveLength(3);
		expect(makeWidget({ samples: [ACTIVE], detail: "detailed" }).render(40)).toHaveLength(3);
	});

	it("height scales with the enabled count, not the active count — one resting + one active still yields 4 rows", () => {
		const rows = makeWidget({ samples: [ACTIVE, RESTING], detail: "detailed" }).render(40);
		expect(rows).toHaveLength(4);
	});

	it("adds exactly one blank separator between required summaries and visible optional animations", () => {
		const width = 40;
		const rows = makeWidget({
			samples: [ACTIVE, RESTING],
			optionalSamples: [OPTIONAL_A, OPTIONAL_B],
			detail: "detailed",
		}).render(width);

		expect(rows).toHaveLength(2 + 2 + 1 + 2);
		expect(rows[1]).toContain("cache");
		expect(rows[2]).toContain("cache");
		expect(rows[3]).toBe(`│ ${" ".repeat(width - BOX_BORDER_COLS)} │`);
		expect(rows[4]).toContain("opt-a");
		expect(rows[5]).toContain("opt-b");
		for (const narrowWidth of [20, 6]) {
			for (const row of makeWidget({
				samples: [ACTIVE],
				optionalSamples: [OPTIONAL_A],
				detail: "detailed",
			}).render(narrowWidth)) {
				expect(visibleWidth(row)).toBe(narrowWidth);
			}
		}
	});

	it("does not prepend a blank separator when an all-optional sidecar becomes visible", () => {
		const width = 40;
		const rows = makeWidget({ samples: [], optionalSamples: [OPTIONAL_A], detail: "detailed" }).render(width);
		expect(rows).toHaveLength(3);
		expect(rows[1]).toContain("opt-a");
		expect(rows[1]).not.toBe(`│ ${" ".repeat(width - BOX_BORDER_COLS)} │`);
	});

	it("does not add a trailing blank row when no optional animation is visible", () => {
		const width = 40;
		const rows = makeWidget({ samples: [ACTIVE, RESTING], detail: "detailed" }).render(width);

		expect(rows).toHaveLength(2 + 2);
		expect(rows.slice(1, -1)).not.toContain(`│ ${" ".repeat(width - BOX_BORDER_COLS)} │`);
	});

	it("hides the agents group and its separator for Main-only snapshots", () => {
		const width = 48;
		const rows = makeWidget({
			samples: [ACTIVE],
			detail: "detailed",
			agentBonsai: MAIN_ONLY_BONSAI,
		}).render(width);

		expect(rows).toHaveLength(3);
		expect(rows.join("\n")).not.toContain("agents");
		expect(rows.slice(1, -1)).not.toContain(`│ ${" ".repeat(width - BOX_BORDER_COLS)} │`);
	});

	it("adds one agents group and one separator when a subagent exists", () => {
		const width = 72;
		const rows = makeWidget({
			samples: [ACTIVE],
			detail: "detailed",
			agentBonsai: ACTIVE_BONSAI,
		}).render(width);

		expect(rows).toHaveLength(7);
		expect(rows[2]).toBe(`│ ${" ".repeat(width - BOX_BORDER_COLS)} │`);
		expect(rows.filter(row => row.includes("agents"))).toHaveLength(1);
		expect(rows.join("\n")).toContain("A1 worker");
	});

	it("states a model shared by every visible node once on the group header, not once per row (daw.4)", () => {
		const width = 90;
		const rows = makeWidget({
			samples: [ACTIVE],
			detail: "detailed",
			agentBonsai: UNIFORM_MODEL_BONSAI,
		}).render(width);

		const text = rows.join("\n");
		expect(text).toContain("agents · openai-codex/gpt-5.6-sol:high");
		expect(text.match(/openai-codex\/gpt-5\.6-sol:high/g)).toHaveLength(1);
		expect(text).toContain("Verifying boundary contract");
		expect(text).toContain("Checking status");
	});

	it("keeps every border pipe aligned when the skill chip carries an OSC 8 link", () => {
		const width = 72;
		const plain = makeWidget({ samples: [ACTIVE], detail: "detailed", agentBonsai: SKILL_BONSAI }).render(width);
		const linked = makeWidget({
			samples: [ACTIVE],
			detail: "detailed",
			agentBonsai: SKILL_BONSAI,
			hyperlinks: true,
		}).render(width);

		expect(plain.join("\n")).toContain("skill:tdd");
		expect(plain.join("\n")).not.toContain("\u001b]8;");
		expect(linked.join("\n")).toContain("\u001b]8;");

		// The link costs zero cells, so the box geometry must not move at all.
		expect(linked).toHaveLength(plain.length);
		for (const row of linked) {
			expect(visibleWidth(row)).toBe(width);
			expect(row.endsWith(" │") || row.endsWith("┐") || row.endsWith("┘")).toBe(true);
		}
	});

	it("an idle enabled segment renders its own resting row content, not absence", () => {
		const rows = makeWidget({ samples: [RESTING], detail: "detailed" }).render(40);
		expect(rows[1]).toContain("cache");
		expect(rows[1]).toContain("—");
	});

	it("holds an exact golden resting-row frame at width 69 — the maintainer's real pane", () => {
		const width = 69;
		const inner = width - BOX_BORDER_COLS; // 65
		// dot(1) + gap(2) + label gutter(7) + gap(2) = 12 prefix columns, then the idle dash.
		const body = "○  cache    —";
		expect(visibleWidth(body)).toBe(13);

		const rows = makeWidget({ samples: [RESTING], detail: "detailed" }).render(width);
		expect(rows).toEqual([
			`┌${"─".repeat(width - 2)}┐`,
			`│ ${body}${" ".repeat(inner - visibleWidth(body))} │`,
			`└${"─".repeat(width - 2)}┘`,
		]);
	});

	it("truncates the wide tail first, then hard-truncates the whole row, never overflowing the border", () => {
		const overflowing: SegmentSample = {
			...ACTIVE,
			line: {
				dot: "live",
				label: "cache",
				accent: "dim",
				spans: [
					{ key: "pct", text: "62.4%" },
					{ key: "saved", text: "saved $0.41" },
					{ key: "tokens", text: "x".repeat(200), wideOnly: true },
				],
			},
		};
		for (const width of [69, 45, 20, 6]) {
			const rows = makeWidget({ samples: [overflowing], detail: "detailed" }).render(width);
			for (const row of rows) expect(row.length).toBeLessThanOrEqual(width);
		}
	});
});

describe("AnimationsBoxWidget — simple mode: fixed status strip plus conditional Agent Bonsai", () => {
	it("is always exactly 3 rows regardless of how many segments are enabled", () => {
		expect(makeWidget({ samples: [RESTING], detail: "simple" }).render(40)).toHaveLength(3);
		expect(makeWidget({ samples: [ACTIVE, RESTING], detail: "simple" }).render(40)).toHaveLength(3);
	});

	it("draws the composed row from only the ACTIVE segments — an idle one contributes nothing", () => {
		const rows = makeWidget({ samples: [RESTING], detail: "simple" }).render(40);
		// Border present, but the composed content row is blank (RESTING has no variants to compose).
		expect(rows[1]).toBe(`│ ${" ".repeat(36)} │`);
	});

	it("composes the active segment's widest-affordable variant into the strip", () => {
		const rows = makeWidget({ samples: [ACTIVE], detail: "simple" }).render(40);
		expect(rows[1]).toContain("ACTIVE WIDE");
	});

	it("appends the agents group only while a subagent exists", () => {
		const width = 72;
		const mainOnly = makeWidget({
			samples: [ACTIVE],
			detail: "simple",
			agentBonsai: MAIN_ONLY_BONSAI,
		}).render(width);
		const active = makeWidget({
			samples: [ACTIVE],
			detail: "simple",
			agentBonsai: ACTIVE_BONSAI,
		}).render(width);

		expect(mainOnly).toHaveLength(3);
		expect(mainOnly.join("\n")).not.toContain("agents");
		expect(active).toHaveLength(7);
		expect(active.filter(row => row.includes("agents"))).toHaveLength(1);
		expect(active.join("\n")).toContain("A1 worker");
	});
});

describe("AnimationsBoxWidget — lifecycle and per-tick hook", () => {
	it("subscribes to the host on first render and unsubscribes on dispose", () => {
		const scheduler = manualScheduler();
		const policy = new MotionPolicy(fullEnv, "full");
		const host = new AnimationHost({ policy, scheduler });
		const widget = new AnimationsBoxWidget({
			tui: noopTui,
			host,
			policy,
			theme: idTheme,
			clock: scheduler,
			onTick: () => {},
			buildSampleGroups: () => ({ required: [ACTIVE], optional: [] }),
			getDetail: () => "detailed",
			getBorderFrame: () => undefined,
		});

		widget.render(69);
		expect(widget.animating).toBe(true);
		expect(host.subscriberCount).toBe(1);

		widget.dispose();
		expect(host.subscriberCount).toBe(0);
	});

	it("calls onTick with the shared clock's current time on every frame", () => {
		const scheduler = manualScheduler();
		const seen: number[] = [];
		const widget = makeWidget({ samples: [ACTIVE], onTick: now => seen.push(now), scheduler });
		widget.render(69);

		scheduler.advance(50);
		expect(seen).toContain(50);
		widget.dispose();
	});
});

describe("AnimationsBoxWidget motion governor", () => {
	it("freezes optional emphasis without pausing facts or repainting unchanged rows, then recovers", () => {
		const scheduler = manualScheduler();
		const policy = new MotionPolicy(fullEnv, "full");
		const host = new AnimationHost({ policy, scheduler });
		let costMs = 3;
		let money = "$0.41";
		let repaints = 0;
		let tickNow = 0;
		const widget = new AnimationsBoxWidget({
			host,
			policy,
			clock: scheduler,
			tui: { requestComponentRender: () => repaints++ },
			theme: { ...idTheme, bold: text => `\x1b[1m${text}\x1b[22m` },
			onTick: now => {
				tickNow = now;
			},
			buildSampleGroups: () => {
				scheduler.spend(costMs);
				return {
					required: [
						{
							...ACTIVE,
							line: {
								...ACTIVE.line,
								spans: [{ key: "saved", text: `saved ${money}`, flash: false }],
							},
						},
					],
					optional: [
						{
							...OPTIONAL_A,
							line: {
								...OPTIONAL_A.line,
								activity: true,
								spans: [{ key: "state", text: "running" }],
							},
						},
					],
				};
			},
			getDetail: () => "detailed",
			getBorderFrame: now => ({
				phase: "active",
				brightness: (now % 1_000) / 1_000,
				glossProgress: (now % 1_000) / 1_000,
				glossStrength: 1,
			}),
		});
		widget.render(120);
		for (let frame = 0; frame < 13; frame++) scheduler.advance(host.cadenceMs);
		expect(host.effectiveTier).toBe("off");
		expect(policy.tier).toBe("full");
		expect(widget.animating).toBe(true);
		const frozenRows = widget.render(120);
		expect(frozenRows.find(row => row.includes("opt-a"))).toContain("running");
		expect(frozenRows.find(row => row.includes("opt-a"))).not.toContain("\x1b[1m");
		const frozenRepaints = repaints;
		for (let frame = 0; frame < 3; frame++) scheduler.advance(host.cadenceMs);
		expect(widget.render(120)).toEqual(frozenRows);
		expect(repaints).toBe(frozenRepaints);
		money = "$9.00";
		const nextNow = scheduler.now() + host.cadenceMs;
		scheduler.advance(host.cadenceMs);
		expect(tickNow).toBe(nextNow);
		expect(widget.render(120).find(row => row.includes("cache"))).toContain("saved $9.00");
		expect(repaints).toBe(frozenRepaints + 1);
		expect(widget.render(120)[0]).toBe(frozenRows[0]);
		costMs = 0;
		for (let frame = 0; frame < 89; frame++) scheduler.advance(host.cadenceMs);
		expect(host.effectiveTier).toBe("subtle");
		scheduler.advance(host.cadenceMs);
		expect(host.effectiveTier).toBe("full");
		expect(host.cadenceMs).toBe(policy.cadenceMs);
		widget.dispose();
		host.dispose();
		expect(scheduler.running).toBe(false);
	});

	it("keeps controller retry deadlines, context risk and terminal lifecycle on real time during freeze", () => {
		const scheduler = manualScheduler();
		const widgets: AnimationsBoxWidget[] = [];
		let percent = 20;
		const ctx: AnimationsBoxContext = {
			...fullEnv,
			cwd: "/repo",
			glyphPreset: "unicode",
			getContextUsage: () => {
				scheduler.spend(3);
				return { tokens: percent * 2_000, contextWindow: 200_000, percent };
			},
			setWidget: (_key, content) => {
				if (typeof content !== "function") return;
				const factory = content as (tui: unknown, theme: unknown) => AnimationsBoxWidget;
				widgets.push(factory(noopTui, taggedTheme));
			},
		};
		const controller = new AnimationsBoxController({
			scheduler,
			initialConfig: resolveAnimationsBoxConfig({ animationsBoxDetail: "detailed" }),
		});
		controller.mount(ctx);
		const widget = widgets[0]!;
		controller.onAgentStart({ type: "agent_start" }, ctx);
		widget.render(160);
		for (let frame = 0; frame < 13; frame++) scheduler.advance(scheduler.cadenceMs);
		expect(scheduler.cadenceMs).toBe(250);
		const activeBorder = widget.render(160)[0];
		expect(activeBorder).toStartWith(`${BREATHING_BORDER_COLORS.base}:┌`);
		controller.onAutoRetryStart(
			{ type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 3_000 } as Parameters<
				AnimationsBoxController["onAutoRetryStart"]
			>[0],
			ctx,
		);
		expect(widget.render(160).find(row => row.includes("retry"))).toContain("3s");
		scheduler.advance(1_000);
		expect(widget.render(160).find(row => row.includes("retry"))).toContain("2s");
		percent = 90;
		scheduler.advance(scheduler.cadenceMs);
		expect(widget.render(160).find(row => row.includes("context"))).toContain("0 left of 160K");
		expect(widget.render(160)[0]).toBe(activeBorder);
		controller.onAgentEnd({ type: "agent_end", messages: [] }, ctx);
		widget.render(160);
		scheduler.advance(EXHALE_DURATION_MS + 1);
		expect(widget.render(160)[0]).toStartWith(`${BREATHING_BORDER_COLORS.muted}:┌`);
		expect(scheduler.cadenceMs).toBe(250);
		widget.dispose();
		controller.dispose(ctx);
		expect(scheduler.running).toBe(false);
	});
});

describe("AnimationsBoxWidget — border chrome breathing (Decision 2)", () => {
	it("moves one gloss head clockwise through every corner and side cell of the current perimeter", () => {
		const width = 12;
		const perimeterLength = 28; // 12 top + 2 right + 12 bottom + 2 left
		const renderAt = (cellIndex: number): readonly string[] =>
			makeWidget({
				samples: [ACTIVE, RESTING],
				theme: cellTaggedTheme,
				getBorderFrame: () => ({
					phase: "active",
					brightness: 0,
					glossProgress: cellIndex / perimeterLength,
					glossStrength: 1,
				}),
			}).render(width);

		expect(renderAt(0)[0]?.startsWith("<borderAccent>┌</borderAccent>")).toBe(true); // top-left
		expect(renderAt(11)[0]?.endsWith("<borderAccent>┐</borderAccent>")).toBe(true); // top-right
		expect(renderAt(12)[1]?.endsWith("<borderAccent>│</borderAccent>")).toBe(true); // right, first row
		expect(renderAt(13)[2]?.endsWith("<borderAccent>│</borderAccent>")).toBe(true); // right, second row
		expect(renderAt(14)[3]?.endsWith("<borderAccent>┘</borderAccent>")).toBe(true); // bottom-right
		expect(renderAt(25)[3]?.startsWith("<borderAccent>└</borderAccent>")).toBe(true); // bottom-left
		expect(renderAt(26)[2]?.startsWith("<borderAccent>│</borderAccent>")).toBe(true); // left, second row
		expect(renderAt(27)[1]?.startsWith("<borderAccent>│</borderAccent>")).toBe(true); // left, first row
	});

	it("flashes the top-left corner to peak while the gloss head is still close enough", () => {
		const width = 120;
		const perimeterLength = 244; // 120 top + 2 right + 120 bottom + 2 left
		const renderWithHeadAt = (headIndex: number): readonly string[] =>
			makeWidget({
				samples: [ACTIVE, RESTING],
				theme: cellTaggedTheme,
				getBorderFrame: () => ({
					phase: "active",
					brightness: 0,
					glossProgress: headIndex / perimeterLength,
					glossStrength: 1,
				}),
			}).render(width);

		// Head 7 cells past the top-left corner: the corner's own trail falloff is
		// still >= the corner-accent threshold, so it flashes peak alongside the head.
		const flashing = renderWithHeadAt(7);
		expect(flashing[0]?.startsWith("<borderAccent>┌</borderAccent>")).toBe(true);
		const flashingPeaks = flashing.join("\n").match(/<borderAccent>/g) ?? [];
		expect(flashingPeaks).toHaveLength(2); // the head cell and the flashing corner

		// One cell further on, the same corner's trail has fallen under the threshold
		// and it reverts to the ordinary non-head demotion.
		const settled = renderWithHeadAt(8);
		expect(settled[0]?.startsWith("<borderAccent>┌</borderAccent>")).toBe(false);
		const settledPeaks = settled.join("\n").match(/<borderAccent>/g) ?? [];
		expect(settledPeaks).toHaveLength(1); // only the head cell
	});

	it("does not flash a corner from ambient brightness alone when the gloss head is far away", () => {
		const width = 120;
		const rows = makeWidget({
			samples: [ACTIVE, RESTING],
			theme: cellTaggedTheme,
			getBorderFrame: () => ({
				phase: "active",
				brightness: 0.9, // ambient brightness alone already buckets to borderAccent
				glossProgress: 0.5, // head is on the far side of the perimeter from every corner
				glossStrength: 1,
			}),
		}).render(width);

		expect(rows[0]?.startsWith("<borderAccent>┌</borderAccent>")).toBe(false);
		expect(rows[0]?.endsWith("<borderAccent>┐</borderAccent>")).toBe(false);
		const last = rows.at(-1);
		expect(last?.startsWith("<borderAccent>└</borderAccent>")).toBe(false);
		expect(last?.endsWith("<borderAccent>┘</borderAccent>")).toBe(false);
	});

	it("keeps one peak head distinct from its falling tail on a long perimeter", () => {
		const width = 120;
		const rows = makeWidget({
			samples: [ACTIVE, RESTING],
			theme: cellTaggedTheme,
			getBorderFrame: () => ({
				phase: "active",
				brightness: 0,
				glossProgress: 0.25,
				glossStrength: 1,
			}),
		}).render(width);
		const frame = rows.join("\n");
		const peakCells = frame.match(/<borderAccent>/g) ?? [];

		expect(peakCells).toHaveLength(1);
		expect(frame).toContain(`<${BREATHING_BORDER_COLORS.base}>`);
		expect(frame).toContain(`<${BREATHING_BORDER_COLORS.muted}>`);
	});

	it("keeps the gloss head as the only peak-colored cell at the breathing crest", () => {
		const width = 20;
		const rows = makeWidget({
			samples: [ACTIVE, RESTING],
			theme: cellTaggedTheme,
			getBorderFrame: () => ({
				phase: "active",
				brightness: 0.9,
				glossProgress: 0.25,
				glossStrength: 1,
			}),
		}).render(width);
		const peakRuns = rows.join("\n").matchAll(/<borderAccent>([^<]*)<\/borderAccent>/gu);
		let peakWidth = 0;
		for (const match of peakRuns) peakWidth += visibleWidth(match[1] ?? "");

		expect(peakWidth).toBe(1);
		for (const row of rows) {
			const visible = row.replace(/<\/?(?:borderMuted|border|borderAccent)>/gu, "");
			expect(visibleWidth(visible)).toBe(width);
		}
	});

	it("buckets brightness and strengthens every border glyph together at the crest", () => {
		const dim = makeWidget({
			samples: [RESTING],
			theme: taggedTheme,
			getBorderFrame: () => staticBorderFrame(0),
		}).render(20);
		expect(dim[0]).toBe(`${BREATHING_BORDER_COLORS.muted}:┌${"─".repeat(18)}┐`);
		expect(dim[2]).toBe(`${BREATHING_BORDER_COLORS.muted}:└${"─".repeat(18)}┘`);

		const mid = makeWidget({
			samples: [RESTING],
			theme: taggedTheme,
			getBorderFrame: () => staticBorderFrame(0.3),
		}).render(20);
		expect(mid[0]).toBe(`${BREATHING_BORDER_COLORS.base}:┌${"─".repeat(18)}┐`);

		const peak = makeWidget({
			samples: [RESTING],
			theme: taggedTheme,
			getBorderFrame: () => staticBorderFrame(0.9),
		}).render(20);
		expect(peak[0]).toBe(`${BREATHING_BORDER_COLORS.peak}:┏${"━".repeat(18)}┓`);
	});

	it("centers one fixed-width collision token in existing top-border chrome", () => {
		const rows = makeWidget({
			samples: [RESTING],
			getCollisionDiffraction: () => "..<.*.>..",
		}).render(20);
		expect(rows[0]).toBe("┌────..<.*.>..─────┐");
		expect(Bun.stringWidth(rows[0] ?? "")).toBe(20);
		expect(rows[2]).toBe(`└${"─".repeat(18)}┘`);
	});

	it("colors the side pipes too, not just the top/bottom rows", () => {
		const rows = makeWidget({
			samples: [RESTING],
			theme: taggedTheme,
			getBorderFrame: () => staticBorderFrame(0.9),
		}).render(20);
		const contentRow = rows[1] as string;
		expect(contentRow.startsWith(`${BREATHING_BORDER_COLORS.peak}:┃`)).toBe(true);
		expect(contentRow.endsWith(`${BREATHING_BORDER_COLORS.peak}:┃`)).toBe(true);
	});

	it("escalates peak border cells to error color when getBorderAlert returns true", () => {
		const withoutAlert = makeWidget({
			samples: [RESTING],
			theme: cellTaggedTheme,
			getBorderFrame: () => staticBorderFrame(0.9),
			getBorderAlert: () => false,
		}).render(20);
		const withAlert = makeWidget({
			samples: [RESTING],
			theme: cellTaggedTheme,
			getBorderFrame: () => staticBorderFrame(0.9),
			getBorderAlert: () => true,
		}).render(20);

		expect(withoutAlert[0]).toContain(`<${BREATHING_BORDER_COLORS.peak}>`);
		expect(withoutAlert[0]).not.toContain("<error>");
		expect(withAlert[0]).toContain("<error>");
		expect(withAlert[0]).not.toContain(`<${BREATHING_BORDER_COLORS.peak}>`);
	});

	it("brightness actually varies across the breath phase, driven by the same nowMs the widget always reads", () => {
		const scheduler = manualScheduler();
		const widget = makeWidget({
			samples: [RESTING],
			theme: taggedTheme,
			scheduler,
			getBorderFrame: now => staticBorderFrame(now < 50 ? 0 : 0.9),
		});
		const before = widget.render(20)[0];
		scheduler.advance(100);
		widget.markDirty();
		const after = widget.render(20)[0];
		expect(before).not.toBe(after);
		expect(before).toContain(`${BREATHING_BORDER_COLORS.muted}:`);
		expect(after).toContain(`${BREATHING_BORDER_COLORS.peak}:`);
		widget.dispose();
	});

	it("an accent override recolors only the peak brightness, leaving muted/base on their fixed tokens", () => {
		const rows = makeWidget({
			samples: [RESTING],
			theme: taggedTheme,
			getBorderFrame: () => staticBorderFrame(0.9),
			accentColor: "accent",
		}).render(20);
		expect(rows[0]).toContain("accent:");
		expect(rows[0]).not.toContain(`${BREATHING_BORDER_COLORS.peak}:`);
	});

	it("motion tier off renders the plain, uncolored chrome — a hard override regardless of a live brightness value", () => {
		const rows = makeWidget({
			samples: [RESTING],
			theme: taggedTheme,
			motionSetting: "off",
			getBorderFrame: () => staticBorderFrame(0.9),
		}).render(20);
		expect(rows[0]).toBe(`┌${"─".repeat(18)}┐`);
		expect(rows[2]).toBe(`└${"─".repeat(18)}┘`);
	});

	it("reduced motion keeps active border color semantics without spatial traversal", () => {
		const scheduler = manualScheduler();
		const widget = makeWidget({
			samples: [RESTING],
			theme: cellTaggedTheme,
			scheduler,
			reducedMotion: true,
			getBorderFrame: now => ({
				phase: "active",
				brightness: now === 0 ? 0 : 1,
				glossProgress: now / 100,
				glossStrength: 1,
			}),
		});

		const atStart = widget.render(20);
		scheduler.advance(75);
		widget.markDirty();
		const afterClockAdvance = widget.render(20);

		expect(afterClockAdvance).toEqual(atStart);
		expect(atStart[0]).toBe(`<${BREATHING_BORDER_COLORS.base}>┌${"─".repeat(18)}┐</${BREATHING_BORDER_COLORS.base}>`);
		expect(atStart.join("\n")).not.toContain(`<${BREATHING_BORDER_COLORS.peak}>`);
		widget.dispose();
	});

	it("getBorderFrame returning undefined (breathingBorder disabled) renders the same plain, uncolored chrome", () => {
		const rows = makeWidget({
			samples: [RESTING],
			theme: taggedTheme,
			getBorderFrame: () => undefined,
		}).render(20);
		expect(rows[0]).toBe(`┌${"─".repeat(18)}┐`);
		expect(rows[2]).toBe(`└${"─".repeat(18)}┘`);
	});

	it("geometry (row count, exact row width) is identical across breathing / motion-off / breathingBorder-disabled, at 45/69/120", () => {
		for (const width of [45, 69, 120]) {
			const breathing = makeWidget({ samples: [RESTING], getBorderFrame: () => staticBorderFrame(0.5) }).render(
				width,
			);
			const motionOff = makeWidget({
				samples: [RESTING],
				motionSetting: "off",
				getBorderFrame: () => staticBorderFrame(0.5),
			}).render(width);
			const disabled = makeWidget({ samples: [RESTING], getBorderFrame: () => undefined }).render(width);

			for (const rows of [breathing, motionOff, disabled]) {
				expect(rows).toHaveLength(3); // 2 border rows + 1 enabled segment (detailed mode)
				for (const row of rows) expect(row.length).toBe(width);
			}
		}
	});
});

describe("AnimationsBoxWidget — bounded Agent Bonsai height (mg5.4)", () => {
	/**
	 * One main plus eight subagents — one over MAX_BONSAI_ROWS. Every subagent
	 * carries both an activity step and a provenance event so an unbounded
	 * renderer would spend 3 rows per node; the last-created subagent is the
	 * one `buildAgentBonsai` pushes past the cap, and it is the one carrying
	 * the error, so it doubles as the "never silently drop a failure" case.
	 */
	function nineAgentSnapshot(): AgentBonsaiSnapshot {
		const refs: AgentBonsaiRef[] = [
			{ id: "main", displayName: "Main", kind: "main", status: "running", createdAt: 0 },
		];
		const activitySteps = new Map<
			string,
			readonly { id: string; kind: "tool"; label: string; status: "active"; startedAt: number }[]
		>();
		const provenance = new Map<
			string,
			readonly { id: string; kind: "skill"; label: string; status: "active"; startedAt: number }[]
		>();
		for (let index = 1; index <= 8; index++) {
			const id = `sub${index}`;
			const status = index === 8 ? "aborted" : "running";
			refs.push({ id, displayName: `worker-${index}`, kind: "sub", parentId: "main", status, createdAt: index });
			activitySteps.set(id, [
				{ id: `${id}-act`, kind: "tool", label: `tool-${index}`, status: "active", startedAt: index },
			]);
			provenance.set(id, [
				{ id: `${id}-prov`, kind: "skill", label: `skill-${index}`, status: "active", startedAt: index },
			]);
		}
		// buildAgentBonsai only renders a parked/aborted subagent that was actually
		// observed at least once — mark every subagent seen so the aborted one
		// (sub8) participates in the cap instead of being silently excluded
		// upstream of it.
		const seen = new Set(refs.map(ref => ref.id));
		const caches: AgentBonsaiCaches = { activitySteps, provenance, seen };
		return buildAgentBonsai(refs, caches);
	}

	it("caps visible nodes at MAX_BONSAI_ROWS and names the dropped, aborted agent in the omitted line", () => {
		const snapshot = nineAgentSnapshot();
		expect(snapshot.nodes.length).toBeLessThanOrEqual(MAX_BONSAI_ROWS);
		expect(snapshot.hiddenCount).toBe(1);
		expect(snapshot.hiddenAgentIds).toEqual(["worker-8"]);

		for (const detail of ["detailed", "simple"] as const) {
			for (const width of [45, 69, 120]) {
				const rows = makeWidget({ samples: [ACTIVE], detail, agentBonsai: snapshot }).render(width);
				const text = rows.join("\n");
				expect(text).toContain("worker-8");
			}
		}
	});

	it("keeps total height strictly below the unbounded per-node-3-row baseline, in both modes at 45/69/120", () => {
		const snapshot = nineAgentSnapshot();
		// Unbounded would render 3 lines (main + activity + provenance) for each
		// of the up to 8 visible nodes, plus a header and a separator: an upper
		// bound no bounded render should reach regardless of width.
		const unboundedCeiling = snapshot.nodes.length * 3 + 2;

		for (const detail of ["detailed", "simple"] as const) {
			for (const width of [45, 69, 120]) {
				const first = makeWidget({ samples: [ACTIVE], detail, agentBonsai: snapshot }).render(width);
				const second = makeWidget({ samples: [ACTIVE], detail, agentBonsai: snapshot }).render(width);
				expect(first.length).toBeLessThan(unboundedCeiling);
				// Identical input renders identical row counts across repeated frames — no jitter.
				expect(second).toHaveLength(first.length);
			}
		}
	});

	it("simple mode never adds activity or provenance sub-rows, even for the detail-eligible nodes", () => {
		const snapshot = nineAgentSnapshot();
		const rows = makeWidget({ samples: [ACTIVE], detail: "simple", agentBonsai: snapshot }).render(69);
		const text = rows.join("\n");
		for (let index = 1; index <= 7; index++) {
			expect(text).not.toContain(`tool-${index}`);
			expect(text).not.toContain(`skill-${index}`);
		}
	});

	it("detailed mode budgets activity/provenance sub-rows to at most MAX_BONSAI_DETAIL_ROWS nodes", () => {
		const snapshot = nineAgentSnapshot();
		const rows = makeWidget({ samples: [ACTIVE], detail: "detailed", agentBonsai: snapshot }).render(120);
		const text = rows.join("\n");
		const nodesWithActivityRow = [1, 2, 3, 4, 5, 6, 7].filter(index => text.includes(`tool-${index}`));
		expect(nodesWithActivityRow.length).toBeLessThanOrEqual(3);
	});
});
