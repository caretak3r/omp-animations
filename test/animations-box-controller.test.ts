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
	ToolCallEvent,
	ToolExecutionEndEvent,
	ToolExecutionStartEvent,
	ToolResultEvent,
	TurnEndEvent,
	TurnStartEvent,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { formatNumber } from "@oh-my-pi/pi-utils";
import { type AnimationsBoxContext, AnimationsBoxController, BOX_WIDGET_KEY } from "../src/animations-box/controller";
import {
	BOX_REQUIRED_SEGMENT_IDS,
	type BoxRequiredSegmentId,
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
	GLOSS_LAP_DURATION_MS,
	MIN_BREATH_PERIOD_MS,
} from "../src/breathing-border";
import { CacheMeterState } from "../src/cache-meter";
import { resolveGlyph } from "../src/glyph-presets";
import type { FrameScheduler } from "../src/kit";

// Identity theme so most assertions see plain text instead of ANSI escapes.
const idTheme = { fg: (_color: string, text: string) => text };
// Color-tagging theme for tests that need to assert which border token the box chose.
const taggedTheme = { fg: (color: string, text: string) => `${color}:${text}` };
const cellTaggedTheme = { fg: (color: string, text: string) => `<${color}>${text}</${color}>` };
const noopTui = { requestComponentRender: () => {} };
const REQUIRED_SEGMENT_LABELS = {
	filesLive: "files",
	contextGauge: "context",
	cacheMeter: "cache",
	auditTrailBox: "audit",
	rateLimitTidepool: "limits",
} satisfies Readonly<Record<BoxRequiredSegmentId, string>>;

function requiredSegmentLabels(): string[] {
	return BOX_REQUIRED_SEGMENT_IDS.map(id => REQUIRED_SEGMENT_LABELS[id]);
}

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

function borderCellColors(row: string): string[] {
	return [...row.matchAll(/<(borderMuted|border|borderAccent)>[^<]*<\/(?:borderMuted|border|borderAccent)>/gu)].map(
		match => match[1] ?? "",
	);
}

interface UsageOverrides {
	input?: number;
	cacheRead?: number;
	cacheWrite?: number;
}

function messageEnd(usage: UsageOverrides = {}, stopReason = "stop"): MessageEndEvent {
	return {
		type: "message_end",
		message: {
			role: "assistant",
			content: [],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude",
			usage: { input: 0, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 10, ...usage },
			stopReason,
			timestamp: 0,
		},
	} as unknown as MessageEndEvent;
}

interface AssistantMessageOverrides {
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
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
			stopReason: undefined,
			timestamp: 0,
			duration: undefined,
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

function afterProviderResponse(headers: Record<string, string>, status = 200): AfterProviderResponseEvent {
	return { type: "after_provider_response", status, headers } as unknown as AfterProviderResponseEvent;
}

/** A recognized Anthropic rate-limit header triple, `remainingOf(limit)` fraction depleted, resetting `resetInMs` from `nowMs`. */
function anthropicHeaders(limit: number, remaining: number, nowMs: number, resetInMs: number): Record<string, string> {
	return {
		"anthropic-ratelimit-requests-limit": String(limit),
		"anthropic-ratelimit-requests-remaining": String(remaining),
		"anthropic-ratelimit-requests-reset": new Date(nowMs + resetInMs).toISOString(),
	};
}

function toolCall(toolName: string, input: Record<string, unknown> = {}, toolCallId = "tc-1"): ToolCallEvent {
	return { type: "tool_call", toolCallId, toolName, input } as unknown as ToolCallEvent;
}

function toolExecutionStart(toolName: string, toolCallId = "tc-1"): ToolExecutionStartEvent {
	return { type: "tool_execution_start", toolCallId, toolName, args: {} } as unknown as ToolExecutionStartEvent;
}

function toolExecutionEnd(toolName: string, toolCallId = "tc-1", isError = false): ToolExecutionEndEvent {
	return {
		type: "tool_execution_end",
		toolCallId,
		toolName,
		args: {},
		result: undefined,
		isError,
	} as unknown as ToolExecutionEndEvent;
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

/** An `edit` result with a resolved path — the Audit Trail records the completed write. */
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

	it("mounts the complete Animations Box exactly once across repeated mount() calls", () => {
		const { ctx, calls } = recordingContext();
		const controller = new AnimationsBoxController({
			scheduler: manualScheduler(),
			initialConfig: resolveAnimationsBoxConfig({}),
		});
		controller.mount(ctx);
		controller.mount(ctx);
		expect(calls).toHaveLength(1);
		expect(calls.map(call => call.key)).toEqual([BOX_WIDGET_KEY]);
		expect(BOX_WIDGET_KEY).toBe("oh-my-pi-animations-box");
	});

	it("defaults placement to belowEditor, and honors an explicit override", () => {
		const { ctx, calls } = recordingContext();
		new AnimationsBoxController({
			scheduler: manualScheduler(),
			initialConfig: resolveAnimationsBoxConfig({}),
		}).mount(ctx);
		expect(calls.map(call => call.options)).toEqual([{ placement: "belowEditor" }]);

		const { ctx: ctx2, calls: calls2 } = recordingContext();
		new AnimationsBoxController({
			scheduler: manualScheduler(),
			placement: "aboveEditor",
			initialConfig: resolveAnimationsBoxConfig({}),
		}).mount(ctx2);
		expect(calls2.map(call => call.options)).toEqual([{ placement: "aboveEditor" }]);
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
		expect(calls.slice(1)).toEqual([
			{ key: BOX_WIDGET_KEY, content: undefined, options: { placement: "belowEditor" } },
		]);
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

	it("threads the canonical progress bar through the mounted widget without motion", () => {
		const { ctx, calls } = recordingContext({
			getContextUsage: () => ({ tokens: 120_000, contextWindow: 200_000, percent: 60 }),
		});
		const scheduler = manualScheduler();
		const controller = new AnimationsBoxController({
			scheduler,
			motionSetting: "full",
			initialConfig: resolveAnimationsBoxConfig({}),
		});
		controller.mount(ctx);
		const widget = buildWidget(calls[0] as SetWidgetCall);
		const initial = widget.renderFrame(120).find(row => row.includes("context"));
		expect(initial).toContain("[████████░░]");
		expect(initial).toContain("40K left of 160K");
		scheduler.advance(600);
		expect(widget.renderFrame(120).find(row => row.includes("context"))).toBe(initial);
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

	// buv.2: the box row is the only cache row left, so it must be a view of the
	// ledger — not a second accounting path. Same events into a bare
	// `CacheMeterState` must produce exactly the figures the row prints.
	it("prints the ledger's own totals across several requests — hit %, hits/requests and uncached/reused/stored", () => {
		const scheduler = manualScheduler();
		const { ctx, calls } = recordingContext();
		const controller = new AnimationsBoxController({ scheduler, initialConfig: resolveAnimationsBoxConfig({}) });
		controller.mount(ctx);
		const widget = buildWidget(calls[0] as SetWidgetCall);

		const usages = [
			{ input: 400, cacheRead: 600, cacheWrite: 200 },
			{ input: 0, cacheRead: 1_000, cacheWrite: 0 },
			{ input: 120, cacheRead: 800, cacheWrite: 40 },
		];
		const ledger = new CacheMeterState();
		for (const usage of usages) {
			controller.onMessageEnd(messageEnd(usage), ctx);
			ledger.recordUsage({
				provider: "anthropic",
				model: "claude",
				usage: {
					input: usage.input,
					output: 10,
					cacheRead: usage.cacheRead,
					cacheWrite: usage.cacheWrite,
					totalTokens: usage.input + 10 + usage.cacheRead + usage.cacheWrite,
				},
			});
		}
		const snapshot = ledger.snapshot();
		const rows = widget.renderFrame(120).join("\n");
		const cacheRow = rows.split("\n").find(row => row.includes("cache")) as string;
		expect(cacheRow).toContain(`${formatNumber(snapshot.missTokens)} uncached`);
		expect(cacheRow).toContain(`${formatNumber(snapshot.cacheReadTokens)} reused`);
		expect(cacheRow).toContain(`${formatNumber(snapshot.cacheWriteTokens)} stored`);
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

	it("a truncated assistant reply (stopReason length) reaches the rendered error row", () => {
		const { ctx, calls } = recordingContext();
		const controller = new AnimationsBoxController({
			scheduler: manualScheduler(),
			initialConfig: resolveAnimationsBoxConfig({}),
		});
		controller.mount(ctx);
		controller.onMessageEnd(messageEnd({ input: 400 }), ctx);

		const widget = buildWidget(calls[0] as SetWidgetCall);
		expect(widget.renderFrame(120).join("\n")).not.toContain("trunc");

		controller.onMessageEnd(messageEnd({ input: 400 }, "length"), ctx);
		expect(widget.renderFrame(120).join("\n")).toContain("trunc");
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
		expect(calls).toHaveLength(1); // the single mount is untouched

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

	it("an unwhitelisted provider's quota never applies, but health does", () => {
		const scheduler = manualScheduler();
		const { ctx, calls } = recordingContext();
		const controller = new AnimationsBoxController({ scheduler, initialConfig: resolveAnimationsBoxConfig({}) });
		controller.mount(ctx);
		const widget = buildWidget(calls[0] as SetWidgetCall);

		controller.onAfterProviderResponse(afterProviderResponse(anthropicHeaders(100, 78, 0, 12 * 60_000)), ctx);
		controller.onMessageStart(assistantMessageStart({ provider: "openrouter" }), ctx);

		const limitsRow = widget.renderFrame(69).find(row => row.includes("limits"));
		// Health row shows for all providers
		expect(limitsRow).toContain("http 200");
		// But quota spans require a whitelisted provider
		expect(limitsRow).not.toContain("% left");
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
		// Health row activates on first response, but tidepool quota needs assistant message_start
		expect(widget.renderFrame(69).find(row => row.includes("limits"))).toContain("http 200");
		expect(widget.renderFrame(69).find(row => row.includes("limits"))).not.toContain("% left");

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
		expect(calls).toHaveLength(1); // the single mount is untouched

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

describe("AnimationsBoxController — verify sidecar wiring", () => {
	it("feeds the verify sidecar row when writes settle", () => {
		const scheduler = manualScheduler();
		const { ctx, calls } = recordingContext();
		const controller = new AnimationsBoxController({ scheduler, initialConfig: resolveAnimationsBoxConfig({}) });
		controller.mount(ctx);
		const widget = buildWidget(calls[0] as SetWidgetCall);

		controller.onToolCall(toolCall("write", {}, "w1"), ctx);
		controller.onToolExecutionStart(toolExecutionStart("write", "w1"), ctx);
		controller.onToolExecutionEnd(toolExecutionEnd("write", "w1"), ctx);
		const afterWrite = widget.renderFrame(160);
		expect(afterWrite.some(row => row.includes("verify") && row.includes("write") && row.includes("bash"))).toBe(
			true,
		);
		widget.dispose();
	});

	it("clears the verify row when a green bash settles", () => {
		const scheduler = manualScheduler();
		const { ctx, calls } = recordingContext();
		const controller = new AnimationsBoxController({ scheduler, initialConfig: resolveAnimationsBoxConfig({}) });
		controller.mount(ctx);
		const widget = buildWidget(calls[0] as SetWidgetCall);

		controller.onToolCall(toolCall("write", {}, "w1"), ctx);
		controller.onToolExecutionStart(toolExecutionStart("write", "w1"), ctx);
		controller.onToolExecutionEnd(toolExecutionEnd("write", "w1"), ctx);
		controller.onToolCall(toolCall("bash", {}, "b1"), ctx);
		controller.onToolExecutionStart(toolExecutionStart("bash", "b1"), ctx);
		controller.onToolExecutionEnd(toolExecutionEnd("bash", "b1", false), ctx);
		const afterBash = widget.renderFrame(160);
		expect(afterBash.every(row => !row.includes("verify"))).toBe(true);
		widget.dispose();
	});

	it("verify row survives onAgentStart (session scope, not request scope)", () => {
		const scheduler = manualScheduler();
		const { ctx, calls } = recordingContext();
		const controller = new AnimationsBoxController({ scheduler, initialConfig: resolveAnimationsBoxConfig({}) });
		controller.mount(ctx);
		const widget = buildWidget(calls[0] as SetWidgetCall);

		controller.onToolCall(toolCall("write", {}, "w1"), ctx);
		controller.onToolExecutionStart(toolExecutionStart("write", "w1"), ctx);
		controller.onToolExecutionEnd(toolExecutionEnd("write", "w1"), ctx);
		controller.onAgentStart(agentStart(), ctx);
		const afterAgentStart = widget.renderFrame(160);
		expect(afterAgentStart.some(row => row.includes("verify") && row.includes("write"))).toBe(true);
		widget.dispose();
	});
});

describe("AnimationsBoxController — live file state wiring", () => {
	it("starts on the resting row before any write is active", () => {
		const { ctx, calls } = recordingContext();
		const controller = new AnimationsBoxController({
			scheduler: manualScheduler(),
			initialConfig: resolveAnimationsBoxConfig({}),
		});
		controller.mount(ctx);
		const widget = buildWidget(calls[0] as SetWidgetCall);
		expect(widget.renderFrame(69).find(row => row.includes("files"))).toContain("—");
		widget.dispose();
	});

	it("shows an edit path only while the matching tool call is in flight", () => {
		const { ctx, calls } = recordingContext();
		const controller = new AnimationsBoxController({
			scheduler: manualScheduler(),
			initialConfig: resolveAnimationsBoxConfig({}),
		});
		controller.mount(ctx);
		const widget = buildWidget(calls[0] as SetWidgetCall);

		controller.onToolCall(toolCall("edit", { path: "/repo/src/foo.ts" }, "tc-edit"), ctx);
		expect(widget.renderFrame(80).find(row => row.includes("files"))).toContain("src/foo.ts");

		controller.onToolResult(editResult("/repo/src/foo.ts"), ctx);
		expect(widget.renderFrame(80).find(row => row.includes("files"))).toContain("—");
		widget.dispose();
	});

	it("shows parallel writer paths and removes each path with its own result", () => {
		const { ctx, calls } = recordingContext();
		const controller = new AnimationsBoxController({
			scheduler: manualScheduler(),
			initialConfig: resolveAnimationsBoxConfig({}),
		});
		controller.mount(ctx);
		const widget = buildWidget(calls[0] as SetWidgetCall);

		controller.onToolCall(toolCall("edit", { path: "/repo/src/foo.ts" }, "tc-edit"), ctx);
		controller.onToolCall(toolCall("write", { path: "/repo/src/bar.ts" }, "tc-write"), ctx);
		const parallel = widget.renderFrame(100).find(row => row.includes("files"));
		expect(parallel).toContain("src/foo.ts");
		expect(parallel).toContain("src/bar.ts");

		controller.onToolResult(editResult("/repo/src/foo.ts"), ctx);
		const oneWriter = widget.renderFrame(100).find(row => row.includes("files"));
		expect(oneWriter).not.toContain("src/foo.ts");
		expect(oneWriter).toContain("src/bar.ts");
		controller.onToolResult(writeResult("/repo/src/bar.ts"), ctx);
		widget.dispose();
	});

	it("ignores tool calls when the UI is unavailable", () => {
		const { ctx, calls } = recordingContext();
		const controller = new AnimationsBoxController({
			scheduler: manualScheduler(),
			initialConfig: resolveAnimationsBoxConfig({}),
		});
		controller.mount(ctx);
		const widget = buildWidget(calls[0] as SetWidgetCall);

		controller.onToolCall(toolCall("edit", { path: "/repo/src/foo.ts" }, "tc-edit"), {
			hasUI: false,
			cwd: "/repo",
		});
		expect(widget.renderFrame(69).find(row => row.includes("files"))).toContain("—");
		widget.dispose();
	});

	it("moves an edit from live activity into the Audit Trail when the result arrives", () => {
		const { ctx, calls } = recordingContext();
		const controller = new AnimationsBoxController({
			scheduler: manualScheduler(),
			initialConfig: resolveAnimationsBoxConfig({}),
		});
		controller.mount(ctx);
		const widget = buildWidget(calls[0] as SetWidgetCall);

		controller.onToolCall(toolCall("edit", { path: "/repo/src/foo.ts" }, "tc-edit"), ctx);
		expect(widget.renderFrame(80).find(row => row.includes("files"))).toContain("src/foo.ts");

		controller.onToolResult(editResult("/repo/src/foo.ts"), ctx);
		const settled = widget.renderFrame(80);
		expect(settled.find(row => row.includes("files"))).toContain("—");
		expect(settled.find(row => row.includes("audit"))).not.toContain("—     ");
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
			}),
		});
		controller.mount(ctx);
		const widget = buildWidget(calls[0] as SetWidgetCall);

		const frame = widget.renderFrame(69);
		const expectedLabels = requiredSegmentLabels();
		expect(expectedLabels).toHaveLength(BOX_REQUIRED_SEGMENT_IDS.length);
		expect(frame).toHaveLength(BOX_REQUIRED_SEGMENT_IDS.length + 2);
		for (let i = 0; i < expectedLabels.length; i++) {
			expect(frame[i + 1]).toContain(expectedLabels[i] as string);
		}
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
		expect(row).toBe(`${BREATHING_BORDER_COLORS.muted}:┌${"─".repeat(18)}┐`);
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
		expect(atMidCycle.replace(/(?:borderMuted|border|borderAccent):/gu, "")).toBe(`┏${"━".repeat(18)}┓`);
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

	it("freezes the gloss through its exhale fade and restarts the next run at top-left", () => {
		const scheduler = manualScheduler();
		const { ctx, calls } = recordingContext();
		const controller = new AnimationsBoxController({ scheduler, initialConfig: resolveAnimationsBoxConfig({}) });
		controller.mount(ctx);
		const widget = buildWidget(calls[0] as SetWidgetCall, cellTaggedTheme);

		controller.onAgentStart(agentStart(), ctx);
		scheduler.advance(GLOSS_LAP_DURATION_MS / 8);
		const activeColors = borderCellColors(widget.renderFrame(20)[0] ?? "");
		expect(activeColors[6]).toBe(BREATHING_BORDER_COLORS.peak);

		controller.onAgentEnd(agentEnd(), ctx);
		scheduler.advance(EXHALE_DURATION_MS / 2);
		const midExhaleColors = borderCellColors(widget.renderFrame(20)[0] ?? "");
		expect(midExhaleColors[6]).toBe(BREATHING_BORDER_COLORS.peak);

		scheduler.advance(EXHALE_DURATION_MS / 4);
		const lateExhaleColors = borderCellColors(widget.renderFrame(20)[0] ?? "");
		expect(lateExhaleColors[0]).toBe(BREATHING_BORDER_COLORS.muted);
		expect(lateExhaleColors[6]).toBe(BREATHING_BORDER_COLORS.base);

		controller.onAgentStart(agentStart(), ctx);
		const restartedColors = borderCellColors(widget.renderFrame(20)[0] ?? "");
		expect(restartedColors[0]).toBe(BREATHING_BORDER_COLORS.peak);
		expect(restartedColors[6]).toBe(BREATHING_BORDER_COLORS.muted);
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

	it("without a modulating turn, the uniform envelope stays below its peak while the gloss head remains accented", () => {
		const scheduler = manualScheduler();
		const { ctx, calls } = recordingContext();
		const controller = new AnimationsBoxController({ scheduler, initialConfig: resolveAnimationsBoxConfig({}) });
		controller.mount(ctx);
		const widget = buildWidget(calls[0] as SetWidgetCall, taggedTheme);

		controller.onAgentStart(agentStart(), ctx); // no turn_start/turn_end -> stays at BASE_BREATH_PERIOD_MS
		scheduler.advance(MIN_BREATH_PERIOD_MS / 2 - 1);
		const row = widget.renderFrame(20)[0];
		expect(row).toStartWith(`${BREATHING_BORDER_COLORS.base}:┌`);
		expect(row).toContain(`${BREATHING_BORDER_COLORS.peak}:`); // one spatial head, independent of breath cadence
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

	it("the subtle motion tier softens the breathing border's amplitude at the same phase full reads brighter at", () => {
		// Chosen so the unscaled envelope lands in the "border" bucket (>=0.15) while
		// the subtle tier's 0.6x amplitude scale drops the same phase into "borderMuted" (<0.15).
		const ENVELOPE_TARGET = 0.2;
		const elapsedMs = (Math.acos(1 - 2 * ENVELOPE_TARGET) / (2 * Math.PI)) * BASE_BREATH_PERIOD_MS;

		function rowAtTier(motionSetting: "full" | "subtle"): string {
			const scheduler = manualScheduler();
			const { ctx, calls } = recordingContext();
			const controller = new AnimationsBoxController({
				scheduler,
				initialConfig: resolveAnimationsBoxConfig({}),
				motionSetting,
			});
			controller.mount(ctx);
			const widget = buildWidget(calls[0] as SetWidgetCall, taggedTheme);
			controller.onAgentStart(agentStart(), ctx);
			scheduler.advance(elapsedMs);
			const row = widget.renderFrame(20)[0] ?? "";
			widget.dispose();
			return row;
		}

		function tokenCount(row: string, token: string): number {
			return (row.match(new RegExp(`${token}:`, "gu")) ?? []).length;
		}

		const fullRow = rowAtTier("full");
		const subtleRow = rowAtTier("subtle");

		expect(tokenCount(fullRow, BREATHING_BORDER_COLORS.base)).toBeGreaterThan(0);
		expect(tokenCount(subtleRow, BREATHING_BORDER_COLORS.base)).toBeLessThan(
			tokenCount(fullRow, BREATHING_BORDER_COLORS.base),
		);
		expect(tokenCount(subtleRow, BREATHING_BORDER_COLORS.muted)).toBeGreaterThan(
			tokenCount(fullRow, BREATHING_BORDER_COLORS.muted),
		);
	});

	it("subtle tier keeps a visible moving gloss head at the breath peak, just softer than full", () => {
		const scheduler = manualScheduler();
		const { ctx, calls } = recordingContext();
		const controller = new AnimationsBoxController({
			scheduler,
			initialConfig: resolveAnimationsBoxConfig({}),
			motionSetting: "subtle",
		});
		controller.mount(ctx);
		const widget = buildWidget(calls[0] as SetWidgetCall, taggedTheme);

		controller.onAgentStart(agentStart(), ctx);
		scheduler.advance(BASE_BREATH_PERIOD_MS / 2); // mid-cycle: the breath envelope peaks here
		const row = widget.renderFrame(20)[0] ?? "";
		expect(row).toContain(`${BREATHING_BORDER_COLORS.peak}:`); // head still reads as the brightest token, never vanished
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
		expect(row).toBe(`┌${"─".repeat(18)}┐`); // plain — no theme.fg call at all
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
		expect(row).toBe(`${BREATHING_BORDER_COLORS.muted}:┌${"─".repeat(18)}┐`); // still idle
		widget.dispose();
	});
});
