import { describe, expect, it } from "bun:test";
import type {
	ExtensionWidgetContent,
	ExtensionWidgetOptions,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import type {
	AfterProviderResponseEvent,
	AgentEndEvent,
	AgentStartEvent,
	MessageEndEvent,
	MessageStartEvent,
	MessageUpdateEvent,
	ToolCallEvent,
	ToolResultEvent,
	TtsrTriggeredEvent,
	TurnEndEvent,
	TurnStartEvent,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { type AnimationsBoxContext, AnimationsBoxController, BOX_WIDGET_KEY } from "../src/animations-box/controller";
import {
	BOX_OPTIONAL_STATUS_SEGMENT_IDS,
	BOX_REQUIRED_SEGMENT_IDS,
	resolveAnimationsBoxConfig,
} from "../src/animations-box/settings";
import type { AnimationsBoxWidget } from "../src/animations-box/widget";
import {
	AuditLedgerState,
	AuditTrailService,
	hashContent,
	type ProbeObservation,
	type ProbeSource,
} from "../src/audit-trail-box";
import {
	BASE_BREATH_PERIOD_MS,
	BREATHING_BORDER_COLORS,
	EXHALE_DURATION_MS,
	MIN_BREATH_PERIOD_MS,
} from "../src/breathing-border";
import { resolveGlyph } from "../src/glyph-presets";
import type { FrameScheduler } from "../src/kit";
import { DIM_DURATION_MS, RIPPLE_DURATION_MS } from "../src/reflection-ripple";

// Identity theme so most assertions see plain text instead of ANSI escapes.
const idTheme = { fg: (_color: string, text: string) => text };
// Color-tagging theme for tests that need to assert which border token the box chose.
const taggedTheme = { fg: (color: string, text: string) => `${color}:${text}` };
const noopTui = { requestComponentRender: () => {} };

/** Manual frame scheduler: deterministic `now()`, never ticks on its own. */
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

/** Recording context double + a helper to pull the mounted widget factory back out. */
function recordingContext(overrides: Partial<AnimationsBoxContext> = {}): {
	ctx: AnimationsBoxContext;
	calls: SetWidgetCall[];
} {
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
		...overrides,
	};
	return { ctx, calls };
}

/** Builds the widget from the factory `setWidget` was called with, so state-wiring tests can inspect real render output. Defaults to the identity theme; border-coloring tests pass `taggedTheme`. */
function buildWidget(call: SetWidgetCall, theme: unknown = idTheme): AnimationsBoxWidget {
	const factory = call.content as (tui: unknown, theme: unknown) => AnimationsBoxWidget;
	return factory(noopTui, theme);
}

interface UsageOverrides {
	input?: number;
	cacheRead?: number;
	cacheWrite?: number;
}

function messageEnd(usage: UsageOverrides = {}): MessageEndEvent {
	return {
		type: "message_end",
		message: {
			role: "assistant",
			content: [],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude",
			usage: { input: 0, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 10, ...usage },
			stopReason: "stop",
			timestamp: 0,
		},
	} as unknown as MessageEndEvent;
}

interface AssistantMessageOverrides {
	output?: number;
	timestamp?: number;
	duration?: number;
	provider?: string;
}

function assistantMessageStart(overrides: AssistantMessageOverrides = {}): MessageStartEvent {
	return {
		type: "message_start",
		message: {
			role: "assistant",
			content: [],
			api: "anthropic-messages",
			provider: overrides.provider ?? "anthropic",
			model: "claude",
			usage: { input: 0, output: overrides.output ?? 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
			stopReason: undefined,
			timestamp: overrides.timestamp ?? 0,
			duration: overrides.duration,
		},
	} as unknown as MessageStartEvent;
}

/** A non-assistant `message_start` (e.g. a user message) — never carries `provider`/rate-relevant fields. */
function userMessageStart(): MessageStartEvent {
	return {
		type: "message_start",
		message: { role: "user", content: [], timestamp: 0 },
	} as unknown as MessageStartEvent;
}

function assistantMessageUpdate(overrides: AssistantMessageOverrides = {}): MessageUpdateEvent {
	return {
		type: "message_update",
		message: {
			role: "assistant",
			content: [],
			api: "anthropic-messages",
			provider: overrides.provider ?? "anthropic",
			model: "claude",
			usage: { input: 0, output: overrides.output ?? 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
			stopReason: undefined,
			timestamp: overrides.timestamp ?? 0,
			duration: overrides.duration,
		},
	} as unknown as MessageUpdateEvent;
}

function afterProviderResponse(headers: Record<string, string>): AfterProviderResponseEvent {
	return { type: "after_provider_response", headers } as unknown as AfterProviderResponseEvent;
}

/** A recognized Anthropic rate-limit header triple, `remainingOf(limit)` fraction depleted, resetting `resetInMs` from `nowMs`. */
function anthropicHeaders(limit: number, remaining: number, nowMs: number, resetInMs: number): Record<string, string> {
	return {
		"anthropic-ratelimit-requests-limit": String(limit),
		"anthropic-ratelimit-requests-remaining": String(remaining),
		"anthropic-ratelimit-requests-reset": new Date(nowMs + resetInMs).toISOString(),
	};
}

function ttsrTriggered(ruleNames: readonly string[]): TtsrTriggeredEvent {
	return {
		type: "ttsr_triggered",
		rules: ruleNames.map(name => ({ name })),
	} as unknown as TtsrTriggeredEvent;
}

function toolCall(toolName: string): ToolCallEvent {
	return { type: "tool_call", toolCallId: "tc-1", toolName, input: {} } as unknown as ToolCallEvent;
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

/** An `edit` tool result carrying one parseable hunk header — feeds both Audit Trail's ledger and Palimpsest's span ledger from the same event. */
function editResult(path: string): ToolResultEvent {
	return {
		type: "tool_result",
		toolCallId: "tc-edit",
		toolName: "edit",
		input: { path },
		content: [],
		isError: false,
		details: { path, op: "update", diff: "@@ -1,3 +1,5 @@\n" },
	} as unknown as ToolResultEvent;
}

function turnEnd(turnIndex: number): TurnEndEvent {
	return { type: "turn_end", turnIndex, message: {}, toolResults: [] } as unknown as TurnEndEvent;
}

function agentStart(): AgentStartEvent {
	return { type: "agent_start" } as unknown as AgentStartEvent;
}

function agentEnd(): AgentEndEvent {
	return { type: "agent_end", messages: [] } as unknown as AgentEndEvent;
}

function turnStart(turnIndex: number): TurnStartEvent {
	return { type: "turn_start", turnIndex, timestamp: 0 } as unknown as TurnStartEvent;
}

describe("AnimationsBoxController — mount lifecycle", () => {
	it("does nothing when the context has no UI", () => {
		const { ctx, calls } = recordingContext({ hasUI: false });
		const controller = new AnimationsBoxController({
			scheduler: manualScheduler(),
			initialConfig: resolveAnimationsBoxConfig({}),
		});
		controller.mount(ctx);
		expect(calls).toEqual([]);
	});

	it("mounts exactly once under the namespaced widget key, even across repeated mount() calls", () => {
		const { ctx, calls } = recordingContext();
		const controller = new AnimationsBoxController({
			scheduler: manualScheduler(),
			initialConfig: resolveAnimationsBoxConfig({}),
		});
		controller.mount(ctx);
		controller.mount(ctx);
		expect(calls).toHaveLength(1);
		expect(calls[0]?.key).toBe(BOX_WIDGET_KEY);
		expect(BOX_WIDGET_KEY).toBe("oh-my-pi-animations-box");
	});

	it("defaults placement to belowEditor, and honors an explicit override", () => {
		const { ctx, calls } = recordingContext();
		new AnimationsBoxController({
			scheduler: manualScheduler(),
			initialConfig: resolveAnimationsBoxConfig({}),
		}).mount(ctx);
		expect(calls[0]?.options).toEqual({ placement: "belowEditor" });

		const { ctx: ctx2, calls: calls2 } = recordingContext();
		new AnimationsBoxController({
			scheduler: manualScheduler(),
			placement: "aboveEditor",
			initialConfig: resolveAnimationsBoxConfig({}),
		}).mount(ctx2);
		expect(calls2[0]?.options).toEqual({ placement: "aboveEditor" });
	});

	it("dispose tears down the mount and clears the widget; is idempotent", () => {
		const { ctx, calls } = recordingContext();
		const controller = new AnimationsBoxController({
			scheduler: manualScheduler(),
			initialConfig: resolveAnimationsBoxConfig({}),
		});
		controller.mount(ctx);
		controller.dispose(ctx);
		controller.dispose(ctx);
		expect(calls).toHaveLength(2);
		expect(calls[1]).toEqual({ key: BOX_WIDGET_KEY, content: undefined, options: { placement: "belowEditor" } });
	});

	it("exposes the initial config unchanged via the read-only accessor", () => {
		const config = resolveAnimationsBoxConfig({ animationsBoxDetail: "simple" });
		const controller = new AnimationsBoxController({ scheduler: manualScheduler(), initialConfig: config });
		expect(controller.config).toBe(config);
	});

	it("captures ctx.glyphPreset once at mount and threads it into the rendered dot glyphs — not just the config field", () => {
		const scheduler = manualScheduler();
		const { ctx, calls } = recordingContext({ glyphPreset: "ascii" });
		const controller = new AnimationsBoxController({ scheduler, initialConfig: resolveAnimationsBoxConfig({}) });
		controller.mount(ctx);
		const widget = buildWidget(calls[0] as SetWidgetCall);

		controller.onMessageEnd(messageEnd({ input: 400, cacheRead: 600, cacheWrite: 200 }), ctx);
		const rows = widget.renderFrame(69).join("\n");
		expect(rows).toContain(resolveGlyph("box.dot.live", "ascii")); // cache went live under the ascii preset
		expect(rows).not.toContain(resolveGlyph("box.dot.live", "unicode"));
		expect(rows).not.toContain(resolveGlyph("box.dot.idle", "unicode"));
		widget.dispose();
	});
});

describe("AnimationsBoxController — cache-meter state wiring", () => {
	it("the mounted widget starts on the resting row before any message_end lands", () => {
		const { ctx, calls } = recordingContext();
		const controller = new AnimationsBoxController({
			scheduler: manualScheduler(),
			initialConfig: resolveAnimationsBoxConfig({}),
		});
		controller.mount(ctx);
		const widget = buildWidget(calls[0] as SetWidgetCall);
		const rows = widget.renderFrame(69).join("\n");
		expect(rows).toContain("cache");
		expect(rows).toContain("—");
		widget.dispose();
	});

	it("onMessageEnd feeds the ledger, flipping the segment to its active row on the next render", () => {
		const scheduler = manualScheduler();
		const { ctx, calls } = recordingContext();
		const controller = new AnimationsBoxController({ scheduler, initialConfig: resolveAnimationsBoxConfig({}) });
		controller.mount(ctx);
		const widget = buildWidget(calls[0] as SetWidgetCall);

		controller.onMessageEnd(messageEnd({ input: 400, cacheRead: 600, cacheWrite: 200 }), ctx);
		const frame = widget.renderFrame(69);
		const cacheRow = frame.find(row => row.includes("cache"));
		expect(cacheRow).toBeDefined();
		expect(cacheRow).not.toContain("—     "); // the resting placeholder is gone, even though the other enabled-but-idle segments still show theirs
		widget.dispose();
	});

	it("ignores every event when hasUI is false", () => {
		const scheduler = manualScheduler();
		const { ctx, calls } = recordingContext();
		const controller = new AnimationsBoxController({ scheduler, initialConfig: resolveAnimationsBoxConfig({}) });
		controller.mount(ctx);
		const widget = buildWidget(calls[0] as SetWidgetCall);

		controller.onMessageEnd(messageEnd({ input: 400, cacheRead: 600 }), { hasUI: false });
		expect(widget.renderFrame(69).join("\n")).toContain("—");
		widget.dispose();
	});

	it("a message_end with no usable telemetry (all-zero usage) leaves the segment resting", () => {
		const scheduler = manualScheduler();
		const { ctx, calls } = recordingContext();
		const controller = new AnimationsBoxController({ scheduler, initialConfig: resolveAnimationsBoxConfig({}) });
		controller.mount(ctx);
		const widget = buildWidget(calls[0] as SetWidgetCall);

		controller.onMessageEnd(messageEnd({ input: 0, cacheRead: 0, cacheWrite: 0 }), ctx);
		expect(widget.renderFrame(69).join("\n")).toContain("—");
		widget.dispose();
	});

	it("onSessionCompact / onAutoCompactionStart attribute a later invalidation to the right cause", () => {
		const scheduler = manualScheduler();
		const { ctx, calls } = recordingContext();
		const controller = new AnimationsBoxController({ scheduler, initialConfig: resolveAnimationsBoxConfig({}) });
		controller.mount(ctx);

		controller.onMessageEnd(messageEnd({ cacheRead: 6_000 }), ctx); // warms the lineage
		controller.onSessionCompact(ctx);
		scheduler.advance(10);
		controller.onMessageEnd(messageEnd({ input: 6_000, cacheWrite: 6_000 }), ctx); // collapses it, cold

		const widget = buildWidget(calls[0] as SetWidgetCall);
		expect(widget.renderFrame(200).join("\n")).toContain("cache");
		widget.dispose();
	});

	it("onSessionSwitch resets the ledger to a fresh, empty state without tearing down the mount", () => {
		const scheduler = manualScheduler();
		const { ctx, calls } = recordingContext();
		const controller = new AnimationsBoxController({ scheduler, initialConfig: resolveAnimationsBoxConfig({}) });
		controller.mount(ctx);
		controller.onMessageEnd(messageEnd({ input: 400, cacheRead: 600 }), ctx);

		const activeWidget = buildWidget(calls[0] as SetWidgetCall);
		const activeCacheRow = activeWidget.renderFrame(69).find(row => row.includes("cache"));
		expect(activeCacheRow).not.toContain("—     ");
		activeWidget.dispose();

		controller.onSessionSwitch(undefined, ctx);
		// The mount itself is untouched — setWidget was never called again for a teardown.
		expect(calls).toHaveLength(1);

		const afterSwitch = buildWidget(calls[0] as SetWidgetCall);
		const restingCacheRow = afterSwitch.renderFrame(69).find(row => row.includes("cache"));
		expect(restingCacheRow).toContain("—");
		afterSwitch.dispose();
	});

	it("keeps the required cache summary visible when its standalone-row setting is disabled", () => {
		const scheduler = manualScheduler();
		const { ctx, calls } = recordingContext();
		const controller = new AnimationsBoxController({
			scheduler,
			initialConfig: resolveAnimationsBoxConfig({ cacheMeter: false }),
		});
		controller.mount(ctx);
		controller.onMessageEnd(messageEnd({ input: 400, cacheRead: 600 }), ctx);

		const widget = buildWidget(calls[0] as SetWidgetCall);
		const rows = widget.renderFrame(69).join("\n");
		expect(rows).toContain("cache");
		widget.dispose();
	});
});

describe("AnimationsBoxController — cadence equalizer state wiring", () => {
	it("the mounted widget starts on the resting row before any message_start lands", () => {
		const { ctx, calls } = recordingContext();
		const controller = new AnimationsBoxController({
			scheduler: manualScheduler(),
			initialConfig: resolveAnimationsBoxConfig({ cadenceEqualizer: true }),
		});
		controller.mount(ctx);
		const widget = buildWidget(calls[0] as SetWidgetCall);
		const cadenceRow = widget.renderFrame(69).find(row => row.includes("cadence"));
		expect(cadenceRow).toContain("—");
		widget.dispose();
	});

	it("onMessageStart latches hasStreamed and surfaces the sampled rate, flipping the segment to its active row", () => {
		const scheduler = manualScheduler();
		const { ctx, calls } = recordingContext();
		const controller = new AnimationsBoxController({
			scheduler,
			initialConfig: resolveAnimationsBoxConfig({ cadenceEqualizer: true }),
		});
		controller.mount(ctx);
		const widget = buildWidget(calls[0] as SetWidgetCall);

		controller.onMessageStart(assistantMessageStart({ output: 100, timestamp: 0, duration: 1_000 }), ctx);
		const cadenceRow = widget.renderFrame(69).find(row => row.includes("cadence"));
		expect(cadenceRow).toBeDefined();
		expect(cadenceRow).toContain("100 t/s"); // (100 output tokens * 1000) / 1000ms duration
		widget.dispose();
	});

	it("onMessageUpdate keeps the tracked message's usage current mid-stream", () => {
		const scheduler = manualScheduler();
		const { ctx, calls } = recordingContext();
		const controller = new AnimationsBoxController({
			scheduler,
			initialConfig: resolveAnimationsBoxConfig({ cadenceEqualizer: true }),
		});
		controller.mount(ctx);
		const widget = buildWidget(calls[0] as SetWidgetCall);

		controller.onMessageStart(assistantMessageStart({ output: 10, timestamp: 0, duration: 1_000 }), ctx);
		controller.onMessageUpdate(assistantMessageUpdate({ output: 200, timestamp: 0, duration: 1_000 }), ctx);
		const cadenceRow = widget.renderFrame(69).find(row => row.includes("cadence"));
		expect(cadenceRow).toContain("200 t/s");
		widget.dispose();
	});

	it("a non-assistant message_start (e.g. a user message) never latches hasStreamed", () => {
		const { ctx, calls } = recordingContext();
		const controller = new AnimationsBoxController({
			scheduler: manualScheduler(),
			initialConfig: resolveAnimationsBoxConfig({ cadenceEqualizer: true }),
		});
		controller.mount(ctx);
		const widget = buildWidget(calls[0] as SetWidgetCall);

		controller.onMessageStart(userMessageStart(), ctx);
		const cadenceRow = widget.renderFrame(69).find(row => row.includes("cadence"));
		expect(cadenceRow).toContain("—");
		widget.dispose();
	});

	it("onFrame samples the live rate and steps the EMA bands through the #onTick seam", () => {
		const scheduler = manualScheduler();
		const { ctx, calls } = recordingContext();
		const controller = new AnimationsBoxController({
			scheduler,
			initialConfig: resolveAnimationsBoxConfig({ cadenceEqualizer: true }),
		});
		controller.mount(ctx);
		const widget = buildWidget(calls[0] as SetWidgetCall);

		controller.onMessageStart(assistantMessageStart({ output: 100, timestamp: 0, duration: 1_000 }), ctx);
		const beforeTick = widget.renderFrame(69).find(row => row.includes("cadence"));
		widget.onFrame(0); // simulate one AnimationHost frame tick
		const afterTick = widget.renderFrame(69).find(row => row.includes("cadence"));
		expect(afterTick).not.toBe(beforeTick); // the band-bar glyph/trailing columns moved off zero
		widget.dispose();
	});

	it("onMessageEnd clears the tracked message (rate settles to idle) but never reverts the segment to resting — hasStreamed latches permanently", () => {
		const scheduler = manualScheduler();
		const { ctx, calls } = recordingContext();
		const controller = new AnimationsBoxController({
			scheduler,
			initialConfig: resolveAnimationsBoxConfig({ cadenceEqualizer: true }),
		});
		controller.mount(ctx);
		const widget = buildWidget(calls[0] as SetWidgetCall);

		controller.onMessageStart(assistantMessageStart({ output: 100, timestamp: 0, duration: 1_000 }), ctx);
		controller.onMessageEnd(messageEnd({ input: 100 }), ctx);
		const cadenceRow = widget.renderFrame(69).find(row => row.includes("cadence"));
		expect(cadenceRow).toContain("--"); // idle rate reads "--", not the resting "—"
		expect(cadenceRow).not.toContain("—"); // the enabled-but-idle resting placeholder is gone for good
		widget.dispose();
	});

	it("ignores every event when hasUI is false", () => {
		const scheduler = manualScheduler();
		const { ctx, calls } = recordingContext();
		const controller = new AnimationsBoxController({
			scheduler,
			initialConfig: resolveAnimationsBoxConfig({ cadenceEqualizer: true }),
		});
		controller.mount(ctx);
		const widget = buildWidget(calls[0] as SetWidgetCall);

		controller.onMessageStart(assistantMessageStart({ output: 100, duration: 1_000 }), { hasUI: false });
		expect(widget.renderFrame(69).find(row => row.includes("cadence"))).toContain("—");
		widget.dispose();
	});

	it("respects the enabled gate — a disabled cadenceEqualizer segment never appears, active or resting", () => {
		const scheduler = manualScheduler();
		const { ctx, calls } = recordingContext();
		const controller = new AnimationsBoxController({
			scheduler,
			initialConfig: resolveAnimationsBoxConfig({ cadenceEqualizer: false }),
		});
		controller.mount(ctx);
		controller.onMessageStart(assistantMessageStart({ output: 100, duration: 1_000 }), ctx);

		const widget = buildWidget(calls[0] as SetWidgetCall);
		const rows = widget.renderFrame(69).join("\n");
		expect(rows).not.toContain("cadence");
		widget.dispose();
	});
});

describe("AnimationsBoxController — audit trail state wiring", () => {
	it("the mounted widget starts on the resting row before any tool_result lands", () => {
		const { ctx, calls } = recordingContext();
		const controller = new AnimationsBoxController({
			scheduler: manualScheduler(),
			initialConfig: resolveAnimationsBoxConfig({}),
		});
		controller.mount(ctx);
		const widget = buildWidget(calls[0] as SetWidgetCall);
		const auditRow = widget.renderFrame(69).find(row => row.includes("audit"));
		expect(auditRow).toContain("—");
		widget.dispose();
	});

	it("onToolResult(read) feeds the ledger, flipping the segment to its active row", () => {
		const scheduler = manualScheduler();
		const { ctx, calls } = recordingContext();
		const controller = new AnimationsBoxController({ scheduler, initialConfig: resolveAnimationsBoxConfig({}) });
		controller.mount(ctx);
		const widget = buildWidget(calls[0] as SetWidgetCall);

		controller.onToolResult(readResult("/repo/src/foo.ts"), ctx);
		const auditRow = widget.renderFrame(69).find(row => row.includes("audit"));
		expect(auditRow).toBeDefined();
		expect(auditRow).not.toContain("—     ");
		widget.dispose();
	});

	it("onToolResult(write) feeds the ledger too", () => {
		const scheduler = manualScheduler();
		const { ctx, calls } = recordingContext();
		const controller = new AnimationsBoxController({ scheduler, initialConfig: resolveAnimationsBoxConfig({}) });
		controller.mount(ctx);
		const widget = buildWidget(calls[0] as SetWidgetCall);

		controller.onToolResult(writeResult("/repo/src/foo.ts"), ctx);
		const auditRow = widget.renderFrame(69).find(row => row.includes("audit"));
		expect(auditRow).not.toContain("—     ");
		widget.dispose();
	});

	it("ignores tool_result when hasUI is false", () => {
		const scheduler = manualScheduler();
		const { ctx, calls } = recordingContext();
		const controller = new AnimationsBoxController({ scheduler, initialConfig: resolveAnimationsBoxConfig({}) });
		controller.mount(ctx);
		const widget = buildWidget(calls[0] as SetWidgetCall);

		controller.onToolResult(readResult("/repo/src/foo.ts"), { hasUI: false, cwd: "/repo" });
		const auditRow = widget.renderFrame(69).find(row => row.includes("audit"));
		expect(auditRow).toContain("—");
		widget.dispose();
	});

	it("onSessionCompact / onAutoCompactionEnd run cleanly as Audit Trail's recovery-correlation signal", () => {
		const scheduler = manualScheduler();
		const { ctx, calls } = recordingContext();
		const controller = new AnimationsBoxController({ scheduler, initialConfig: resolveAnimationsBoxConfig({}) });
		controller.mount(ctx);
		controller.onToolResult(readResult("/repo/src/foo.ts"), ctx);
		controller.onSessionCompact(ctx);
		controller.onAutoCompactionEnd(ctx);

		const widget = buildWidget(calls[0] as SetWidgetCall);
		const auditRow = widget.renderFrame(69).find(row => row.includes("audit"));
		expect(auditRow).not.toContain("—     ");
		widget.dispose();
	});

	it("onSessionSwitch resets the ledger to a fresh, empty state without tearing down the mount", () => {
		const scheduler = manualScheduler();
		const { ctx, calls } = recordingContext();
		const controller = new AnimationsBoxController({ scheduler, initialConfig: resolveAnimationsBoxConfig({}) });
		controller.mount(ctx);
		controller.onToolResult(readResult("/repo/src/foo.ts"), ctx);

		const activeWidget = buildWidget(calls[0] as SetWidgetCall);
		const activeAuditRow = activeWidget.renderFrame(69).find(row => row.includes("audit"));
		expect(activeAuditRow).not.toContain("—     ");
		activeWidget.dispose();

		controller.onSessionSwitch(undefined, ctx);
		expect(calls).toHaveLength(1); // the mount itself is untouched

		const afterSwitch = buildWidget(calls[0] as SetWidgetCall);
		const restingAuditRow = afterSwitch.renderFrame(69).find(row => row.includes("audit"));
		expect(restingAuditRow).toContain("—");
		afterSwitch.dispose();
	});
});

describe("AnimationsBoxController — rate-limit tidepool state wiring", () => {
	it("the mounted widget starts on the resting row before any recognized response lands", () => {
		const { ctx, calls } = recordingContext();
		const controller = new AnimationsBoxController({
			scheduler: manualScheduler(),
			initialConfig: resolveAnimationsBoxConfig({}),
		});
		controller.mount(ctx);
		const widget = buildWidget(calls[0] as SetWidgetCall);
		const limitsRow = widget.renderFrame(69).find(row => row.includes("limits"));
		expect(limitsRow).toContain("—");
		widget.dispose();
	});

	it("after_provider_response then an assistant message_start applies the recognized sample, flipping the segment to its active row", () => {
		const scheduler = manualScheduler();
		const { ctx, calls } = recordingContext();
		const controller = new AnimationsBoxController({ scheduler, initialConfig: resolveAnimationsBoxConfig({}) });
		controller.mount(ctx);
		const widget = buildWidget(calls[0] as SetWidgetCall);

		controller.onAfterProviderResponse(afterProviderResponse(anthropicHeaders(100, 78, 0, 12 * 60_000)), ctx);
		controller.onMessageStart(assistantMessageStart({ provider: "anthropic" }), ctx);

		const limitsRow = widget.renderFrame(69).find(row => row.includes("limits"));
		expect(limitsRow).toBeDefined();
		expect(limitsRow).toContain("78%");
		expect(limitsRow).toContain("anthropic");
		expect(limitsRow).toContain("resets 12m");
		widget.dispose();
	});

	it("an unwhitelisted provider's headers never apply — the segment stays resting", () => {
		const scheduler = manualScheduler();
		const { ctx, calls } = recordingContext();
		const controller = new AnimationsBoxController({ scheduler, initialConfig: resolveAnimationsBoxConfig({}) });
		controller.mount(ctx);
		const widget = buildWidget(calls[0] as SetWidgetCall);

		controller.onAfterProviderResponse(afterProviderResponse(anthropicHeaders(100, 78, 0, 12 * 60_000)), ctx);
		controller.onMessageStart(assistantMessageStart({ provider: "openrouter" }), ctx);

		const limitsRow = widget.renderFrame(69).find(row => row.includes("limits"));
		expect(limitsRow).toContain("—");
		widget.dispose();
	});

	it("a non-assistant message_start never consumes the pending header sample", () => {
		const scheduler = manualScheduler();
		const { ctx, calls } = recordingContext();
		const controller = new AnimationsBoxController({ scheduler, initialConfig: resolveAnimationsBoxConfig({}) });
		controller.mount(ctx);
		const widget = buildWidget(calls[0] as SetWidgetCall);

		controller.onAfterProviderResponse(afterProviderResponse(anthropicHeaders(100, 78, 0, 12 * 60_000)), ctx);
		controller.onMessageStart(userMessageStart(), ctx);
		expect(widget.renderFrame(69).find(row => row.includes("limits"))).toContain("—");

		// The sample survives the intervening user message_start and is claimed by the assistant one that follows.
		controller.onMessageStart(assistantMessageStart({ provider: "anthropic" }), ctx);
		expect(widget.renderFrame(69).find(row => row.includes("limits"))).not.toContain("—     ");
		widget.dispose();
	});

	it("ignores after_provider_response and message_start when hasUI is false", () => {
		const scheduler = manualScheduler();
		const { ctx, calls } = recordingContext();
		const controller = new AnimationsBoxController({ scheduler, initialConfig: resolveAnimationsBoxConfig({}) });
		controller.mount(ctx);
		const widget = buildWidget(calls[0] as SetWidgetCall);

		controller.onAfterProviderResponse(afterProviderResponse(anthropicHeaders(100, 78, 0, 12 * 60_000)), {
			hasUI: false,
		});
		controller.onMessageStart(assistantMessageStart({ provider: "anthropic" }), { hasUI: false });
		expect(widget.renderFrame(69).find(row => row.includes("limits"))).toContain("—");
		widget.dispose();
	});

	it("onSessionSwitch resets the pool to a fresh, empty state and drops the pending header buffer, without tearing down the mount", () => {
		const scheduler = manualScheduler();
		const { ctx, calls } = recordingContext();
		const controller = new AnimationsBoxController({ scheduler, initialConfig: resolveAnimationsBoxConfig({}) });
		controller.mount(ctx);
		controller.onAfterProviderResponse(afterProviderResponse(anthropicHeaders(100, 78, 0, 12 * 60_000)), ctx);
		controller.onMessageStart(assistantMessageStart({ provider: "anthropic" }), ctx);

		const activeWidget = buildWidget(calls[0] as SetWidgetCall);
		expect(activeWidget.renderFrame(69).find(row => row.includes("limits"))).not.toContain("—     ");
		activeWidget.dispose();

		controller.onSessionSwitch(undefined, ctx);
		expect(calls).toHaveLength(1); // the mount itself is untouched

		const afterSwitch = buildWidget(calls[0] as SetWidgetCall);
		expect(afterSwitch.renderFrame(69).find(row => row.includes("limits"))).toContain("—");
		afterSwitch.dispose();
	});

	it("keeps the required limits summary visible when its standalone-row setting is disabled", () => {
		const scheduler = manualScheduler();
		const { ctx, calls } = recordingContext();
		const controller = new AnimationsBoxController({
			scheduler,
			initialConfig: resolveAnimationsBoxConfig({ rateLimitTidepool: false }),
		});
		controller.mount(ctx);
		controller.onAfterProviderResponse(afterProviderResponse(anthropicHeaders(100, 78, 0, 12 * 60_000)), ctx);
		controller.onMessageStart(assistantMessageStart({ provider: "anthropic" }), ctx);

		const widget = buildWidget(calls[0] as SetWidgetCall);
		const rows = widget.renderFrame(69).join("\n");
		expect(rows).toContain("limits");
		widget.dispose();
	});
});

describe("AnimationsBoxController — tool constellation state wiring", () => {
	it("the mounted widget starts on the resting row before any tool_call lands", () => {
		const { ctx, calls } = recordingContext();
		const controller = new AnimationsBoxController({
			scheduler: manualScheduler(),
			initialConfig: resolveAnimationsBoxConfig({}),
		});
		controller.mount(ctx);
		const widget = buildWidget(calls[0] as SetWidgetCall);
		const toolsRow = widget.renderFrame(69).find(row => row.includes("tools"));
		expect(toolsRow).toContain("—");
		widget.dispose();
	});

	it("onToolCall fires a star, flipping the segment to its active row", () => {
		const scheduler = manualScheduler();
		const { ctx, calls } = recordingContext();
		const controller = new AnimationsBoxController({ scheduler, initialConfig: resolveAnimationsBoxConfig({}) });
		controller.mount(ctx);
		const widget = buildWidget(calls[0] as SetWidgetCall);

		controller.onToolCall(toolCall("read"), ctx);
		const toolsRow = widget.renderFrame(69).find(row => row.includes("tools"));
		expect(toolsRow).toBeDefined();
		expect(toolsRow).not.toContain("—     ");
		widget.dispose();
	});

	it("ignores tool_call when hasUI is false", () => {
		const scheduler = manualScheduler();
		const { ctx, calls } = recordingContext();
		const controller = new AnimationsBoxController({ scheduler, initialConfig: resolveAnimationsBoxConfig({}) });
		controller.mount(ctx);
		const widget = buildWidget(calls[0] as SetWidgetCall);

		controller.onToolCall(toolCall("read"), { hasUI: false });
		const toolsRow = widget.renderFrame(69).find(row => row.includes("tools"));
		expect(toolsRow).toContain("—");
		widget.dispose();
	});
});

describe("AnimationsBoxController — palimpsest state wiring", () => {
	it("the mounted widget starts on the resting row before any region crosses GLOW_THRESHOLD", () => {
		const { ctx, calls } = recordingContext();
		const controller = new AnimationsBoxController({
			scheduler: manualScheduler(),
			initialConfig: resolveAnimationsBoxConfig({}),
		});
		controller.mount(ctx);
		const widget = buildWidget(calls[0] as SetWidgetCall);
		const filesRow = widget.renderFrame(69).find(row => row.includes("files"));
		expect(filesRow).toContain("—");
		widget.dispose();
	});

	it("a second onToolResult(edit) touch on the same region flips the segment to its active row, and onTurnEnd fades it back out", () => {
		const scheduler = manualScheduler();
		const { ctx, calls } = recordingContext();
		const controller = new AnimationsBoxController({ scheduler, initialConfig: resolveAnimationsBoxConfig({}) });
		controller.mount(ctx);
		const widget = buildWidget(calls[0] as SetWidgetCall);

		controller.onToolResult(editResult("/repo/src/foo.ts"), ctx);
		const oneTouchRow = widget.renderFrame(69).find(row => row.includes("files"));
		expect(oneTouchRow).toContain("—"); // one touch alone doesn't cross GLOW_THRESHOLD

		controller.onToolResult(editResult("/repo/src/foo.ts"), ctx);
		const twoTouchRow = widget.renderFrame(69).find(row => row.includes("files"));
		expect(twoTouchRow).not.toContain("—     ");

		// FADE_AFTER_TURNS turns without a re-touch and the region ages back out.
		for (let turn = 1; turn <= 3; turn++) controller.onTurnEnd(turnEnd(turn), ctx);
		const fadedRow = widget.renderFrame(69).find(row => row.includes("files"));
		expect(fadedRow).toContain("—");
		widget.dispose();
	});

	it("ignores tool_result when hasUI is false", () => {
		const scheduler = manualScheduler();
		const { ctx, calls } = recordingContext();
		const controller = new AnimationsBoxController({ scheduler, initialConfig: resolveAnimationsBoxConfig({}) });
		controller.mount(ctx);
		const widget = buildWidget(calls[0] as SetWidgetCall);

		controller.onToolResult(editResult("/repo/src/foo.ts"), { hasUI: false, cwd: "/repo" });
		controller.onToolResult(editResult("/repo/src/foo.ts"), { hasUI: false, cwd: "/repo" });
		const filesRow = widget.renderFrame(69).find(row => row.includes("files"));
		expect(filesRow).toContain("—");
		widget.dispose();
	});

	it("one edit tool_result feeds both Audit Trail's ledger and Palimpsest's span ledger from the same event", () => {
		const scheduler = manualScheduler();
		const { ctx, calls } = recordingContext();
		const controller = new AnimationsBoxController({ scheduler, initialConfig: resolveAnimationsBoxConfig({}) });
		controller.mount(ctx);
		const widget = buildWidget(calls[0] as SetWidgetCall);

		controller.onToolResult(editResult("/repo/src/foo.ts"), ctx);
		controller.onToolResult(editResult("/repo/src/foo.ts"), ctx);

		const frame = widget.renderFrame(69);
		const auditRow = frame.find(row => row.includes("audit"));
		const filesRow = frame.find(row => row.includes("files"));
		expect(auditRow).not.toContain("—     ");
		expect(filesRow).not.toContain("—     ");
		widget.dispose();
	});
});

describe("AnimationsBoxController — reflection ripple state wiring", () => {
	const SETTLE_MS = Math.max(RIPPLE_DURATION_MS, DIM_DURATION_MS);
	// Pins the RESTING status line specifically: "reflect" fills its 7-col label
	// gutter exactly, then the two-space gap, then the shared idle phrase "—"
	// (IDLE_SPANS — see segments.ts). The active line puts rule names there
	// instead, so this substring only ever matches the resting row. Reflection
	// is an optional animation, so each test enables it explicitly.
	const RESTING_REFLECT_ROW = "reflect  —";

	it("the mounted widget starts on the resting row before any ttsr_triggered event — the COMMON state, not a startup gap", () => {
		const { ctx, calls } = recordingContext();
		const controller = new AnimationsBoxController({
			scheduler: manualScheduler(),
			initialConfig: resolveAnimationsBoxConfig({ reflectionRipple: true }),
		});
		controller.mount(ctx);
		const widget = buildWidget(calls[0] as SetWidgetCall);
		const reflectRow = widget.renderFrame(69).find(row => row.includes("reflect"));
		expect(reflectRow).toContain(RESTING_REFLECT_ROW);
		widget.dispose();
	});

	it("onTtsrTriggered flips the segment active, and settling via the #onTick seam reverts it to resting", () => {
		const scheduler = manualScheduler();
		const { ctx, calls } = recordingContext();
		const controller = new AnimationsBoxController({
			scheduler,
			initialConfig: resolveAnimationsBoxConfig({ reflectionRipple: true }),
		});
		controller.mount(ctx);
		const widget = buildWidget(calls[0] as SetWidgetCall);

		controller.onTtsrTriggered(ttsrTriggered(["ruleA"]), ctx);
		const activeRow = widget.renderFrame(69).find(row => row.includes("reflect"));
		expect(activeRow).toBeDefined();
		expect(activeRow).toContain("ruleA");
		expect(activeRow).not.toContain(RESTING_REFLECT_ROW);

		scheduler.advance(SETTLE_MS);
		widget.onFrame(0); // drives #onTick -> settleIfDone
		const settledRow = widget.renderFrame(69).find(row => row.includes("reflect"));
		expect(settledRow).toContain(RESTING_REFLECT_ROW);
		widget.dispose();
	});

	it("ignores ttsr_triggered when hasUI is false", () => {
		const scheduler = manualScheduler();
		const { ctx, calls } = recordingContext();
		const controller = new AnimationsBoxController({
			scheduler,
			initialConfig: resolveAnimationsBoxConfig({ reflectionRipple: true }),
		});
		controller.mount(ctx);
		const widget = buildWidget(calls[0] as SetWidgetCall);

		controller.onTtsrTriggered(ttsrTriggered(["rule"]), { hasUI: false });
		expect(widget.renderFrame(69).find(row => row.includes("reflect"))).toContain(RESTING_REFLECT_ROW);
		widget.dispose();
	});

	it("respects the enabled gate — a disabled reflectionRipple segment never appears, active or resting", () => {
		const scheduler = manualScheduler();
		const { ctx, calls } = recordingContext();
		const controller = new AnimationsBoxController({
			scheduler,
			initialConfig: resolveAnimationsBoxConfig({ reflectionRipple: false }),
		});
		controller.mount(ctx);
		controller.onTtsrTriggered(ttsrTriggered(["rule"]), ctx);

		const widget = buildWidget(calls[0] as SetWidgetCall);
		const rows = widget.renderFrame(69).join("\n");
		expect(rows).not.toContain("reflect");
		widget.dispose();
	});

	it("MANDATORY acceptance: a ripple triggered before the box widget mounts settles at the correct wall-clock phase, not mount-relative (Plan 017 Decision 4)", () => {
		const scheduler = manualScheduler();
		const { ctx, calls } = recordingContext();
		const controller = new AnimationsBoxController({
			scheduler,
			initialConfig: resolveAnimationsBoxConfig({ reflectionRipple: true }),
		});

		// Trigger BEFORE mount() — onTtsrTriggered only needs ctx.hasUI, not a live
		// mount, and stamps the trigger off the scheduler regardless.
		controller.onTtsrTriggered(ttsrTriggered(["preMount"]), ctx);

		// Advance to just short of settling, THEN mount. If elapsed were wrongly
		// anchored to the mount time instead of the true trigger time, the very
		// next tick below would read elapsed≈0 and stay rippling far longer.
		scheduler.advance(SETTLE_MS - 1);
		controller.mount(ctx);
		const widget = buildWidget(calls[0] as SetWidgetCall);

		widget.onFrame(0); // now = SETTLE_MS - 1: not yet settled
		const stillRippling = widget.renderFrame(69).find(row => row.includes("reflect"));
		expect(stillRippling).toContain("preMount");
		expect(stillRippling).not.toContain(RESTING_REFLECT_ROW);

		scheduler.advance(2);
		widget.onFrame(0); // now = SETTLE_MS + 1: settled, measured off the ORIGINAL trigger time
		const settled = widget.renderFrame(69).find(row => row.includes("reflect"));
		expect(settled).toContain(RESTING_REFLECT_ROW);
		widget.dispose();
	});
});

describe("AnimationsBoxController — grouped Audit Box composition", () => {
	it("renders all required summaries in canonical order even when their standalone settings are false", () => {
		const scheduler = manualScheduler();
		const { ctx, calls } = recordingContext();
		const controller = new AnimationsBoxController({
			scheduler,
			initialConfig: resolveAnimationsBoxConfig({
				cacheMeter: false,
				auditTrailBox: false,
				rateLimitTidepool: false,
				toolConstellation: false,
				palimpsest: false,
			}),
		});
		controller.mount(ctx);
		const widget = buildWidget(calls[0] as SetWidgetCall);

		const frame = widget.renderFrame(69);
		const expectedLabels = ["cache", "audit", "limits", "tools", "files"];
		expect(expectedLabels).toHaveLength(BOX_REQUIRED_SEGMENT_IDS.length);
		expect(frame).toHaveLength(BOX_REQUIRED_SEGMENT_IDS.length + 2);
		for (let i = 0; i < expectedLabels.length; i++) {
			expect(frame[i + 1]).toContain(expectedLabels[i] as string);
		}
		widget.dispose();
	});

	it("renders enabled optional status rows below exactly one separator in deterministic order", () => {
		const scheduler = manualScheduler();
		const { ctx, calls } = recordingContext();
		const controller = new AnimationsBoxController({
			scheduler,
			initialConfig: resolveAnimationsBoxConfig({ cadenceEqualizer: true, reflectionRipple: true }),
		});
		controller.mount(ctx);
		const widget = buildWidget(calls[0] as SetWidgetCall);

		controller.onTtsrTriggered(ttsrTriggered(["rule"]), ctx);
		controller.onMessageStart(assistantMessageStart({ output: 10, duration: 1_000 }), ctx);

		const width = 69;
		const frame = widget.renderFrame(width);
		const expectedLabels = ["cache", "audit", "limits", "tools", "files", "cadence", "reflect"];
		expect(expectedLabels).toHaveLength(BOX_REQUIRED_SEGMENT_IDS.length + BOX_OPTIONAL_STATUS_SEGMENT_IDS.length);
		expect(frame).toHaveLength(expectedLabels.length + 3);
		for (let i = 0; i < BOX_REQUIRED_SEGMENT_IDS.length; i++) {
			expect(frame[i + 1]).toContain(expectedLabels[i] as string);
		}
		expect(frame[BOX_REQUIRED_SEGMENT_IDS.length + 1]).toBe(`│ ${" ".repeat(width - 4)} │`);
		for (let i = 0; i < BOX_OPTIONAL_STATUS_SEGMENT_IDS.length; i++) {
			expect(frame[BOX_REQUIRED_SEGMENT_IDS.length + 2 + i]).toContain(
				expectedLabels[BOX_REQUIRED_SEGMENT_IDS.length + i] as string,
			);
		}
		widget.dispose();
	});

	it("toggles cadence and reflection independently without interleaving either with required rows", () => {
		const { ctx, calls } = recordingContext();
		new AnimationsBoxController({
			scheduler: manualScheduler(),
			initialConfig: resolveAnimationsBoxConfig({ cadenceEqualizer: false, reflectionRipple: true }),
		}).mount(ctx);
		const widget = buildWidget(calls[0] as SetWidgetCall);

		const frame = widget.renderFrame(69);
		expect(frame.join("\n")).not.toContain("cadence");
		expect(frame[BOX_REQUIRED_SEGMENT_IDS.length + 2]).toContain("reflect");
		widget.dispose();
	});
	it("renders a headless probe failure as a sanitized actionable alarm in the shared audit row", async () => {
		const scheduler = manualScheduler();
		const state = new AuditLedgerState();
		let diskContent = "held\n";
		const probeSource: ProbeSource = {
			async inspect(): Promise<ProbeObservation> {
				return { hash: hashContent(diskContent), content: diskContent };
			},
		};
		const service = new AuditTrailService({ scheduler, probeSource, state });
		const { ctx, calls } = recordingContext();
		const controller = new AnimationsBoxController({
			scheduler,
			initialConfig: resolveAnimationsBoxConfig({}),
			auditTrailState: state,
		});
		controller.mount(ctx);
		const widget = buildWidget(calls[0] as SetWidgetCall);

		service.noteRead("/repo/src/a.ts", { hash: hashContent(diskContent), content: diskContent });
		await service.settled();
		diskContent = "changed behind the agent\n";
		await service.probeNow();
		await service.probeNow();

		const auditRow = widget.renderFrame(69).find(row => row.includes("audit"));
		expect(auditRow).toContain("1 changed on disk");
		expect(auditRow).toContain("a.ts");
		expect(auditRow).not.toContain("/repo/");
		widget.dispose();
	});
});

describe("AnimationsBoxController — breathing border wiring (Decision 2)", () => {
	it("the mounted widget starts on the idle envelope (muted, static) before any agent_start", () => {
		const { ctx, calls } = recordingContext();
		const controller = new AnimationsBoxController({
			scheduler: manualScheduler(),
			initialConfig: resolveAnimationsBoxConfig({}),
		});
		controller.mount(ctx);
		const widget = buildWidget(calls[0] as SetWidgetCall, taggedTheme);

		const row = widget.renderFrame(20)[0];
		expect(row).toBe(`${BREATHING_BORDER_COLORS.muted}:╭${"─".repeat(18)}╮`);
		widget.dispose();
	});

	it("onAgentStart flips the border to the active breathing cycle, brightness varying across the phase", () => {
		const scheduler = manualScheduler();
		const { ctx, calls } = recordingContext();
		const controller = new AnimationsBoxController({ scheduler, initialConfig: resolveAnimationsBoxConfig({}) });
		controller.mount(ctx);
		const widget = buildWidget(calls[0] as SetWidgetCall, taggedTheme);

		controller.onAgentStart(agentStart(), ctx);
		const atStart = widget.renderFrame(20)[0]; // elapsed 0: envelope 0, still muted

		scheduler.advance(BASE_BREATH_PERIOD_MS / 2); // mid-cycle: the breath envelope peaks here
		const atMidCycle = widget.renderFrame(20)[0];

		expect(atStart).toContain(`${BREATHING_BORDER_COLORS.muted}:`);
		expect(atMidCycle).toContain(`${BREATHING_BORDER_COLORS.peak}:`);
		expect(atMidCycle).not.toBe(atStart);
		widget.dispose();
	});

	it("onAgentEnd begins the wind-down exhale, and settling via the #onTick seam lands back at the idle envelope", () => {
		const scheduler = manualScheduler();
		const { ctx, calls } = recordingContext();
		const controller = new AnimationsBoxController({ scheduler, initialConfig: resolveAnimationsBoxConfig({}) });
		controller.mount(ctx);
		const widget = buildWidget(calls[0] as SetWidgetCall, taggedTheme);

		controller.onAgentStart(agentStart(), ctx);
		controller.onAgentEnd(agentEnd(), ctx);
		const midExhale = widget.renderFrame(20)[0]; // elapsedSinceEnd 0: exhale envelope starts at peak brightness
		expect(midExhale).toContain(`${BREATHING_BORDER_COLORS.peak}:`);

		scheduler.advance(EXHALE_DURATION_MS);
		widget.onFrame(0); // drives #onTick -> settleIfDone
		const settled = widget.renderFrame(20)[0];
		expect(settled).toContain(`${BREATHING_BORDER_COLORS.muted}:`); // back at the idle envelope, 0
		widget.dispose();
	});

	it("turn_start/turn_end modulate the breath cadence: a fast turn pulls the period down toward MIN_BREATH_PERIOD_MS", () => {
		const scheduler = manualScheduler();
		const { ctx, calls } = recordingContext();
		const controller = new AnimationsBoxController({ scheduler, initialConfig: resolveAnimationsBoxConfig({}) });
		controller.mount(ctx);
		const widget = buildWidget(calls[0] as SetWidgetCall, taggedTheme);

		controller.onAgentStart(agentStart(), ctx);
		controller.onTurnStart(turnStart(0), ctx);
		scheduler.advance(1);
		controller.onTurnEnd(turnEnd(0), ctx); // 1ms turn duration -> the fast MIN_BREATH_PERIOD_MS cadence

		scheduler.advance(MIN_BREATH_PERIOD_MS / 2 - 1); // mid-cycle on the FAST cadence: envelope peaks here
		const row = widget.renderFrame(20)[0];
		expect(row).toContain(`${BREATHING_BORDER_COLORS.peak}:`);
		widget.dispose();
	});

	it("without a modulating turn, the same elapsed time is nowhere near the (slower) base-period peak", () => {
		const scheduler = manualScheduler();
		const { ctx, calls } = recordingContext();
		const controller = new AnimationsBoxController({ scheduler, initialConfig: resolveAnimationsBoxConfig({}) });
		controller.mount(ctx);
		const widget = buildWidget(calls[0] as SetWidgetCall, taggedTheme);

		controller.onAgentStart(agentStart(), ctx); // no turn_start/turn_end -> stays at BASE_BREATH_PERIOD_MS
		scheduler.advance(MIN_BREATH_PERIOD_MS / 2 - 1);
		const row = widget.renderFrame(20)[0];
		expect(row).not.toContain(`${BREATHING_BORDER_COLORS.peak}:`);
		widget.dispose();
	});

	it("threads the controller's accentColor option through to the border's peak brightness only", () => {
		const scheduler = manualScheduler();
		const { ctx, calls } = recordingContext();
		const controller = new AnimationsBoxController({
			scheduler,
			initialConfig: resolveAnimationsBoxConfig({}),
			accentColor: "success",
		});
		controller.mount(ctx);
		const widget = buildWidget(calls[0] as SetWidgetCall, taggedTheme);

		controller.onAgentStart(agentStart(), ctx);
		scheduler.advance(BASE_BREATH_PERIOD_MS / 2); // mid-cycle: the breath envelope peaks here
		const row = widget.renderFrame(20)[0];
		expect(row).toContain("success:");
		expect(row).not.toContain(`${BREATHING_BORDER_COLORS.peak}:`);
		widget.dispose();
	});

	it("breathingBorder disabled in config renders the plain, uncolored chrome even while the agent is actively breathing", () => {
		const scheduler = manualScheduler();
		const { ctx, calls } = recordingContext();
		const controller = new AnimationsBoxController({
			scheduler,
			initialConfig: resolveAnimationsBoxConfig({ breathingBorder: false }),
		});
		controller.mount(ctx);
		const widget = buildWidget(calls[0] as SetWidgetCall, taggedTheme);

		controller.onAgentStart(agentStart(), ctx);
		scheduler.advance(BASE_BREATH_PERIOD_MS / 2); // would-be peak, if enabled
		const row = widget.renderFrame(20)[0];
		expect(row).toBe(`╭${"─".repeat(18)}╮`); // plain — no theme.fg call at all, exactly the pre-dxi.5 chrome
		widget.dispose();
	});

	it("ignores agent_start/agent_end/turn_start/turn_end when hasUI is false", () => {
		const scheduler = manualScheduler();
		const { ctx, calls } = recordingContext();
		const controller = new AnimationsBoxController({ scheduler, initialConfig: resolveAnimationsBoxConfig({}) });
		controller.mount(ctx);
		const widget = buildWidget(calls[0] as SetWidgetCall, taggedTheme);

		controller.onAgentStart(agentStart(), { hasUI: false });
		controller.onTurnStart(turnStart(0), { hasUI: false });
		controller.onTurnEnd(turnEnd(0), { hasUI: false });
		controller.onAgentEnd(agentEnd(), { hasUI: false });
		scheduler.advance(BASE_BREATH_PERIOD_MS / 2);

		const row = widget.renderFrame(20)[0];
		expect(row).toBe(`${BREATHING_BORDER_COLORS.muted}:╭${"─".repeat(18)}╮`); // still idle
		widget.dispose();
	});
});
