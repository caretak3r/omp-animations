/**
 * Animations Box — full-box golden frames, status-line fixture goldens,
 * height stability, and the degradation ladder (Plan 017 Decision 5 +
 * Plan 018 status lines). Per-builder span/variant assertions live in
 * `animations-box-segments.test.ts`; per-mode geometry/border assertions
 * live in `animations-box-widget.test.ts`. This file is the
 * composition-level contract: rendered facts, row ordering and geometry at the
 * real pane width (69), narrow (45), and wide (120), driven through the
 * real controller pipeline end to end; status and change-flash behavior; plus the
 * invariants that make the fixed-height design actually hold.
 */
import { describe, expect, it } from "bun:test";
import type {
	ExtensionWidgetContent,
	ExtensionWidgetOptions,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import type {
	AfterProviderResponseEvent,
	ContextUsage,
	MessageEndEvent,
	MessageStartEvent,
	ToolCallEvent,
	ToolResultEvent,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { visibleWidth } from "@oh-my-pi/pi-tui";
import { ContextGaugeState } from "../src/animations-box/context-gauge";
import { type AnimationsBoxContext, AnimationsBoxController } from "../src/animations-box/controller";
import {
	buildAuditTrailBoxSegment,
	buildCacheMeterSegment,
	buildContextGaugeSegment,
	buildRateLimitTidepoolSegment,
	buildToolActivitySegment,
	type SegmentSample,
} from "../src/animations-box/segments";
import {
	BOX_REQUIRED_SEGMENT_IDS,
	BOX_SEGMENT_IDS,
	type BoxDetail,
	type BoxSegmentId,
	resolveAnimationsBoxConfig,
} from "../src/animations-box/settings";
import {
	FlashTracker,
	FULL_FLASH_BOLD_MS,
	FULL_FLASH_MS,
	renderStatusLine,
	STATUS_LINE_PREFIX_COLS,
	type StatusLineContext,
} from "../src/animations-box/status-line";
import { ToolActivityState } from "../src/animations-box/tool-activity";
import { AnimationsBoxWidget, BOX_BORDER_COLS, BOX_BORDER_ROWS } from "../src/animations-box/widget";
import { AuditLedgerState, POISON_STREAK_TICKS } from "../src/audit-trail-box";
import { CacheMeterState } from "../src/cache-meter";
import { AnimationHost, composeSegments, type FrameScheduler, MotionPolicy, segment } from "../src/kit";
import { buildLiveFilesSegment, LiveFilesState } from "../src/live-files";
import { RateLimitTidepoolState } from "../src/rate-limit-tidepool";

// Identity theme so goldens pin plain text instead of ANSI escapes.
const idTheme = { fg: (_color: string, text: string) => text };
const noopTui = { requestComponentRender: () => {} };
const fullEnv = { hasUI: true, isTTY: true, env: {} as Record<string, string | undefined> };

/** Manual frame scheduler: deterministic `now()`, never ticks on its own — same convention every other test file in this package uses. */
function manualScheduler(): FrameScheduler & { advance(ms: number): void } {
	let current = 0;
	return {
		now: () => current,
		start: () => () => {},
		advance(ms) {
			current += ms;
		},
	};
}

interface SetWidgetCall {
	key: string;
	content: ExtensionWidgetContent;
	options?: ExtensionWidgetOptions;
}

/**
 * The host reading the full-box goldens are pinned against: a 200K window at
 * 120K used, which is 60% of the window and 75% of the default 80% quota —
 * far enough into the `warning` band to prove the row escalates on the host's
 * thresholds rather than on its own ceiling.
 */
const FULL_BOX_USAGE: ContextUsage = { tokens: 120_000, contextWindow: 200_000, percent: 60 };

/** Absent `usage`, `getContextUsage()` reports nothing and the gauge holds its resting row. */
function recordingContext(usage?: ContextUsage): { ctx: AnimationsBoxContext; calls: SetWidgetCall[] } {
	const calls: SetWidgetCall[] = [];
	const ctx: AnimationsBoxContext = {
		hasUI: true,
		isTTY: true,
		env: {},
		cwd: "/repo",
		glyphPreset: "unicode",
		getContextUsage: () => usage,
		setWidget: (key, content, options) => {
			calls.push({ key, content, options });
		},
	};
	return { ctx, calls };
}

function buildWidget(call: SetWidgetCall): AnimationsBoxWidget {
	const factory = call.content as (tui: unknown, theme: unknown) => AnimationsBoxWidget;
	return factory(noopTui, idTheme);
}

/** Mount a controller under `rawConfig` and hand back its live widget — no events driven, for height-only assertions. */
function mountedWidget(rawConfig: Record<string, unknown>): AnimationsBoxWidget {
	const { ctx, calls } = recordingContext();
	const controller = new AnimationsBoxController({
		scheduler: manualScheduler(),
		initialConfig: resolveAnimationsBoxConfig(rawConfig),
	});
	controller.mount(ctx);
	return buildWidget(calls[0] as SetWidgetCall);
}

// ---------------------------------------------------------------------------
// Real-pipeline fixtures — the events that drive a representative "5 of 7
// segments active" scene (Decision 5's own detailed-mode mock), and the
// directly-constructed *State instances used where a golden needs "every
// segment active" without a full event choreography (the degradation-ladder
// and height-stability sections below). Both routes call the same exported
// segment builders `segments.ts` itself calls — never hand-rolled SegmentSamples.
// ---------------------------------------------------------------------------

function messageEnd(usage: {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
}): MessageEndEvent {
	return {
		type: "message_end",
		message: {
			role: "assistant",
			content: [],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude",
			usage,
			stopReason: "stop",
			timestamp: 0,
		},
	} as unknown as MessageEndEvent;
}

function assistantMessageStart(output: number, duration: number): MessageStartEvent {
	return {
		type: "message_start",
		message: {
			role: "assistant",
			content: [],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude",
			usage: { input: 0, output, cacheRead: 0, cacheWrite: 0, totalTokens: output },
			stopReason: undefined,
			timestamp: 0,
			duration,
		},
	} as unknown as MessageStartEvent;
}

function readResult(path: string): ToolResultEvent {
	return {
		type: "tool_result",
		toolCallId: "tc-read",
		toolName: "read",
		input: { path },
		content: [],
		isError: false,
		details: { resolvedPath: path },
	} as unknown as ToolResultEvent;
}

function writeResult(path: string): ToolResultEvent {
	return {
		type: "tool_result",
		toolCallId: "tc-write",
		toolName: "write",
		input: { path, content: "hello" },
		content: [],
		isError: false,
		details: undefined,
	} as unknown as ToolResultEvent;
}

function anthropicHeaders(limit: number, remaining: number, resetAtMs: number): Record<string, string> {
	return {
		"anthropic-ratelimit-requests-limit": String(limit),
		"anthropic-ratelimit-requests-remaining": String(remaining),
		"anthropic-ratelimit-requests-reset": new Date(resetAtMs).toISOString(),
	};
}

function afterProviderResponse(headers: Record<string, string>, status = 200): AfterProviderResponseEvent {
	return { type: "after_provider_response", status, headers } as unknown as AfterProviderResponseEvent;
}

function toolCall(toolName: string, toolCallId: string): ToolCallEvent {
	return { type: "tool_call", toolCallId, toolName, input: {} } as unknown as ToolCallEvent;
}

/**
 * Drive the controller through its real event handlers and one scheduler tick
 * to build a representative scene. Context, cache, audit, limits, and tools
 * are active. Live Files stays idle.
 */
function driveFullBox(detail: BoxDetail): AnimationsBoxWidget {
	const scheduler = manualScheduler();
	const { ctx, calls } = recordingContext(FULL_BOX_USAGE);
	const controller = new AnimationsBoxController({
		scheduler,
		initialConfig: resolveAnimationsBoxConfig({ animationsBoxDetail: detail }),
	});
	controller.mount(ctx);
	const widget = buildWidget(calls[0] as SetWidgetCall);

	controller.onMessageEnd(
		messageEnd({ input: 400, output: 10, cacheRead: 600, cacheWrite: 200, totalTokens: 1210 }),
		ctx,
	);
	controller.onMessageStart(assistantMessageStart(100, 1000), ctx);
	controller.onToolResult(readResult("src/widget.ts"), ctx);
	controller.onToolResult(writeResult("src/widget.ts"), ctx);
	controller.onAfterProviderResponse(afterProviderResponse(anthropicHeaders(100, 78, 725_000)), ctx);
	controller.onMessageStart(assistantMessageStart(50, 500), ctx); // reveals the provider to tidepool's pending headers
	controller.onToolCall(toolCall("write", "tc-1"), ctx);
	controller.onToolCall(toolCall("read", "tc-2"), ctx);
	controller.onToolCall(toolCall("bash", "tc-3"), ctx); // the one non-file call: the tools row's whole breakdown

	// Drive the real per-frame pipeline once before capturing the widget.
	scheduler.advance(50);
	widget.onFrame(0);

	return widget;
}

/** One fresh, idle `*State` per segment, in grouped priority order — every segment resting. */
function restingSamples(): SegmentSample[] {
	return [
		buildContextGaugeSegment(new ContextGaugeState(), 0, idTheme),
		buildCacheMeterSegment(new CacheMeterState(), 0, idTheme),
		buildAuditTrailBoxSegment(new AuditLedgerState(), 0, idTheme),
		buildRateLimitTidepoolSegment(new RateLimitTidepoolState(), 0, idTheme),
		buildToolActivitySegment(new ToolActivityState(), 0, idTheme),
		buildLiveFilesSegment(new LiveFilesState(), BOX_SEGMENT_IDS.indexOf("filesLive") + 1),
	];
}

/** One warmed, active `*State` per segment, in grouped priority order — every segment active at once. */
function activeSamples(): SegmentSample[] {
	const cacheMeterState = new CacheMeterState();
	cacheMeterState.recordUsage({
		provider: "anthropic",
		model: "claude",
		usage: { input: 400, output: 10, cacheRead: 600, cacheWrite: 200, totalTokens: 1210 },
	});

	const auditState = new AuditLedgerState();
	auditState.noteRead("/repo/src/widget.ts");
	auditState.noteWrite("/repo/src/widget.ts", 0);

	const tidepoolState = new RateLimitTidepoolState();
	tidepoolState.applySample({
		provider: "anthropic",
		family: "anthropic",
		level: 0.78,
		resetAtMs: 725_000,
		observedAtMs: 0,
	});

	const toolActivityState = new ToolActivityState();
	toolActivityState.record("write");
	toolActivityState.record("bash");

	const liveFilesState = new LiveFilesState(() => 0);
	liveFilesState.onToolCall({ toolCallId: "edit-1", toolName: "edit", input: { path: "/repo/src/foo.ts" } }, "/repo");

	// Two growing turns are the minimum that publishes a burn rate, so the
	// active gauge carries its full span ladder including the turn forecast.
	const contextGaugeState = new ContextGaugeState();
	contextGaugeState.observe({ tokens: 100_000, contextWindow: 200_000, percent: 50 });
	contextGaugeState.noteTurn();
	contextGaugeState.observe({ tokens: 110_000, contextWindow: 200_000, percent: 55 });
	contextGaugeState.noteTurn();
	contextGaugeState.observe(FULL_BOX_USAGE);
	contextGaugeState.noteTurn();

	return [
		buildContextGaugeSegment(contextGaugeState, 0, idTheme),
		buildCacheMeterSegment(cacheMeterState, 0, idTheme),
		buildAuditTrailBoxSegment(auditState, 0, idTheme),
		buildRateLimitTidepoolSegment(tidepoolState, 0, idTheme, undefined, undefined, {
			okCount: 1,
			lastStatus: 200,
			troubleCounts: {},
			lastTrouble: undefined,
		}),
		buildToolActivitySegment(toolActivityState, 0, idTheme),
		buildLiveFilesSegment(liveFilesState, BOX_SEGMENT_IDS.indexOf("filesLive") + 1),
	];
}

function heightSamples(active: boolean): SegmentSample[] {
	return [
		...(active ? activeSamples() : restingSamples()),
		{
			id: "optionalA",
			priority: 7,
			active,
			variants: active ? ["OPTIONAL DETAIL", "OPTIONAL"] : [],
			line: {
				dot: active ? "live" : "idle",
				label: "opt-a",
				accent: "dim",
				spans: [{ key: "value", text: active ? "active" : "—" }],
			},
		},
	];
}

function makeWidget(samples: readonly SegmentSample[], detail: BoxDetail): AnimationsBoxWidget {
	const scheduler = manualScheduler();
	const policy = new MotionPolicy(fullEnv, "full");
	const host = new AnimationHost({ policy, scheduler });
	const groups = {
		required: samples.slice(0, BOX_REQUIRED_SEGMENT_IDS.length),
		optional: samples.slice(BOX_REQUIRED_SEGMENT_IDS.length),
	};
	return new AnimationsBoxWidget({
		tui: noopTui,
		host,
		policy,
		theme: idTheme,
		clock: scheduler,
		onTick: () => {},
		buildSampleGroups: () => groups,
		getDetail: () => detail,
		getBorderFrame: () => undefined,
	});
}

// ---------------------------------------------------------------------------
// 1. Full-box golden frames
// ---------------------------------------------------------------------------

describe("AnimationsBoxController + AnimationsBoxWidget — full-box frames (Decision 5)", () => {
	function expectBox(rows: readonly string[], width: number, contentRows: number): void {
		expect(rows).toHaveLength(contentRows + BOX_BORDER_ROWS);
		expect(rows[0]).toBe(`┌${"─".repeat(width - 2)}┐`);
		expect(rows.at(-1)).toBe(`└${"─".repeat(width - 2)}┘`);
		for (const row of rows.slice(1, -1)) {
			expect(row.startsWith("│ ")).toBe(true);
			expect(row.endsWith(" │")).toBe(true);
			expect(visibleWidth(row)).toBe(width);
		}
	}

	it("detailed mode keeps six ordered required rows and sheds optional metric detail", () => {
		const widget = driveFullBox("detailed");
		for (const width of [45, 69, 120]) {
			const rows = widget.renderFrame(width);
			expectBox(rows, width, 6);
			expect(rows.slice(1, -1).map(row => row.trim().split(/\s+/)[2])).toEqual([
				"context",
				"cache",
				"audit",
				"limits",
				"tools",
				"files",
			]);
			expect(rows[1]).toContain("[████████░░]");
			expect(rows[1]).toContain("75% budget");
			expect(rows[2]).toMatch(/50%.*recent.*token.*reuse/);
			expect(rows[3]).toContain("1 read");
			expect(rows[3]).toContain("1 write");
			expect(rows[3]).toContain("1 edited");
			// Health-first limits row shows "http 200" at all widths, tidepool quota is wide-only
			expect(rows[4]).toContain("http 200");
			if (width >= 69) {
				expect(rows[4]).toContain("78% left");
				expect(rows[4]).toContain("resets 12m");
			}
			expect(rows[6]).toMatch(/○\s+files\s+—/);
			if (width >= 69) {
				expect(rows[1]).toContain("120K/200K window");
				expect(rows[3]).toContain("widget.ts");
			} else {
				expect(rows[1]).not.toContain("120K/200K");
				expect(rows[3]).not.toContain("widget.ts");
			}
			if (width === 120) {
				expect(rows[2]).toMatch(/1\/1.*session.*requests.*reuse/);
				expect(rows[2]).toContain("400 uncached");
				expect(rows[2]).toContain("600 reused");
				expect(rows[2]).toContain("200 stored");
			} else {
				expect(rows[2]).not.toContain("1/1");
			}
		}
		widget.dispose();
	});

	it("simple mode keeps budget, reuse and rate-limit measurements in priority order at every width", () => {
		const widget = driveFullBox("simple");
		for (const width of [45, 69, 120]) {
			const rows = widget.renderFrame(width);
			expectBox(rows, width, 1);
			const summary = rows[1] as string;
			expect(summary).toContain("75% budget");
			expect(summary).toMatch(/(?:50%.*reuse|reuse 50%)/);
			expect(summary).toContain("1✎\uFE0E");
			// Health-first: check priority order for context, cache, audit, tools
			expect(summary.indexOf("75%")).toBeLessThan(summary.indexOf("50%"));
			expect(summary.indexOf("50%")).toBeLessThan(summary.indexOf("1✎\uFE0E"));
			if (width >= 69) {
				expect(summary).toContain("[████████░░]");
				expect(summary).toContain("3 calls");
			} else {
				expect(summary).not.toContain("[");
				expect(summary).not.toContain("3 calls");
			}
		}
		widget.dispose();
	});

	it("every rendered row's visibleWidth equals the literal target width — no overflow, no underflow, both modes, all three widths", () => {
		for (const detail of ["detailed", "simple"] as const) {
			const widget = driveFullBox(detail);
			for (const width of [69, 45, 120]) {
				for (const row of widget.renderFrame(width)) expect(visibleWidth(row)).toBe(width);
			}
			widget.dispose();
		}
	});
});

// ---------------------------------------------------------------------------
// 2. Status-line fixture goldens (Plan 018 §3 forms)
// ---------------------------------------------------------------------------

/** The spec's own 78-col inner width — §3's fixture lines are pinned verbatim at it. */
const SPEC_INNER = 78;

/** Hermetic renderer context — explicit tier fields so goldens hold under any local terminal. */
function lineCtx(overrides: Partial<StatusLineContext> = {}): StatusLineContext {
	return {
		theme: idTheme,
		preset: "unicode",
		colorMode: "basic",
		program: "other",
		segmentId: "test",
		now: 0,
		flashTier: "off",
		...overrides,
	};
}

describe("renderStatusLine — §3 fixture goldens at the spec's 78-col inner width (Plan 018)", () => {
	it("a sustained cold workload reports an observation, never provider capability", () => {
		const state = new CacheMeterState();
		for (let i = 0; i < 8; i++) {
			state.recordUsage({
				provider: "ollama",
				model: "gpt-oss",
				usage: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 110 },
			});
		}
		const { line } = buildCacheMeterSegment(state, 0, idTheme);
		const rendered = renderStatusLine(line, SPEC_INNER, lineCtx());
		expect(rendered).toMatch(/^○\s+cache\s+.*no reuse.*observed/);
		expect(rendered).not.toMatch(/provider|unsupported|unavailable|never caches|no caching|\d/);
	});

	it("idle form: an untouched segment renders the lone dim em-dash under the idle dot", () => {
		const { line } = buildLiveFilesSegment(new LiveFilesState(), 1);
		expect(renderStatusLine(line, SPEC_INNER, lineCtx())).toBe("○  files    —");
	});

	it("pulses an active row without moving any cells", () => {
		const theme = {
			fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
			bold: (text: string) => `<b>${text}</b>`,
		};
		const line = {
			dot: "live" as const,
			label: "tools",
			accent: "syntaxFunction" as const,
			activity: true,
			spans: [{ key: "active", text: "bash" }],
		};
		const crest = renderStatusLine(line, SPEC_INNER, lineCtx({ theme, now: 0, flashTier: "full" }));
		const rest = renderStatusLine(line, SPEC_INNER, lineCtx({ theme, now: 800, flashTier: "full" }));
		expect(crest).toContain("<b><syntaxFunction>bash</syntaxFunction></b>");
		expect(rest).not.toContain("<syntaxFunction>bash</syntaxFunction>");
		const stripTags = (text: string): string => text.replaceAll(/<[^>]+>/g, "");
		expect(stripTags(crest)).toBe(stripTags(rest));
	});

	it("notable form: an agent-edited file stays in one evenly spaced phrase", () => {
		const state = new AuditLedgerState();
		state.noteRead("/repo/src/widget.ts");
		state.noteWrite("/repo/src/widget.ts", 0);
		const { line } = buildAuditTrailBoxSegment(state, 0, idTheme);
		const rendered = renderStatusLine(line, SPEC_INNER, lineCtx());
		expect(rendered).toMatch(/^◐\s+audit/);
		expect(rendered.split(" · ").slice(1)).toEqual(["1 write", "1 edited", "last widget.ts"]);
		expect(rendered).toContain("1 read · ");
	});

	it("alert form: an on-disk divergence escalates to the alert dot with the poisoned span beside it", () => {
		const state = new AuditLedgerState();
		state.noteRead("/repo/src/read.log", { hash: "h1" });
		const reading = { path: "/repo/src/read.log", hash: "h2", reachable: true };
		for (let tick = 0; tick < POISON_STREAK_TICKS; tick++) state.noteProbe([reading], 10_000 + tick * 1000);
		const { line } = buildAuditTrailBoxSegment(state, 20_000, idTheme);
		const rendered = renderStatusLine(line, SPEC_INNER, lineCtx({ now: 20_000 }));
		expect(rendered).toMatch(/^●\s+audit/);
		expect(rendered).toContain("1 changed on disk");
		expect(rendered.indexOf("1 changed on disk")).toBeLessThan(rendered.indexOf("read.log"));
	});
});

describe("renderStatusLine — no required row ever draws a label with a blank value column (daw.1)", () => {
	// STATUS_LINE_PREFIX_COLS(12) + BOX_BORDER_COLS(4) is the smallest total
	// box width where the phrase budget (`available`) is still positive — the
	// prefix-only fallback below that floor is a documented, width-shared
	// degradation (every row loses its value at once), not a per-row defect.
	// Above that floor every row is still individually responsible for
	// drawing a value, which is what this reproduces daw.1's "files/audit
	// rendered its label with nothing beside it while every other row in the
	// same 200-col frame kept its value" report against.
	const MIN_INNER_WITH_VALUE = STATUS_LINE_PREFIX_COLS + 1;

	it("every resting row keeps its dim '—' value at every width from the value floor to 200 cols", () => {
		for (const sample of restingSamples()) {
			for (let inner = MIN_INNER_WITH_VALUE; inner <= 200; inner++) {
				const rendered = renderStatusLine(sample.line, inner, lineCtx({ segmentId: sample.id }));
				expect(rendered.slice(STATUS_LINE_PREFIX_COLS).trim().length).toBeGreaterThan(0);
			}
		}
	});

	it("every active row keeps a non-blank value at every width from the value floor to 200 cols", () => {
		for (const sample of activeSamples()) {
			for (let inner = MIN_INNER_WITH_VALUE; inner <= 200; inner++) {
				const rendered = renderStatusLine(sample.line, inner, lineCtx({ segmentId: sample.id }));
				expect(rendered.slice(STATUS_LINE_PREFIX_COLS).trim().length).toBeGreaterThan(0);
			}
		}
	});

	it("a sub-threshold single file touch renders audit's active line and files' resting '—', neither blank", () => {
		const auditState = new AuditLedgerState();
		auditState.noteRead("/repo/src/widget.ts");
		const auditLine = buildAuditTrailBoxSegment(auditState, 0, idTheme).line;
		const filesLine = buildLiveFilesSegment(new LiveFilesState(), 1).line;
		for (const width of [45, 69, 120, 200]) {
			const auditRendered = renderStatusLine(auditLine, width - 4, lineCtx({ segmentId: "auditTrailBox" }));
			const filesRendered = renderStatusLine(filesLine, width - 4, lineCtx({ segmentId: "filesLive" }));
			expect(auditRendered.slice(STATUS_LINE_PREFIX_COLS).trim().length).toBeGreaterThan(0);
			expect(filesRendered.slice(STATUS_LINE_PREFIX_COLS).trim()).toBe("—");
		}
	});
});

describe("renderStatusLine — context bars stay whole at every width", () => {
	it.each(["ascii", "unicode"] as const)("%s keeps the percentage when the fixed bar cannot fit", preset => {
		const readings = [
			{ percent: 40, used: "64K", bar: preset === "ascii" ? "[####------]" : "[████░░░░░░]" },
			{ percent: 95, used: "152K", bar: preset === "ascii" ? "[##########]" : "[██████████]" },
		].map(reading => {
			const state = new ContextGaugeState();
			state.observe({ tokens: 1600 * reading.percent, contextWindow: 200_000, percent: reading.percent * 0.8 });
			return { ...reading, line: buildContextGaugeSegment(state, 0, idTheme, preset).line };
		});
		const ctx = lineCtx({ preset });

		for (let width = 1; width <= 120; width++) {
			const phrases = readings.map(({ line, bar, percent }) => {
				const rendered = renderStatusLine(line, width, ctx);
				const phrase = rendered.slice(STATUS_LINE_PREFIX_COLS);
				expect(visibleWidth(rendered)).toBeLessThanOrEqual(width);
				if (phrase.includes("[")) {
					expect(phrase).toStartWith(`${bar} ${percent}% budget`);
				}
				expect(phrase.replace(bar, "")).not.toMatch(/[[\]█░#-]/);
				if (width >= STATUS_LINE_PREFIX_COLS + 4) expect(phrase).toContain(`${percent}%`);
				else if (width === STATUS_LINE_PREFIX_COLS + 3) expect(phrase).toBe(`${percent}…`);
				else if (width === STATUS_LINE_PREFIX_COLS + 2) expect(phrase).toBe(`${String(percent)[0]}…`);
				if (width < STATUS_LINE_PREFIX_COLS + 12 + 1 + "40% budget".length) {
					expect(phrase).not.toContain("[");
				}
				return phrase;
			});
			// Twelve prefix cells plus a digit and the truncation ellipsis is the first distinguishable width.
			if (width >= STATUS_LINE_PREFIX_COLS + 2) expect(phrases[0]).not.toBe(phrases[1]);
			else expect(phrases[0]).toBe(phrases[1]);
		}

		for (const { line, bar, percent, used } of readings) {
			expect(renderStatusLine(line, 120, ctx).slice(STATUS_LINE_PREFIX_COLS)).toBe(
				`${bar} ${percent}% budget · ${used}/200K window`,
			);
		}
	});

	it("drops an oversized fixed graphic before its fallback, but keeps normal priority when it fits", () => {
		const line = {
			dot: "live" as const,
			label: "quota",
			accent: "accent" as const,
			spans: [
				{ key: "rail", text: "[####------]", neverTruncate: true },
				{ key: "reading", text: "40%" },
			],
		};
		expect(renderStatusLine(line, 23, lineCtx()).slice(STATUS_LINE_PREFIX_COLS)).toBe("40%");
		expect(renderStatusLine(line, 24, lineCtx()).slice(STATUS_LINE_PREFIX_COLS)).toBe("[####------]");
		expect(
			renderStatusLine({ ...line, spans: line.spans.slice(0, 1) }, 23, lineCtx()).slice(STATUS_LINE_PREFIX_COLS),
		).toBe("");
	});

	it("observes changes to a dropped bar so widening does not restart its flash", () => {
		const state = new ContextGaugeState();
		const flash = new FlashTracker();
		const theme = {
			fg: (color: string, text: string) => `<${color}:${text}>`,
			bold: (text: string) => `«${text}»`,
		};
		const ctxAt = (now: number) => lineCtx({ theme, flash, now, flashTier: "full", segmentId: "contextGauge" });
		state.observe({ tokens: 64_000, contextWindow: 200_000, percent: 32 });
		renderStatusLine(buildContextGaugeSegment(state, 0, theme).line, 120, ctxAt(0));
		state.observe({ tokens: 152_000, contextWindow: 200_000, percent: 76 });
		const changed = buildContextGaugeSegment(state, 1000, theme).line;
		const narrow = renderStatusLine(changed, 22, ctxAt(1000));
		expect(narrow).toMatch(/«<[^:>]+:95% budget>»/u);
		expect(narrow).not.toContain("[");
		const widened = renderStatusLine(changed, 120, ctxAt(1000 + FULL_FLASH_MS));
		expect(widened).toContain("[██████████]");
		expect(widened).not.toContain("«");
	});
});

describe("renderStatusLine — the cache row's width ladder (buv.2: one row carries the whole ledger)", () => {
	function warmedLine() {
		const state = new CacheMeterState();
		state.recordUsage({
			provider: "anthropic",
			model: "claude",
			usage: { input: 400, output: 10, cacheRead: 600, cacheWrite: 200, totalTokens: 1210 },
		});
		return buildCacheMeterSegment(state, 0, idTheme).line;
	}

	it("sheds complete trailing ledger spans before losing the recent reuse measurement", () => {
		const line = warmedLine();
		const wide = renderStatusLine(line, 120, lineCtx());
		expect(wide).toMatch(/50%.*recent.*token.*reuse/);
		expect(wide).toMatch(/1\/1.*session.*requests.*reuse/);
		expect(wide).toContain("400 uncached");
		expect(wide).toContain("600 reused");
		expect(wide).toContain("200 stored");
		const wideSpans = wide.split(" · ");
		for (const width of [120, 110, 100, 90, 78, 70, 62, 55, 50, 44, 39]) {
			const rendered = renderStatusLine(line, width, lineCtx());
			const spans = rendered.split(" · ");
			expect(visibleWidth(rendered)).toBeLessThanOrEqual(width);
			expect(spans).toEqual(wideSpans.slice(0, spans.length));
			expect(rendered).toMatch(/50%.*recent.*token.*reuse/);
		}
		expect(renderStatusLine(line, 78, lineCtx()).split(" · ")).toHaveLength(2);
		expect(renderStatusLine(line, 39, lineCtx()).split(" · ")).toHaveLength(1);
	});

	it("hard-truncates only the final span, retaining the percentage while it fits", () => {
		const line = warmedLine();
		for (const width of [30, 24, 18]) {
			const rendered = renderStatusLine(line, width, lineCtx());
			expect(visibleWidth(rendered)).toBeLessThanOrEqual(width);
			expect(rendered).toContain("50%");
			expect(rendered).toEndWith("…");
			expect(rendered).not.toContain(" · ");
			expect(rendered).not.toContain("1/1");
		}
	});
});

describe("renderStatusLine + FlashTracker — change-flash frame goldens (D6: flash decays and stops)", () => {
	// Tagging double: `fg` and `bold` leave visible markers so the goldens pin
	// exactly which spans sit in which flash phase at each instant.
	const tagTheme = {
		fg: (color: string, text: string) => `<${color}:${text}>`,
		bold: (text: string) => `«${text}»`,
	};

	it("a changed span walks bold+accent → accent → rest across one full-tier decay; the first observation never flashes", () => {
		const tracker = new FlashTracker();
		const state = new CacheMeterState();
		const ctxAt = (now: number) =>
			lineCtx({ theme: tagTheme, segmentId: "cacheMeter", flashTier: "full", flash: tracker, now });

		state.recordUsage({
			provider: "anthropic",
			model: "claude",
			usage: { input: 400, output: 10, cacheRead: 600, cacheWrite: 200, totalTokens: 1210 },
		});
		const baseline = renderStatusLine(buildCacheMeterSegment(state, 0, tagTheme).line, 120, ctxAt(0));
		expect(baseline).toMatch(/<success:50%.*recent.*token.*reuse>/);
		expect(baseline).not.toContain("«");
		expect(baseline).not.toMatch(/<accent:(?:50%|1\/1|600)/);
		expect(baseline).toMatch(/1\/1.*session.*requests.*reuse/);

		// A second cached request changes the recent ratio and session counters,
		// but not uncached or stored tokens.
		state.recordUsage({
			provider: "anthropic",
			model: "claude",
			usage: { input: 0, output: 10, cacheRead: 1000, cacheWrite: 0, totalTokens: 1010 },
		});
		const changed = buildCacheMeterSegment(state, 5000, tagTheme).line;
		const bold = renderStatusLine(changed, 120, ctxAt(5000));
		const accent = renderStatusLine(changed, 120, ctxAt(5000 + FULL_FLASH_BOLD_MS));
		const rest = renderStatusLine(changed, 120, ctxAt(5000 + FULL_FLASH_MS));
		expect(bold).toMatch(/«<accent:75%.*recent.*token.*reuse>»/);
		expect(bold).toMatch(/«<accent:2\/2.*session.*requests.*reuse>»/);
		expect(bold).toContain("«<accent:1.6K reused>»");
		expect(accent).toMatch(/<accent:75%.*recent.*token.*reuse>/);
		expect(accent).toMatch(/<accent:2\/2.*session.*requests.*reuse>/);
		expect(accent).toContain("<accent:1.6K reused>");
		expect(accent).not.toContain("«");
		expect(rest).toMatch(/<success:75%.*recent.*token.*reuse>/);
		expect(rest).not.toContain("«");
		expect(rest).not.toMatch(/<accent:(?:75%|2\/2|1\.6K)/);
		const plain = (text: string): string => text.replaceAll(/<[^:>]+:([^>]*)>/g, "$1").replaceAll(/[«»]/g, "");
		for (const frame of [bold, accent, rest]) {
			expect(frame).toContain(" · 400 uncached · ");
			expect(frame).toEndWith(" · 200 stored");
			expect(plain(frame)).toBe(plain(rest));
			expect(visibleWidth(plain(frame))).toBeLessThanOrEqual(120);
			expect(visibleWidth(plain(frame))).toBe(visibleWidth(plain(rest)));
		}
	});
});

// ---------------------------------------------------------------------------
// 3. Height stability
// ---------------------------------------------------------------------------

const SAMPLE_IDS = [
	"contextGauge",
	"cacheMeter",
	"auditTrailBox",
	"rateLimitTidepool",
	"toolActivity",
	"filesLive",
] as const satisfies readonly BoxSegmentId[];

describe("AnimationsBoxWidget — height stability under runtime activation (Decision 5)", () => {
	it("toggling any single segment active vs resting never changes row count, in either detail mode", () => {
		for (const detail of ["detailed", "simple"] as const) {
			const baseline = makeWidget(heightSamples(false), detail).render(69).length;
			const active = heightSamples(true);
			for (let i = 0; i < active.length; i++) {
				const toggled = heightSamples(false);
				toggled[i] = active[i] as SegmentSample;
				expect(makeWidget(toggled, detail).render(69).length).toBe(baseline);
			}
		}
	});

	it("all required and optional segments active still matches the all-resting row count in either detail mode", () => {
		for (const detail of ["detailed", "simple"] as const) {
			const restingCount = makeWidget(heightSamples(false), detail).render(69).length;
			const activeCount = makeWidget(heightSamples(true), detail).render(69).length;
			expect(activeCount).toBe(restingCount);
		}
	});

	it("detailed mode includes one separator between the segment groups; simple mode remains one composed row", () => {
		expect(makeWidget(heightSamples(false), "detailed").render(69)).toHaveLength(
			BOX_BORDER_ROWS + SAMPLE_IDS.length + 2,
		);
		expect(makeWidget(heightSamples(false), "simple").render(69)).toHaveLength(BOX_BORDER_ROWS + 1);
	});
});

describe("AnimationsBoxController — config-driven height changes (Decision 5)", () => {
	function frameLength(rawConfig: Record<string, unknown>, width = 69): number {
		return mountedWidget(rawConfig).renderFrame(width).length;
	}

	it("keeps required-summary height fixed regardless of obsolete row toggles", () => {
		const baselineDetailed = frameLength({ animationsBoxDetail: "detailed" });
		expect(baselineDetailed).toBe(BOX_BORDER_ROWS + BOX_REQUIRED_SEGMENT_IDS.length);

		for (const id of BOX_REQUIRED_SEGMENT_IDS) {
			expect(frameLength({ animationsBoxDetail: "detailed", [id]: false })).toBe(baselineDetailed);
			expect(frameLength({ animationsBoxDetail: "detailed", [id]: true })).toBe(baselineDetailed);
		}
	});

	it("breathingBorder: false changes height not at all, in either detail mode — the border chrome remains, just uncolored", () => {
		expect(frameLength({ animationsBoxDetail: "detailed", breathingBorder: false })).toBe(
			frameLength({ animationsBoxDetail: "detailed" }),
		);
		expect(frameLength({ animationsBoxDetail: "simple", breathingBorder: false })).toBe(
			frameLength({ animationsBoxDetail: "simple" }),
		);
	});
});

// ---------------------------------------------------------------------------
// 4. Degradation ladder (simple mode, everything active)
// ---------------------------------------------------------------------------

describe("kit composeSegments — degradation ladder at 45/69/120 in simple mode, everything active (Decision 5)", () => {
	function priorityOf(id: BoxSegmentId): number {
		return BOX_SEGMENT_IDS.indexOf(id) + 1;
	}

	// Minimum widths with separators: first four = 35, first five = 45,
	// all six = 54. Borders leave budgets 41, 65 and 116.
	const LADDER: Record<number, readonly BoxSegmentId[]> = {
		45: SAMPLE_IDS.slice(0, 4),
		69: SAMPLE_IDS,
		120: SAMPLE_IDS,
	};

	it("keptIds match the literal expected ladder at each width, staying priority-ordered ascending", () => {
		const kitSegments = activeSamples().map(s => segment(s.id, s.priority, s.variants));
		for (const width of [69, 45, 120]) {
			const inner = width - BOX_BORDER_COLS;
			const { row, keptIds } = composeSegments(kitSegments, inner);
			expect(keptIds).toEqual(LADDER[width]);
			const priorities = keptIds.map(id => priorityOf(id as BoxSegmentId));
			expect(priorities).toEqual([...priorities].sort((a, b) => a - b));
			expect(visibleWidth(row)).toBeLessThanOrEqual(inner);
		}
	});

	it("retains rate-limit headroom after lower-priority segments shed", () => {
		const kitSegments = activeSamples().map(s => segment(s.id, s.priority, s.variants));
		const narrow = composeSegments(kitSegments, 45 - BOX_BORDER_COLS);
		expect(narrow.keptIds).toContain("rateLimitTidepool");
		// Health-first: narrow shows health, not tidepool quota
		expect(narrow.row).toContain("http 200");
		expect(narrow.row).toContain("reuse 50%");
		expect(narrow.keptIds).not.toContain("toolActivity");
		expect(narrow.keptIds).not.toContain("filesLive");
		const real = composeSegments(kitSegments, 69 - BOX_BORDER_COLS);
		expect(real.keptIds).toContain("filesLive");
	});
});
