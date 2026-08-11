/**
 * Animations Box — full-box golden frames, height stability, and the
 * degradation ladder (Plan 017 Decision 5). Per-builder text/column
 * assertions already live in `animations-box-segments.test.ts`; per-mode
 * geometry/border assertions already live in `animations-box-widget.test.ts`.
 * This file is the composition-level contract: literal rendered frames at
 * the maintainer's real pane width (69), narrow (45), and wide (120), driven
 * through the real controller pipeline end to end, plus the invariants that
 * make the fixed-height design actually hold.
 */
import { describe, expect, it } from "bun:test";
import type {
	ExtensionWidgetContent,
	ExtensionWidgetOptions,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import type {
	AfterProviderResponseEvent,
	MessageEndEvent,
	MessageStartEvent,
	ToolCallEvent,
	ToolResultEvent,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { visibleWidth } from "@oh-my-pi/pi-tui";
import { type AnimationsBoxContext, AnimationsBoxController } from "../src/animations-box/controller";
import {
	buildAuditTrailBoxSegment,
	buildCacheMeterSegment,
	buildCadenceEqualizerSegment,
	buildPalimpsestSegment,
	buildRateLimitTidepoolSegment,
	buildReflectionRippleSegment,
	buildToolConstellationSegment,
	type SegmentSample,
} from "../src/animations-box/segments";
import {
	BOX_SEGMENT_IDS,
	type BoxDetail,
	type BoxSegmentId,
	resolveAnimationsBoxConfig,
} from "../src/animations-box/settings";
import { AnimationsBoxWidget, BOX_BORDER_COLS, BOX_BORDER_ROWS } from "../src/animations-box/widget";
import { AuditLedgerState } from "../src/audit-trail-box";
import { CacheMeterState } from "../src/cache-meter";
import { CadenceEqualizerState } from "../src/cadence-equalizer";
import { AnimationHost, composeSegments, type FrameScheduler, MotionPolicy, segment } from "../src/kit";
import { PalimpsestState } from "../src/palimpsest";
import { RateLimitTidepoolState } from "../src/rate-limit-tidepool";
import { ReflectionRippleState } from "../src/reflection-ripple";
import { ConstellationState } from "../src/tool-constellation";

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

function recordingContext(): { ctx: AnimationsBoxContext; calls: SetWidgetCall[] } {
	const calls: SetWidgetCall[] = [];
	const ctx: AnimationsBoxContext = {
		hasUI: true,
		isTTY: true,
		env: {},
		cwd: "/repo",
		glyphPreset: "unicode",
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

function afterProviderResponse(headers: Record<string, string>): AfterProviderResponseEvent {
	return { type: "after_provider_response", headers } as unknown as AfterProviderResponseEvent;
}

function toolCall(toolName: string, toolCallId: string): ToolCallEvent {
	return { type: "tool_call", toolCallId, toolName, input: {} } as unknown as ToolCallEvent;
}

/**
 * Drive the controller through its real event handlers + one scheduler tick
 * to build a representative "5 of 7 active" scene: cache meter, cadence,
 * audit trail, rate-limit tidepool and tool constellation go active; palimpsest
 * and reflection ripple stay on their resting rows — matching Decision 5's own
 * detailed-mode mock's activation pattern.
 */
function driveFullBox(detail: BoxDetail): AnimationsBoxWidget {
	const scheduler = manualScheduler();
	const { ctx, calls } = recordingContext();
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

	// One tick so cadence's EMA bands step off zero — mirrors the real per-frame pipeline.
	scheduler.advance(50);
	widget.onFrame(0);

	return widget;
}

/** One fresh, idle `*State` per segment, in `BOX_SEGMENT_IDS` order — every segment resting. */
function restingSamples(): SegmentSample[] {
	return [
		buildCacheMeterSegment(new CacheMeterState(), 0, idTheme),
		buildCadenceEqualizerSegment(new CadenceEqualizerState(), false, null, 0, idTheme),
		buildAuditTrailBoxSegment(new AuditLedgerState(), 0, idTheme),
		buildRateLimitTidepoolSegment(new RateLimitTidepoolState(), 0, idTheme),
		buildToolConstellationSegment(new ConstellationState(), 0, idTheme),
		buildPalimpsestSegment(new PalimpsestState(), 0, idTheme),
		buildReflectionRippleSegment(new ReflectionRippleState(), 0, idTheme),
	];
}

/** One warmed, active `*State` per segment, in `BOX_SEGMENT_IDS` order — every segment active at once. */
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

	const constellationState = new ConstellationState();
	constellationState.recordFire("write", 0);
	constellationState.recordFire("read", 0);

	const palimpsestState = new PalimpsestState();
	palimpsestState.applySpans("/repo/src/foo.ts", [{ start: 1, end: 5 }]);
	palimpsestState.applySpans("/repo/src/foo.ts", [{ start: 1, end: 5 }]); // second touch crosses GLOW_THRESHOLD

	const reflectionRippleState = new ReflectionRippleState();
	reflectionRippleState.applyTrigger(["myRule"], 0);

	return [
		buildCacheMeterSegment(cacheMeterState, 0, idTheme),
		buildCadenceEqualizerSegment(new CadenceEqualizerState(), true, 100, 0, idTheme),
		buildAuditTrailBoxSegment(auditState, 0, idTheme),
		buildRateLimitTidepoolSegment(tidepoolState, 0, idTheme),
		buildToolConstellationSegment(constellationState, 0, idTheme),
		buildPalimpsestSegment(palimpsestState, 0, idTheme),
		buildReflectionRippleSegment(reflectionRippleState, 0, idTheme),
	];
}

function makeWidget(samples: readonly SegmentSample[], detail: BoxDetail): AnimationsBoxWidget {
	const scheduler = manualScheduler();
	const policy = new MotionPolicy(fullEnv, "full");
	const host = new AnimationHost({ policy, scheduler });
	return new AnimationsBoxWidget({
		tui: noopTui,
		host,
		policy,
		theme: idTheme,
		clock: scheduler,
		onTick: () => {},
		buildSamples: () => samples,
		getDetail: () => detail,
		getBorderBrightness: () => undefined,
	});
}

// ---------------------------------------------------------------------------
// 1. Full-box golden frames
// ---------------------------------------------------------------------------

describe("AnimationsBoxController + AnimationsBoxWidget — full-box golden frames (Decision 5)", () => {
	it("detailed mode: exact golden frames at width 69 (real pane), 45 (narrow), 120 (wide) — 7 enabled, 5 active", () => {
		const widget = driveFullBox("detailed");

		expect(widget.renderFrame(69)).toEqual([
			"╭───────────────────────────────────────────────────────────────────╮",
			"│ ▤      cache    [█████░░░░░] 50.0%    1/1          r 600 · w 200… │",
			"│ ▃▁▁    cadence               100 t/s  peak 55      ⣀⡀⠀            │",
			"│ ▣      audit                 1✎\uFE0E       widget.ts    reads 1 · wri… │",
			"│ ◗      limits   [███████▊░░] 78%      anthropic    resets 12m     │",
			"│ ⛏\uFE0E      tools                 2 calls  read         ⛏\uFE0E1 read · ✎\uFE0E1 … │",
			"│ ▓      files                 —                                    │",
			"│ ○      reflect               —                                    │",
			"╰───────────────────────────────────────────────────────────────────╯",
		]);

		expect(widget.renderFrame(45)).toEqual([
			"╭───────────────────────────────────────────╮",
			"│ ▤      cache    [█████░░░░░] 50.0%    1/… │",
			"│ ▃▁▁    cadence               100 t/s  pe… │",
			"│ ▣      audit                 1✎\uFE0E       wi… │",
			"│ ◗      limits   [███████▊░░] 78%      an… │",
			"│ ⛏\uFE0E      tools                 2 calls  re… │",
			"│ ▓      files                 —          … │",
			"│ ○      reflect               —          … │",
			"╰───────────────────────────────────────────╯",
		]);

		expect(widget.renderFrame(120)).toEqual([
			"╭──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────╮",
			"│ ▤      cache    [█████░░░░░] 50.0%    1/1          r 600 · w 200 · miss 400                                          │",
			"│ ▃▁▁    cadence               100 t/s  peak 55      ⣀⡀⠀                                                               │",
			"│ ▣      audit                 1✎\uFE0E       widget.ts    reads 1 · writes 1 · amp 1.0×                                     │",
			"│ ◗      limits   [███████▊░░] 78%      anthropic    resets 12m                                                        │",
			"│ ⛏\uFE0E      tools                 2 calls  read         ⛏\uFE0E1 read · ✎\uFE0E1 write                                                │",
			"│ ▓      files                 —                                                                                       │",
			"│ ○      reflect               —                                                                                       │",
			"╰──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────╯",
		]);

		widget.dispose();
	});

	it("simple mode: exact golden frames at width 69 (real pane), 45 (narrow), 120 (wide) — 7 enabled, 5 active", () => {
		const widget = driveFullBox("simple");

		expect(widget.renderFrame(69)).toEqual([
			"╭───────────────────────────────────────────────────────────────────╮",
			"│ ▤ 50.0% · ⣀⡀⠀ · ▣ 1✎\uFE0E r/w 1/1 ×1.0 ↻0% · 78% · ⛏\uFE0E 1 · ✎\uFE0E 1           │",
			"╰───────────────────────────────────────────────────────────────────╯",
		]);

		expect(widget.renderFrame(45)).toEqual([
			"╭───────────────────────────────────────────╮",
			"│ ▤ 50.0% · ⣀⡀⠀ · ▣ 1✎\uFE0E · 78% · ⛏\uFE0E 1 · ✎\uFE0E 1    │",
			"╰───────────────────────────────────────────╯",
		]);

		expect(widget.renderFrame(120)).toEqual([
			"╭──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────╮",
			"│ ▤ HIT 50.0% (1/1) ▅ READ 600 WRITE 200 MISS 400 · ⣀⡀⠀ · ▣ 1✎\uFE0E r/w 1/1 ×1.0 ↻0% · ≈≈≈≈≈≈≈≈∘∘ 78% anthropic · ⛏\uFE0E 1 · ✎\uFE0E 1 │",
			"╰──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────╯",
		]);

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
// 2. Height stability
// ---------------------------------------------------------------------------

describe("AnimationsBoxWidget — height stability under runtime activation (Decision 5)", () => {
	it("restingSamples()/activeSamples() line up 1:1 with BOX_SEGMENT_IDS, in order, at the intended activity", () => {
		expect(restingSamples().map(s => s.id)).toEqual([...BOX_SEGMENT_IDS]);
		expect(activeSamples().map(s => s.id)).toEqual([...BOX_SEGMENT_IDS]);
		for (const s of restingSamples()) expect(s.active).toBe(false);
		for (const s of activeSamples()) expect(s.active).toBe(true);
	});

	it("toggling any single segment active vs resting never changes row count, in either detail mode", () => {
		for (const detail of ["detailed", "simple"] as const) {
			const baseline = makeWidget(restingSamples(), detail).render(69).length;
			for (let i = 0; i < BOX_SEGMENT_IDS.length; i++) {
				const toggled = restingSamples();
				toggled[i] = activeSamples()[i] as SegmentSample;
				expect(makeWidget(toggled, detail).render(69).length).toBe(baseline);
			}
		}
	});

	it("all 7 segments active at once still matches the all-resting row count, in either detail mode", () => {
		for (const detail of ["detailed", "simple"] as const) {
			const restingCount = makeWidget(restingSamples(), detail).render(69).length;
			const activeCount = makeWidget(activeSamples(), detail).render(69).length;
			expect(activeCount).toBe(restingCount);
		}
	});

	it("detailed-mode height is BOX_BORDER_ROWS + one row per enabled segment; simple mode is always BOX_BORDER_ROWS + 1", () => {
		expect(makeWidget(restingSamples(), "detailed").render(69)).toHaveLength(
			BOX_BORDER_ROWS + BOX_SEGMENT_IDS.length,
		);
		expect(makeWidget(restingSamples(), "simple").render(69)).toHaveLength(BOX_BORDER_ROWS + 1);
	});
});

describe("AnimationsBoxController — config-driven height changes (Decision 5)", () => {
	function frameLength(rawConfig: Record<string, unknown>, width = 69): number {
		return mountedWidget(rawConfig).renderFrame(width).length;
	}

	it("disabling one segment in config.enabled shortens detailed-mode height by exactly 1, and never touches simple mode's fixed height", () => {
		const baselineDetailed = frameLength({ animationsBoxDetail: "detailed" });
		const baselineSimple = frameLength({ animationsBoxDetail: "simple" });
		for (const id of BOX_SEGMENT_IDS) {
			expect(frameLength({ animationsBoxDetail: "detailed", [id]: false })).toBe(baselineDetailed - 1);
			expect(frameLength({ animationsBoxDetail: "simple", [id]: false })).toBe(baselineSimple);
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
// 3. Degradation ladder (simple mode, everything active)
// ---------------------------------------------------------------------------

describe("kit composeSegments — degradation ladder at 45/69/120 in simple mode, everything active (Decision 5)", () => {
	function priorityOf(id: BoxSegmentId): number {
		return BOX_SEGMENT_IDS.indexOf(id) + 1;
	}

	// At the maintainer's real pane (69) and the wide surface (120), every segment's
	// narrowest variant still fits — nothing is dropped. At 45 the combined narrowest
	// widths no longer fit, so the composer drops the single lowest-priority segment
	// (reflectionRipple, priority 7 — last in BOX_SEGMENT_IDS) and keeps everyone else.
	const LADDER: Record<number, readonly BoxSegmentId[]> = {
		69: BOX_SEGMENT_IDS,
		45: BOX_SEGMENT_IDS.slice(0, -1),
		120: BOX_SEGMENT_IDS,
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

	it("the lowest-priority segment (reflectionRipple) is the first — and here the only — one to drop as width tightens", () => {
		expect(LADDER[69]).toContain("reflectionRipple");
		expect(LADDER[120]).toContain("reflectionRipple");
		expect(LADDER[45]).not.toContain("reflectionRipple");
	});
});
