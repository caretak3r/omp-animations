/**
 * Animations Box — full-box golden frames, status-line fixture goldens,
 * height stability, and the degradation ladder (Plan 017 Decision 5 +
 * Plan 018 status lines). Per-builder span/variant assertions live in
 * `animations-box-segments.test.ts`; per-mode geometry/border assertions
 * live in `animations-box-widget.test.ts`. This file is the
 * composition-level contract: literal rendered frames at the maintainer's
 * real pane width (69), narrow (45), and wide (120), driven through the
 * real controller pipeline end to end; the §3 grammar forms (n/a, idle,
 * notable, alert, change-flash) as rendered-line goldens; plus the
 * invariants that make the fixed-height design actually hold.
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
	buildToolActivitySegment,
	type SegmentSample,
} from "../src/animations-box/segments";
import {
	BOX_OPTIONAL_STATUS_SEGMENT_IDS,
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
	type StatusLineContext,
} from "../src/animations-box/status-line";
import { ToolActivityState } from "../src/animations-box/tool-activity";
import { AnimationsBoxWidget, BOX_BORDER_COLS, BOX_BORDER_ROWS } from "../src/animations-box/widget";
import { AuditLedgerState, POISON_STREAK_TICKS } from "../src/audit-trail-box";
import { CacheMeterState } from "../src/cache-meter";
import { CadenceEqualizerState } from "../src/cadence-equalizer";
import { AnimationHost, composeSegments, type FrameScheduler, MotionPolicy, segment } from "../src/kit";
import { PalimpsestState } from "../src/palimpsest";
import { RateLimitTidepoolState } from "../src/rate-limit-tidepool";
import { ReflectionRippleState } from "../src/reflection-ripple";

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
 * audit trail, rate-limit tidepool and tool activity go active; palimpsest
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
	controller.onToolCall(toolCall("bash", "tc-3"), ctx); // the one non-file call: the tools row's whole breakdown

	// One tick so cadence's EMA bands step off zero — mirrors the real per-frame pipeline.
	scheduler.advance(50);
	widget.onFrame(0);

	return widget;
}

/** One fresh, idle `*State` per segment, in grouped priority order — every segment resting. */
function restingSamples(): SegmentSample[] {
	return [
		buildCacheMeterSegment(new CacheMeterState(), 0, idTheme),
		buildAuditTrailBoxSegment(new AuditLedgerState(), 0, idTheme),
		buildRateLimitTidepoolSegment(new RateLimitTidepoolState(), 0, idTheme),
		buildToolActivitySegment(new ToolActivityState(), 0, idTheme),
		buildPalimpsestSegment(new PalimpsestState(), 0, idTheme),
		buildCadenceEqualizerSegment(new CadenceEqualizerState(), false, null, 0, idTheme),
		buildReflectionRippleSegment(new ReflectionRippleState(), 0, idTheme),
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

	const palimpsestState = new PalimpsestState();
	palimpsestState.applySpans("/repo/src/foo.ts", [{ start: 1, end: 5 }]);
	palimpsestState.applySpans("/repo/src/foo.ts", [{ start: 1, end: 5 }]); // second touch crosses GLOW_THRESHOLD

	const reflectionRippleState = new ReflectionRippleState();
	reflectionRippleState.applyTrigger(["myRule"], 0);

	return [
		buildCacheMeterSegment(cacheMeterState, 0, idTheme),
		buildAuditTrailBoxSegment(auditState, 0, idTheme),
		buildRateLimitTidepoolSegment(tidepoolState, 0, idTheme),
		buildToolActivitySegment(toolActivityState, 0, idTheme),
		buildPalimpsestSegment(palimpsestState, 0, idTheme),
		buildCadenceEqualizerSegment(new CadenceEqualizerState(), true, 100, 0, idTheme),
		buildReflectionRippleSegment(reflectionRippleState, 0, idTheme),
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
		getBorderBrightness: () => undefined,
	});
}

// ---------------------------------------------------------------------------
// 1. Full-box golden frames
// ---------------------------------------------------------------------------

describe("AnimationsBoxController + AnimationsBoxWidget — full-box golden frames (Decision 5)", () => {
	it("detailed mode: exact golden frames at width 69 (real pane), 45 (narrow), and 120 (wide) — five required rows", () => {
		const widget = driveFullBox("detailed");

		expect(widget.renderFrame(69)).toEqual([
			"╭───────────────────────────────────────────────────────────────────╮",
			`${"│ ●  cache    50% hit · 1/1   400 uncached".padEnd(68)}│`,
			`${"│ ◐  audit    1 read · 1 write · 1 edited   widget.ts".padEnd(68)}│`,
			"│ ●  limits   78% left · resets 12m · anthropic                     │",
			"│ ●  tools    3 calls — bash (1)                                    │",
			"│ ○  files    —                                                     │",
			"╰───────────────────────────────────────────────────────────────────╯",
		]);

		expect(widget.renderFrame(45)).toEqual([
			"╭───────────────────────────────────────────╮",
			`${"│ ●  cache    50% hit · 1/1   400 uncached".padEnd(44)}│`,
			"│ ◐  audit    1 read · 1 write · 1 edited   │",
			"│ ●  limits   78% left · resets 12m         │",
			"│ ●  tools    3 calls — bash (1)            │",
			"│ ○  files    —                             │",
			"╰───────────────────────────────────────────╯",
		]);

		expect(widget.renderFrame(120)).toEqual([
			"╭──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────╮",
			`${"│ ●  cache    50% hit · 1/1   400 uncached".padEnd(119)}│`,
			`${"│ ◐  audit    1 read · 1 write · 1 edited   widget.ts".padEnd(119)}│`,
			"│ ●  limits   78% left · resets 12m · anthropic                                                                        │",
			"│ ●  tools    3 calls — bash (1)                                                                                       │",
			"│ ○  files    —                                                                                                        │",
			"╰──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────╯",
		]);

		widget.dispose();
	});

	it("simple mode: exact golden frames at width 69 (real pane), 45 (narrow), and 120 (wide) — required segments only", () => {
		const widget = driveFullBox("simple");

		expect(widget.renderFrame(69)).toEqual([
			"╭───────────────────────────────────────────────────────────────────╮",
			"│ ▤ H 50.0% (1/1) ▅ R 600 W 200 M 400 · ▣ 1✎\uFE0E · 78% · 3 calls        │",
			"╰───────────────────────────────────────────────────────────────────╯",
		]);

		expect(widget.renderFrame(45)).toEqual([
			"╭───────────────────────────────────────────╮",
			"│ ▤ 50.0% · ▣ 1✎\uFE0E · 78% · 3 calls — bash (1) │",
			"╰───────────────────────────────────────────╯",
		]);

		expect(widget.renderFrame(120)).toEqual([
			"╭──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────╮",
			"│ ▤ HIT 50.0% (1/1) ▅ READ 600 WRITE 200 MISS 400 · ▣ 1✎\uFE0E r/w 1/1 ×1.0 ↻0% · ≈≈≈≈≈≈≈≈∘∘ 78% anthropic · 3 calls         │",
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
	it("n/a form (D4): a provider that never caches latches to the idle dot and dim prose — no numbers", () => {
		const state = new CacheMeterState();
		for (let i = 0; i < 8; i++) {
			state.recordUsage({
				provider: "ollama",
				model: "gpt-oss",
				usage: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 110 },
			});
		}
		const { line } = buildCacheMeterSegment(state, 0, idTheme);
		expect(renderStatusLine(line, SPEC_INNER, lineCtx())).toBe("○  cache    no caching on this provider");
	});

	it("idle form: an untouched segment renders the lone dim em-dash under the idle dot", () => {
		const { line } = buildPalimpsestSegment(new PalimpsestState(), 0, idTheme);
		expect(renderStatusLine(line, SPEC_INNER, lineCtx())).toBe("○  files    —");
	});

	it("notable form: an agent-edited file escalates to the half dot and keeps the wide tail beside the indicators", () => {
		const state = new AuditLedgerState();
		state.noteRead("/repo/src/widget.ts");
		state.noteWrite("/repo/src/widget.ts", 0);
		const { line } = buildAuditTrailBoxSegment(state, 0, idTheme);
		expect(line.dot).toBe("notable");
		expect(renderStatusLine(line, SPEC_INNER, lineCtx())).toBe("◐  audit    1 read · 1 write · 1 edited   widget.ts");
	});

	it("alert form: an on-disk divergence escalates to the alert dot with the poisoned span beside it", () => {
		const state = new AuditLedgerState();
		state.noteRead("/repo/src/read.log", { hash: "h1" });
		const reading = { path: "/repo/src/read.log", hash: "h2", reachable: true };
		for (let tick = 0; tick < POISON_STREAK_TICKS; tick++) state.noteProbe([reading], 10_000 + tick * 1000);
		const { line } = buildAuditTrailBoxSegment(state, 20_000, idTheme);
		expect(line.dot).toBe("alert");
		expect(renderStatusLine(line, SPEC_INNER, lineCtx({ now: 20_000 }))).toBe(
			"●  audit    1 read · 0 writes · 1 changed on disk   read.log",
		);
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
		// Baseline frame: first observation of every span key — no flash (D6),
		// pct resting at its bucketed gradient tone.
		expect(renderStatusLine(buildCacheMeterSegment(state, 0, tagTheme).line, SPEC_INNER, ctxAt(0))).toBe(
			"<accent:●>  cache    <success:50% hit> · 1/1   400 uncached",
		);

		// A second usage moves pct and hits — both spans enter the bold+accent phase...
		state.recordUsage({
			provider: "anthropic",
			model: "claude",
			usage: { input: 0, output: 10, cacheRead: 1000, cacheWrite: 0, totalTokens: 1010 },
		});
		const changed = buildCacheMeterSegment(state, 5000, tagTheme).line;
		expect(renderStatusLine(changed, SPEC_INNER, ctxAt(5000))).toBe(
			"<accent:●>  cache    «<accent:75% hit>» · «<accent:2/2>»   400 uncached",
		);
		// ...decay to accent alone...
		expect(renderStatusLine(changed, SPEC_INNER, ctxAt(5000 + FULL_FLASH_BOLD_MS))).toBe(
			"<accent:●>  cache    <accent:75% hit> · <accent:2/2>   400 uncached",
		);
		// ...and come fully to rest — gradient tone back, no residue (no blinking).
		expect(renderStatusLine(changed, SPEC_INNER, ctxAt(5000 + FULL_FLASH_MS))).toBe(
			"<accent:●>  cache    <success:75% hit> · 2/2   400 uncached",
		);
	});
});

// ---------------------------------------------------------------------------
// 3. Height stability
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

	it("all required and optional segments active still matches the all-resting row count in either detail mode", () => {
		for (const detail of ["detailed", "simple"] as const) {
			const restingCount = makeWidget(restingSamples(), detail).render(69).length;
			const activeCount = makeWidget(activeSamples(), detail).render(69).length;
			expect(activeCount).toBe(restingCount);
		}
	});

	it("detailed mode includes one separator between the segment groups; simple mode remains one composed row", () => {
		expect(makeWidget(restingSamples(), "detailed").render(69)).toHaveLength(
			BOX_BORDER_ROWS + BOX_SEGMENT_IDS.length + 1,
		);
		expect(makeWidget(restingSamples(), "simple").render(69)).toHaveLength(BOX_BORDER_ROWS + 1);
	});
});

describe("AnimationsBoxController — config-driven height changes (Decision 5)", () => {
	function frameLength(rawConfig: Record<string, unknown>, width = 69): number {
		return mountedWidget(rawConfig).renderFrame(width).length;
	}

	it("keeps required-summary height fixed and adds one shared separator for visible optional status rows", () => {
		const baselineDetailed = frameLength({ animationsBoxDetail: "detailed" });
		const baselineSimple = frameLength({ animationsBoxDetail: "simple" });
		expect(baselineDetailed).toBe(BOX_BORDER_ROWS + BOX_REQUIRED_SEGMENT_IDS.length);

		for (const id of BOX_REQUIRED_SEGMENT_IDS) {
			expect(frameLength({ animationsBoxDetail: "detailed", [id]: false })).toBe(baselineDetailed);
			expect(frameLength({ animationsBoxDetail: "detailed", [id]: true })).toBe(baselineDetailed);
		}
		for (const id of BOX_OPTIONAL_STATUS_SEGMENT_IDS) {
			expect(frameLength({ animationsBoxDetail: "detailed", [id]: false })).toBe(baselineDetailed);
			expect(frameLength({ animationsBoxDetail: "detailed", [id]: true })).toBe(baselineDetailed + 2);
			expect(frameLength({ animationsBoxDetail: "simple", [id]: false })).toBe(baselineSimple);
			expect(frameLength({ animationsBoxDetail: "simple", [id]: true })).toBe(baselineSimple);
		}
		expect(frameLength({ animationsBoxDetail: "detailed", agentBonsai: true })).toBe(baselineDetailed);
		expect(
			frameLength({
				animationsBoxDetail: "detailed",
				cadenceEqualizer: true,
				reflectionRipple: true,
			}),
		).toBe(baselineDetailed + 3);
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

	// At the maintainer's real pane (69) and the wide surface (120), every segment's
	// narrowest variant still fits — nothing is dropped. At 45 the combined narrowest
	// widths no longer fit, so the composer drops the two lowest-priority segments
	// (reflectionRipple, priority 7, then cadenceEqualizer, priority 6) and keeps the
	// five required summaries.
	const LADDER: Record<number, readonly BoxSegmentId[]> = {
		69: BOX_SEGMENT_IDS,
		45: BOX_SEGMENT_IDS.slice(0, -2),
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

	it("the lowest-priority segments (reflectionRipple, then cadenceEqualizer) are the first to drop as width tightens", () => {
		expect(LADDER[69]).toContain("reflectionRipple");
		expect(LADDER[120]).toContain("reflectionRipple");
		expect(LADDER[45]).not.toContain("reflectionRipple");
		expect(LADDER[45]).not.toContain("cadenceEqualizer");
		expect(LADDER[45]).toContain("palimpsest");
	});
});
